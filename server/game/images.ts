// POST /api/image: lazily generate an element's tile art under a DB lease, so concurrent
// requests for the same element produce exactly one generation.
//
// Spending is split into two lanes (docs/ARCHITECTURE.md "Images"). fresh: this player
// discovered the element in the last FRESH_MS, or it is a challenge target that is "today"
// somewhere. backlog: anything else (old library tiles). Both lanes charge the same paced image
// budgets (server/ratelimit.ts imageBudgets), but fresh may run ahead of pace while backlog only
// spends when spending is behind it, under a small per-player backlog cap. A denial is a
// "deferred" reply: the tile keeps its emoji placeholder and the client asks again later.
import type { Context } from "@netlify/functions";
import { z } from "zod";
import type { ArtDeferReason, ArtLane, ImageResponse } from "../../src/shared/api.ts";
import { Blocked, paintElement } from "../ai/index.ts";
import { imgPath, newImageKey, putArt } from "../blobs.ts";
import { safetyId } from "../crypto.ts";
import { q, q1, t } from "../db.ts";
import { BODY_LIMIT_DEFAULT, checkCsrf, clientIp, errors, ipHash, json, readJson } from "../http.ts";
import { LIMITS, bumpStat, hit, imageBudgets, type HitResult } from "../ratelimit.ts";
import { requirePlayer } from "../session.ts";
import { getChallenge, plausibleDays, tiersFor } from "./challenges.ts";
import { isElementId } from "./dto.ts";

export const ImageSchema = z.object({ id: z.string().refine(isElementId, "invalid element id") });

const MAX_ATTEMPTS = 3;
/** Poll hint while another request holds the lease (generation takes ~8 s). */
const PENDING_RETRY_MS = 3_000;
/** Poll hint after a failed attempt that can still be retried. */
const FAILED_RETRY_MS = 5_000;
/** After MAX_ATTEMPTS failures the element keeps its placeholder; check back much later. */
const GAVE_UP_RETRY_MS = 6 * 3_600_000;
/** A discovery this recent is "fresh": its art is what the player is looking at right now. */
export const FRESH_MS = 20 * 60_000;
/**
 * Longest retry hint on a backlog-lane denial. Clients from before the lanes pause their whole
 * art queue (fresh discoveries included) for a limited deferral's hint, and backlog denials are
 * frequent and can hint hours (image.backlog.player.day: the end of the UTC day). The current
 * client holds backlog requests at most 15 minutes after one anyway and re-asks a resting
 * element only on its next view, so a shorter hint costs it nothing.
 */
export const BACKLOG_HINT_MAX_MS = 15 * 60_000;

interface ArtRow {
  id: string;
  name: string;
  description: string | null;
  art_hint: string | null;
  notable: boolean;
  status: string;
  image_status: string;
  image_key: string | null;
  image_attempts: number;
  leased: boolean;
  /** When the requesting player discovered it; null if they don't own it. */
  discovered_at: Date | null;
}

/** Elements a player may trigger art for: their own, or a target of a challenge that is "today" somewhere. */
async function isChallengeTarget(elementId: string): Promise<boolean> {
  const challenges = await Promise.all(plausibleDays().map(getChallenge));
  return challenges.some((c) => c != null && tiersFor(c, elementId).length > 0);
}

async function setOutcome(id: string, status: "ready" | "blocked" | "failed", imageKey: string | null = null): Promise<void> {
  const sql = (readyAt: string) =>
    `UPDATE ${t("elements")}
        SET image_status = $2, image_key = COALESCE($3, image_key), image_lease_until = NULL${readyAt}
      WHERE id = $1`;
  try {
    // image_ready_at (migration 0008) makes art latency measurable: ready time minus discovery.
    await q(sql(", image_ready_at = CASE WHEN $2 = 'ready' THEN now() ELSE image_ready_at END"), [id, status, imageKey]);
  } catch (e) {
    // undefined_column: 0008 is not applied yet. Never lose a paid-for image over a timestamp.
    if ((e as { code?: string }).code !== "42703") throw e;
    await q(sql(""), [id, status, imageKey]);
  }
}

/** Which art limit a denial came from, as the client and the stats name it. */
export function deferReason(r: Extract<HitResult, { ok: false }>): Exclude<ArtDeferReason, "gave_up"> {
  if (r.limit.name.startsWith("budget.")) return r.paced ? "pace" : "budget";
  return r.limit.name.startsWith("image.ip.") ? "ip" : "player";
}

export async function requestImage(req: Request, context: Context): Promise<Response> {
  checkCsrf(req);
  const { id } = await readJson(req, ImageSchema, BODY_LIMIT_DEFAULT);
  const player = await requirePlayer(req);
  const reply = (r: ImageResponse) => json(r);

  const el = await q1<ArtRow>(
    `SELECT e.id, e.name, e.description, e.art_hint, e.notable, e.status, e.image_status, e.image_key, e.image_attempts,
            COALESCE(e.image_lease_until > now(), false) AS leased,
            (SELECT d.discovered_at FROM ${t("discoveries")} d WHERE d.player_id = $2 AND d.element_id = e.id) AS discovered_at
       FROM ${t("elements")} e WHERE e.id = $1`,
    [id, player.id],
  );
  if (!el || el.status !== "active") throw errors.notFound("No such element.");
  if (el.image_status === "ready" && el.image_key) return reply({ state: "ready", img: imgPath(el.id, el.image_key) });
  if (el.image_status === "blocked") return reply({ state: "blocked" });
  // Freshness comes from the server's discovery time, so a client can't jump the queue.
  const justFound = el.discovered_at != null && Date.now() - new Date(el.discovered_at).getTime() < FRESH_MS;
  const target = !justFound && (await isChallengeTarget(el.id));
  if (el.discovered_at == null && !target) throw errors.forbidden("You can only request art for your own elements.");
  const lane: ArtLane = justFound || target ? "fresh" : "backlog";
  if (el.image_status === "pending" && el.leased) return reply({ state: "pending", retryAfterMs: PENDING_RETRY_MS });
  if (el.image_attempts >= MAX_ATTEMPTS) return reply({ state: "deferred", retryAfterMs: GAVE_UP_RETRY_MS, lane, reason: "gave_up" });

  const claimed = await q1<{ image_attempts: number }>(
    `UPDATE ${t("elements")}
        SET image_status = 'pending', image_lease_until = now() + INTERVAL '45 seconds', image_attempts = image_attempts + 1
      WHERE id = $1
        AND (image_status IN ('none', 'failed') OR (image_status = 'pending' AND image_lease_until < now()))
        AND image_attempts < $2
      RETURNING image_attempts`,
    [id, MAX_ATTEMPTS],
  );
  // Lost the race: someone else is generating (or just finished); the next poll will see it.
  if (!claimed) return reply({ state: "pending", retryAfterMs: PENDING_RETRY_MS });

  // Limits and budgets are charged only for generations we actually start (not polls or ready
  // art), and a denial refunds them (server/ratelimit.ts), so they count started work only.
  const ip = ipHash(clientIp(req, context));
  const allowed = await hit([
    { limit: LIMITS.imagePlayerHour, subject: player.id },
    { limit: LIMITS.imagePlayerDay, subject: player.id },
    ...(lane === "backlog" ? [{ limit: LIMITS.imageBacklogPlayerDay, subject: player.id }] : []),
    { limit: LIMITS.imageIpHour, subject: ip },
    { limit: LIMITS.imageIpDay, subject: ip },
    ...imageBudgets(lane).map((limit) => ({ limit, subject: "all" })),
  ]);
  if (!allowed.ok) {
    const reason = deferReason(allowed);
    // Give the lease (and the attempt) back so the element is not penalized.
    await Promise.all([
      q(
        `UPDATE ${t("elements")}
            SET image_status = $2, image_attempts = image_attempts - 1, image_lease_until = NULL
          WHERE id = $1 AND image_status = 'pending'`,
        [id, el.image_status === "failed" ? "failed" : "none"],
      ),
      bumpStat(`art:${lane}:deferred_${reason}`),
    ]);
    const retryAfterMs = lane === "backlog" ? Math.min(allowed.retryAfterMs, BACKLOG_HINT_MAX_MS) : allowed.retryAfterMs;
    return reply({ state: "deferred", retryAfterMs, limited: true, lane, reason });
  }
  // Counted while the image generates (~8 s), so it adds no latency; bumpStat never throws.
  const counted = bumpStat(`art:${lane}:started`);

  try {
    const art = await paintElement(el.name, el.art_hint ?? el.description, el.notable, safetyId(player.id));
    const imageKey = newImageKey(art.ext);
    await putArt(el.id, imageKey, art.bytes, art.contentType);
    await setOutcome(el.id, "ready", imageKey);
    return reply({ state: "ready", img: imgPath(el.id, imageKey) });
  } catch (e) {
    if (e instanceof Blocked) {
      await setOutcome(el.id, "blocked");
      return reply({ state: "blocked" });
    }
    console.warn("[image] generation failed", el.id, (e as Error).message);
    await setOutcome(el.id, "failed");
    return claimed.image_attempts < MAX_ATTEMPTS
      ? reply({ state: "pending", retryAfterMs: FAILED_RETRY_MS, failed: true })
      : reply({ state: "deferred", retryAfterMs: GAVE_UP_RETRY_MS, lane, reason: "gave_up" });
  } finally {
    await counted;
  }
}
