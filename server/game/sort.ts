// POST /api/sort: score the player's own library for a custom sort ("Sort by anything").
// Names come from the DB (owned, active elements only), never from the client, so the endpoint
// can't be used as a free scoring proxy; the player's text reaches the model only as a JSON data
// field. Request counts are charged up front (concurrently with the session lookup) and the
// library is read only once they pass; the item limits and the global Jev budget are charged once
// the cost (questions) is known. No refund when the provider fails afterwards, the same as
// invent() in combine.ts.
import type { Context } from "@netlify/functions";
import { SORT_MAX_ELEMENTS, type SortResponse, type SortSpec } from "../../src/shared/api.ts";
import { questionsPer } from "../../src/shared/sortSpec.ts";
import { AiUnavailable, scoreElements, sortEngineId, type ScoreItem, type ScoreOutcome } from "../ai/index.ts";
import { q, t } from "../db.ts";
import { BODY_LIMIT_SORT, checkCsrf, clientIp, errors, ipHash, json, readJson } from "../http.ts";
import { BUDGETS, LIMITS, enforce, hit, isBudget } from "../ratelimit.ts";
import { playerForClaims, sessionClaims } from "../session.ts";
import { SortSchema } from "./sortSpec.ts";

/** Whole run, retries included: under the client's 30 s timeout and Netlify's 60 s limit. */
const SORT_DEADLINE_MS = 20_000;

export async function sortLibrary(req: Request, context: Context): Promise<Response> {
  checkCsrf(req);
  const body = await readJson(req, SortSchema, BODY_LIMIT_SORT);
  const claims = sessionClaims(req);
  if (!claims) throw errors.unauthorized();
  const ip = ipHash(clientIp(req, context));
  const [player] = await Promise.all([
    playerForClaims(claims),
    enforce([
      { limit: LIMITS.sortPlayer, subject: claims.p },
      { limit: LIMITS.sortPlayerHour, subject: claims.p },
      { limit: LIMITS.sortIpHour, subject: ip },
    ]),
  ]);
  if (!player) throw errors.unauthorized();
  // Only now: the whole-library read scans every discovery the player has (no index on
  // discovered_at), and /api/sort has no platform rule, so a rejected or revoked request must not
  // start it. Costs one counter round trip on a request that takes seconds.
  const rows = await scorable(player.id, body.ids);

  const truncated = !body.ids && rows.length > SORT_MAX_ELEMENTS;
  const items = truncated ? rows.slice(0, SORT_MAX_ELEMENTS) : rows;
  if (items.length === 0) {
    return json({ engine: sortEngineId(), ids: [], s: [], retry: [] } satisfies SortResponse); // nothing to charge
  }

  const cost = items.length * questionsPer(body.spec);
  const r = await hit([
    { limit: LIMITS.sortItemsPlayerHour, subject: player.id, cost },
    { limit: LIMITS.sortItemsPlayerDay, subject: player.id, cost },
    { limit: LIMITS.sortItemsIpHour, subject: ip, cost },
    { limit: LIMITS.sortItemsIpDay, subject: ip, cost },
    { limit: BUDGETS.jev, subject: "all", cost }, // hit() charges it only after the four above pass
  ]);
  if (!r.ok) throw isBudget(r.limit) ? errors.sortBudget(r.retryAfterMs) : errors.rateLimited(r.retryAfterMs);

  try {
    const out = await scoreElements(body.spec, items, { deadlineMs: SORT_DEADLINE_MS, retries: 1, split: true });
    return json(toResponse(body.spec, out, items, truncated));
  } catch (e) {
    if (e instanceof AiUnavailable) throw errors.aiUnavailable();
    throw e;
  }
}

/**
 * The player's owned, active elements: the requested ones (unowned or inactive ids are dropped
 * silently: a stale tab or a purge must not fail the sort), or the whole library newest first,
 * one row past SORT_MAX_ELEMENTS so the caller can tell it was cut.
 */
export async function scorable(playerId: string, ids?: readonly string[]): Promise<ScoreItem[]> {
  const rows = ids
    ? await q<{ id: string; name: string }>(
        `SELECT e.id, e.name
           FROM ${t("discoveries")} d
           JOIN ${t("elements")} e ON e.id = d.element_id
          WHERE d.player_id = $1 AND d.element_id = ANY($2::INT8[]) AND e.status = 'active'`,
        [playerId, [...new Set(ids)]],
      )
    : await q<{ id: string; name: string }>(
        `SELECT e.id, e.name
           FROM ${t("discoveries")} d
           JOIN ${t("elements")} e ON e.id = d.element_id
          WHERE d.player_id = $1 AND e.status = 'active'
          ORDER BY d.discovered_at DESC, e.id
          LIMIT $2`,
        [playerId, SORT_MAX_ELEMENTS + 1],
      );
  // INT8 ids stay strings (they exceed 2^53): never Number() them.
  return rows.map((r) => ({ id: String(r.id), name: r.name }));
}

const permille = (v: unknown): number | null =>
  typeof v === "number" && Number.isFinite(v) ? Math.min(1000, Math.max(0, Math.round(v))) : null;

/**
 * Parallel arrays in load order. Every loaded id lands in `ids` or in `retry` (a requested id in
 * neither is not owned/active, and the client never asks for it again).
 */
export function toResponse(spec: SortSpec, out: ScoreOutcome, items: readonly ScoreItem[], truncated: boolean): SortResponse {
  const groups = spec.kind === "groups" ? spec.groups.length : 0;
  const res: SortResponse = { engine: out.engine, ids: [], s: [], retry: [] };
  const g: number[] = [];
  const n: number[] = [];
  for (const { id } of items) {
    const sc = out.scored.get(id);
    const s = permille(sc?.s);
    const gi = sc?.g;
    const fit = permille(sc?.n);
    const groupOk = !groups || (Number.isInteger(gi) && gi! >= 0 && gi! < groups && fit != null);
    if (s == null || !groupOk) {
      res.retry.push(id);
      continue;
    }
    res.ids.push(id);
    res.s.push(s);
    if (groups) {
      g.push(gi!);
      n.push(fit!);
    }
  }
  if (groups) Object.assign(res, { g, n });
  if (truncated) res.truncated = true;
  return res;
}
