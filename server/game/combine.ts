// POST /api/combine: ownership-checked combination. Known recipes answer from the DB;
// unknown ones (or legacy recipes whose result was quarantined) ask the LLM, then store
// the element + recipe + discovery atomically. With an active custom sort, a new discovery is
// also scored for it (best-effort, capped at SORT_PIGGYBACK_MS) so the client needs no extra call.
import type { Context } from "@netlify/functions";
import type pg from "pg";
import { z } from "zod";
import {
  MAX_INGREDIENTS,
  MIN_INGREDIENTS,
  type CombineResponse,
  type SortScore,
  type SortSpec,
} from "../../src/shared/api.ts";
import { questionsPer } from "../../src/shared/sortSpec.ts";
import { q, q1, t, withTx, type Queryable } from "../db.ts";
import {
  AiUnavailable,
  Fizzled,
  proposeElement,
  scoreElements,
  type AvoidResult,
  type ElementProposal,
} from "../ai/index.ts";
import { safetyId } from "../crypto.ts";
import { BODY_LIMIT_DEFAULT, checkCsrf, clientIp, errors, ipHash, json, readJson } from "../http.ts";
import { BUDGETS, LIMITS, enforce, hit } from "../ratelimit.ts";
import { playerForClaims, sessionClaims } from "../session.ts";
import { completeTiers, resolveDay } from "./challenges.ts";
import { ELEMENT_COLS, isElementId, sortIds, toElementDTO, type ElementRow } from "./dto.ts";
import { countActivity } from "./players.ts";
import { SortSpecSchema } from "./sortSpec.ts";

export const CombineSchema = z.object({
  ids: z.array(z.string().refine(isElementId, "invalid element id")).min(MIN_INGREDIENTS).max(MAX_INGREDIENTS),
  clientDate: z.string().max(32),
  // An invalid spec is dropped rather than rejected: a combine must never fail because of sorting.
  sort: SortSpecSchema.optional().catch(undefined),
});

/** Most a combine waits for its custom-sort score; past it the client asks /api/sort instead. */
const SORT_PIGGYBACK_MS = 800;

/**
 * Score one new discovery for the player's active custom sort, or undefined (budget exhausted,
 * provider error, too slow). Never throws and never takes longer than SORT_PIGGYBACK_MS, even
 * with a scorer that ignores its deadline (the mock's "mock slow" hook) or a slow counter write.
 * Charges only BUDGETS.jev: the combine limits already cap how often this runs.
 *
 * The budget is charged first and Jev is called only once it passes (and only inside the cap): a
 * billed call must never start when JEV_DAILY_CAP is spent or the counter write failed, since a
 * scripted client could otherwise keep spending past the cap through cheap known-recipe
 * discoveries. It costs one small upsert, which runs alongside the challenge check anyway.
 */
export async function scoreDiscovery(spec: SortSpec, el: { id: string; name: string }): Promise<SortScore | undefined> {
  const id = String(el.id);
  const started = Date.now();
  let timedOut = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const cap = new Promise<"timeout">((resolve) => {
    timer = setTimeout(() => {
      timedOut = true;
      resolve("timeout");
    }, SORT_PIGGYBACK_MS);
  });
  const work = async (): Promise<SortScore | undefined> => {
    const budget = await hit([{ limit: BUDGETS.jev, subject: "all", cost: questionsPer(spec) }]);
    if (!budget.ok || timedOut) return undefined; // never start a billed call whose answer can't be used
    const left = Math.max(0, SORT_PIGGYBACK_MS - (Date.now() - started));
    const out = await scoreElements(spec, [{ id, name: el.name }], { deadlineMs: left, retries: 0, split: false });
    return out.scored.get(id);
  };
  try {
    const r = await Promise.race([work(), cap]);
    if (r === "timeout") {
      console.warn("[combine] sort score skipped", "timeout");
      return undefined;
    }
    return r;
  } catch (e) {
    console.warn("[combine] sort score skipped", e instanceof Error ? e.message : typeof e);
    return undefined;
  } finally {
    clearTimeout(timer);
  }
}

interface ResultRow extends ElementRow {
  discovered_by: string | null;
}

interface RecipeRow {
  recipe_id: string;
  recipe_status: string;
  protected: boolean;
  /** Result element; null if the row points at a missing element. */
  result: ResultRow | null;
}

const RESULT_COLS = `${ELEMENT_COLS}, e.discovered_by`;

async function findRecipe(key: string[], client?: Queryable): Promise<RecipeRow | undefined> {
  const row = await q1<ResultRow & { recipe_id: string; recipe_status: string; protected: boolean }>(
    `SELECT r.id AS recipe_id, r.status AS recipe_status, r.protected, ${RESULT_COLS}
       FROM ${t("recipes")} r
       LEFT JOIN ${t("elements")} e ON e.id = r.result_id
      WHERE r.ingredient_ids = $1::INT8[]`,
    [key],
    client,
  );
  if (!row) return undefined;
  const { recipe_id, recipe_status, protected: isProtected, ...element } = row;
  return { recipe_id, recipe_status, protected: isProtected, result: element.id ? element : null };
}

/** A recipe can be served as-is only if it and its result are active. */
const usable = (r: RecipeRow): r is RecipeRow & { result: ResultRow } =>
  r.recipe_status === "active" && r.result?.status === "active";

async function ownedIngredients(playerId: string, ids: string[]): Promise<ElementRow[]> {
  return q<ElementRow>(
    `SELECT ${ELEMENT_COLS}
       FROM ${t("discoveries")} d
       JOIN ${t("elements")} e ON e.id = d.element_id
      WHERE d.player_id = $1 AND d.element_id = ANY($2::INT8[]) AND e.status = 'active'`,
    [playerId, ids],
  );
}

/**
 * Depth/steps a result reached through this recipe: depth = 1 + max ingredient depth,
 * steps = 1 + Σ steps of the distinct ingredients. Unknown if any ingredient is unknown.
 */
export function candidateCost(ingredients: readonly Pick<ElementRow, "id" | "depth" | "steps">[]): {
  depth: number | null;
  steps: number | null;
} {
  const distinct = [...new Map(ingredients.map((e) => [e.id, e])).values()];
  const depths = distinct.map((e) => e.depth);
  const steps = distinct.map((e) => e.steps);
  return {
    depth: depths.every((d) => d != null) ? 1 + Math.max(...(depths as number[])) : null,
    steps: steps.every((s) => s != null) ? 1 + (steps as number[]).reduce((a, b) => a + b, 0) : null,
  };
}

async function addDiscovery(playerId: string, elementId: string, recipeId: string, client?: Queryable): Promise<Date | null> {
  const row = await q1<{ discovered_at: Date }>(
    `INSERT INTO ${t("discoveries")} (player_id, element_id, source, recipe_id) VALUES ($1, $2, 'combine', $3)
     ON CONFLICT (player_id, element_id) DO NOTHING
     RETURNING discovered_at`,
    [playerId, elementId, recipeId],
    client,
  );
  return row?.discovered_at ?? null;
}

interface Outcome {
  result: ResultRow;
  recipeNew: boolean;
  firstEver: boolean;
  /** Set when the result was added to the player's library by this request. */
  discoveredAt: Date | null;
}

/** A concurrent request wrote the same recipe or element name; re-run the transaction. */
class Raced extends Error {}

/**
 * Reactivate an element that a purge quarantined only because it became unreachable from the
 * starters (quarantine_reason 'orphaned', scripts/purge-elements.ts). Any other quarantined row
 * (legacy spam, review-purged junk) is left alone and undefined is returned.
 */
async function reviveOrphan(c: Queryable, id: string): Promise<ResultRow | undefined> {
  try {
    return await q1<ResultRow>(
      `UPDATE ${t("elements")} AS e SET status = 'active', quarantine_reason = NULL, purge_run = NULL
        WHERE e.id = $1 AND e.status = 'quarantined' AND e.quarantine_reason = 'orphaned'
        RETURNING ${RESULT_COLS}`,
      [id],
      c,
    );
  } catch (e) {
    // undefined_column: migration 0004 is not applied yet, so nothing can be orphaned.
    if ((e as { code?: string }).code === "42703") return undefined;
    throw e;
  }
}

/** Resolve the proposal to an element row: exact name, then a near-identical (folded) name, else insert. */
export async function resolveElement(
  c: pg.PoolClient,
  proposal: ElementProposal,
  cost: { depth: number | null; steps: number | null },
  playerId: string,
): Promise<{ element: ResultRow; inserted: boolean }> {
  const byKey = await q1<ResultRow>(`SELECT ${RESULT_COLS} FROM ${t("elements")} e WHERE e.name_key = $1`, [proposal.key], c);
  // Quarantined names (legacy spam / blocklisted / purged junk) are never resurrected; only
  // elements a purge orphaned come back when the model names them again.
  const revived = byKey && byKey.status !== "active" ? await reviveOrphan(c, byKey.id) : undefined;
  if (byKey && byKey.status !== "active" && !revived) throw new Fizzled(`"${proposal.name}" is quarantined`);
  const existing =
    revived ??
    byKey ??
    (await q1<ResultRow>(
      `SELECT ${RESULT_COLS} FROM ${t("elements")} e WHERE e.fold_key = $1 AND e.status = 'active' ORDER BY e.id LIMIT 1`,
      [proposal.foldKey],
      c,
    ));
  if (existing) {
    // A new recipe may be a shorter path: only ever lower depth/steps.
    const lowered = await q1<{ depth: number | null; steps: number | null }>(
      `UPDATE ${t("elements")}
          SET depth = CASE WHEN $2::INT4 IS NOT NULL AND (depth IS NULL OR depth > $2::INT4) THEN $2::INT4 ELSE depth END,
              steps = CASE WHEN $3::INT4 IS NOT NULL AND (steps IS NULL OR steps > $3::INT4) THEN $3::INT4 ELSE steps END
        WHERE id = $1
          AND (($2::INT4 IS NOT NULL AND (depth IS NULL OR depth > $2::INT4))
            OR ($3::INT4 IS NOT NULL AND (steps IS NULL OR steps > $3::INT4)))
        RETURNING depth, steps`,
      [existing.id, cost.depth, cost.steps],
      c,
    );
    return { element: lowered ? { ...existing, ...lowered } : existing, inserted: false };
  }
  const inserted = await q1<ResultRow>(
    `INSERT INTO ${t("elements")} AS e
       (name, name_key, fold_key, emoji, description, notable, art_hint, depth, steps, discovered_by, source, enriched_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, 'llm', now())
     ON CONFLICT (name_key) DO NOTHING
     RETURNING ${RESULT_COLS}`,
    [
      proposal.name,
      proposal.key,
      proposal.foldKey,
      proposal.emoji,
      proposal.description,
      proposal.notable,
      proposal.artHint,
      cost.depth,
      cost.steps,
      playerId,
    ],
    c,
  );
  if (!inserted) throw new Raced();
  return { element: inserted, inserted: true };
}

/** Store a freshly invented recipe (or heal a quarantined one) plus the discovery, atomically. */
async function storeInvention(
  playerId: string,
  key: string[],
  proposal: ElementProposal,
  cost: { depth: number | null; steps: number | null },
): Promise<Outcome> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await withTx(async (c): Promise<Outcome> => {
        // Another request may have created or healed this recipe while we waited for the model.
        const current = await findRecipe(key, c);
        if (current && usable(current)) {
          const discoveredAt = await addDiscovery(playerId, current.result.id, current.recipe_id, c);
          return { result: current.result, recipeNew: false, firstEver: false, discoveredAt };
        }
        const { element, inserted } = await resolveElement(c, proposal, cost, playerId);
        const recipe = current
          ? await q1<{ id: string }>(
              `UPDATE ${t("recipes")} SET result_id = $2, status = 'active', source = 'llm', created_by = $3
                WHERE id = $1 AND NOT protected RETURNING id`,
              [current.recipe_id, element.id, playerId],
              c,
            )
          : await q1<{ id: string }>(
              `INSERT INTO ${t("recipes")} (ingredient_ids, result_id, arity, status, source, created_by)
               VALUES ($1::INT8[], $2, $3, 'active', 'llm', $4)
               ON CONFLICT (ingredient_ids) DO NOTHING RETURNING id`,
              [key, element.id, key.length, playerId],
              c,
            );
        if (!recipe) throw new Raced();
        const discoveredAt = await addDiscovery(playerId, element.id, recipe.id, c);
        return { result: element, recipeNew: true, firstEver: inserted, discoveredAt };
      });
    } catch (e) {
      if (e instanceof Raced && attempt < 2) continue;
      throw e;
    }
  }
}

/**
 * Smaller combinations inside this one: for A+B the self-pairs A+A and B+B; for 3–4
 * ingredients every sub-multiset of size 2..n-1. Each is a numerically sorted recipe key.
 */
export function subRecipeKeys(key: string[]): string[][] {
  const out = new Map<string, string[]>();
  if (key.length === 2 && key[0] !== key[1]) {
    for (const id of key) out.set(`${id},${id}`, [id, id]);
  }
  if (key.length >= 3) {
    for (let mask = 1; mask < (1 << key.length) - 1; mask++) {
      const sub = key.filter((_, i) => mask & (1 << i));
      if (sub.length >= 2) out.set(sub.join(","), sub);
    }
  }
  return [...out.values()];
}

/**
 * Results that smaller combinations already make: the model must not answer with those.
 * Best-effort (it only improves answer quality), so a failure never blocks the combine.
 */
async function resultsToAvoid(key: string[], owned: ElementRow[]): Promise<AvoidResult[]> {
  const subs = subRecipeKeys(key);
  if (subs.length === 0) return [];
  try {
    // CockroachDB rejects `array IN (array, ...)` (and rewrites OR'd array equalities into it),
    // so look each key up separately; every branch is a unique-index point lookup.
    const rows = await q<{ ingredient_ids: string[]; name_key: string }>(
      subs
        .map(
          (_, i) => `(SELECT r.ingredient_ids, e.name_key
               FROM ${t("recipes")} r JOIN ${t("elements")} e ON e.id = r.result_id
              WHERE r.ingredient_ids = $${i + 1}::INT8[] AND r.status = 'active')`,
        )
        .join(" UNION ALL "),
      subs,
    );
    const nameOf = (id: string) => owned.find((e) => e.id === String(id))?.name ?? "those ingredients";
    return rows.map((r) => ({
      key: r.name_key,
      because: `that is what ${r.ingredient_ids.map(nameOf).join(" + ")} already makes`,
    }));
  } catch (e) {
    console.warn("[combine] avoid lookup failed", (e as Error).message);
    return [];
  }
}

async function invent(playerId: string, ip: string, key: string[], owned: ElementRow[]): Promise<Outcome> {
  await enforce([
    { limit: LIMITS.llmPlayer, subject: playerId },
    { limit: LIMITS.llmPlayerHour, subject: playerId },
    { limit: LIMITS.llmPlayerDay, subject: playerId },
    { limit: LIMITS.llmIpHour, subject: ip },
    { limit: LIMITS.llmIpDay, subject: ip },
    { limit: BUDGETS.llm, subject: "all" },
  ]);
  // Names in recipe-key order (with duplicates) so the prompt is stable for a given multiset.
  const names = key.map((id) => owned.find((e) => e.id === id)!.name);
  try {
    const avoid = await resultsToAvoid(key, owned);
    const proposal = await proposeElement(names, safetyId(playerId), avoid);
    return await storeInvention(playerId, key, proposal, candidateCost(owned));
  } catch (e) {
    if (e instanceof Fizzled) {
      console.info("[combine] fizzled", e.reason);
      throw errors.fizzled();
    }
    if (e instanceof AiUnavailable) throw errors.aiUnavailable();
    throw e;
  }
}

export async function combineElements(req: Request, context: Context): Promise<Response> {
  checkCsrf(req);
  const body = await readJson(req, CombineSchema, BODY_LIMIT_DEFAULT);
  // The signed cookie already proves the player id, so the revocation check, the limiter
  // and the lookups run concurrently (this is the hot path).
  const claims = sessionClaims(req);
  if (!claims) throw errors.unauthorized();
  const ip = ipHash(clientIp(req, context));
  const key = sortIds(body.ids);
  const distinct = [...new Set(key)];
  const [player, , owned, recipe] = await Promise.all([
    playerForClaims(claims),
    enforce([
      { limit: LIMITS.combinePlayer, subject: claims.p },
      { limit: LIMITS.combinePlayerHour, subject: claims.p },
      { limit: LIMITS.combineIpHour, subject: ip },
    ]),
    ownedIngredients(claims.p, distinct),
    findRecipe(key),
  ]);
  if (!player) throw errors.unauthorized();
  if (owned.length !== distinct.length) throw errors.notOwned();

  let outcome: Outcome;
  if (recipe && usable(recipe)) {
    const discoveredAt = await addDiscovery(player.id, recipe.result.id, recipe.recipe_id);
    outcome = { result: recipe.result, recipeNew: false, firstEver: false, discoveredAt };
  } else if (recipe?.protected) {
    // Protected recipes (challenge paths) are never re-rolled; the backfill keeps their results active.
    console.error("[combine] protected recipe has an unusable result", recipe.recipe_id);
    throw errors.fizzled();
  } else {
    outcome = await invent(player.id, ip, key, owned);
  }

  // The sort score runs alongside the challenge check, so it adds at most SORT_PIGGYBACK_MS.
  const scoring =
    body.sort && outcome.discoveredAt ? scoreDiscovery(body.sort, outcome.result) : Promise.resolve(undefined);
  const day = resolveDay(body.clientDate);
  const [completed, sortScore] = await Promise.all([
    completeTiers(player.id, day, outcome.result.id),
    scoring,
    countActivity(player.id, "combines", day),
  ]);
  const result = toElementDTO(outcome.result);
  const response: CombineResponse = {
    result,
    newForPlayer: outcome.discoveredAt != null,
    firstEver: outcome.firstEver,
    recipeNew: outcome.recipeNew,
    completed,
    ...(outcome.discoveredAt
      ? {
          entry: {
            ...result,
            discoveredAt: outcome.discoveredAt.toISOString(),
            first: outcome.result.discovered_by === player.id,
          },
        }
      : {}),
    ...(sortScore ? { sortScore } : {}),
  };
  return json(response);
}
