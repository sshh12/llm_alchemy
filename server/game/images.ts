// POST /api/image: lazily generate an element's tile art under a DB lease, so concurrent
// requests for the same element produce exactly one generation.
import type { Context } from "@netlify/functions";
import { z } from "zod";
import type { ImageResponse } from "../../src/shared/api.ts";
import { Blocked, paintElement } from "../ai/index.ts";
import { imgPath, newImageKey, putArt } from "../blobs.ts";
import { safetyId } from "../crypto.ts";
import { q, q1, t } from "../db.ts";
import { BODY_LIMIT_DEFAULT, checkCsrf, clientIp, errors, ipHash, json, readJson } from "../http.ts";
import { BUDGETS, LIMITS, hit } from "../ratelimit.ts";
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
  owned: boolean;
}

/** Elements a player may trigger art for: their own, or a target of a challenge that is "today" somewhere. */
async function isChallengeTarget(elementId: string): Promise<boolean> {
  const challenges = await Promise.all(plausibleDays().map(getChallenge));
  return challenges.some((c) => c != null && tiersFor(c, elementId).length > 0);
}

async function setOutcome(id: string, status: "ready" | "blocked" | "failed", imageKey: string | null = null): Promise<void> {
  await q(
    `UPDATE ${t("elements")}
        SET image_status = $2, image_key = COALESCE($3, image_key), image_lease_until = NULL
      WHERE id = $1`,
    [id, status, imageKey],
  );
}

export async function requestImage(req: Request, context: Context): Promise<Response> {
  checkCsrf(req);
  const { id } = await readJson(req, ImageSchema, BODY_LIMIT_DEFAULT);
  const player = await requirePlayer(req);
  const reply = (r: ImageResponse) => json(r);

  const el = await q1<ArtRow>(
    `SELECT e.id, e.name, e.description, e.art_hint, e.notable, e.status, e.image_status, e.image_key, e.image_attempts,
            COALESCE(e.image_lease_until > now(), false) AS leased,
            EXISTS (SELECT 1 FROM ${t("discoveries")} d WHERE d.player_id = $2 AND d.element_id = e.id) AS owned
       FROM ${t("elements")} e WHERE e.id = $1`,
    [id, player.id],
  );
  if (!el || el.status !== "active") throw errors.notFound("No such element.");
  if (el.image_status === "ready" && el.image_key) return reply({ state: "ready", img: imgPath(el.id, el.image_key) });
  if (el.image_status === "blocked") return reply({ state: "blocked" });
  if (!el.owned && !(await isChallengeTarget(el.id))) throw errors.forbidden("You can only request art for your own elements.");
  if (el.image_status === "pending" && el.leased) return reply({ state: "pending", retryAfterMs: PENDING_RETRY_MS });
  if (el.image_attempts >= MAX_ATTEMPTS) return reply({ state: "deferred", retryAfterMs: GAVE_UP_RETRY_MS });

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

  // Budgets are charged only for generations we actually start (not polls or ready art).
  const ip = ipHash(clientIp(req, context));
  const allowed = await hit([
    { limit: LIMITS.imagePlayerHour, subject: player.id },
    { limit: LIMITS.imagePlayerDay, subject: player.id },
    { limit: LIMITS.imageIpHour, subject: ip },
    { limit: LIMITS.imageIpDay, subject: ip },
    { limit: BUDGETS.image, subject: "all" },
    { limit: BUDGETS.imageMonth, subject: "all" },
  ]);
  if (!allowed.ok) {
    // Give the lease (and the attempt) back so the element is not penalized.
    await q(
      `UPDATE ${t("elements")}
          SET image_status = $2, image_attempts = image_attempts - 1, image_lease_until = NULL
        WHERE id = $1 AND image_status = 'pending'`,
      [id, el.image_status === "failed" ? "failed" : "none"],
    );
    return reply({ state: "deferred", retryAfterMs: allowed.retryAfterMs, limited: true });
  }

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
      ? reply({ state: "pending", retryAfterMs: FAILED_RETRY_MS })
      : reply({ state: "deferred", retryAfterMs: GAVE_UP_RETRY_MS });
  }
}
