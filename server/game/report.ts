// POST /api/report: "Report this element" from the details menu. Stores one row per player and
// element (the first report wins) for the purge review to read in aggregate; it changes nothing
// in the game by itself.
import type { Context } from "@netlify/functions";
import { z } from "zod";
import { REPORT_REASONS, type ReportResponse } from "../../src/shared/api.ts";
import { q1, t } from "../db.ts";
import { BODY_LIMIT_DEFAULT, checkCsrf, errors, json, readJson } from "../http.ts";
import { LIMITS, enforce } from "../ratelimit.ts";
import { playerForClaims, sessionClaims } from "../session.ts";
import { isTodayTarget } from "./challenges.ts";
import { isElementId } from "./dto.ts";

export const ReportSchema = z.object({
  id: z.string().max(32),
  // Optional: an unknown reason is stored as none rather than refusing the report.
  reason: z.enum(REPORT_REASONS).optional().catch(undefined),
});

export async function reportElement(req: Request, _context?: Context): Promise<Response> {
  checkCsrf(req);
  const body = await readJson(req, ReportSchema, BODY_LIMIT_DEFAULT);
  if (!isElementId(body.id)) throw errors.badRequest("Invalid element id.");
  const claims = sessionClaims(req);
  if (!claims) throw errors.unauthorized();
  // The limit is charged alongside the session lookup (attempts count, so it also caps probing).
  const [player, target] = await Promise.all([
    playerForClaims(claims),
    isTodayTarget(body.id),
    enforce([{ limit: LIMITS.reportPlayer, subject: claims.p }]),
  ]);
  if (!player) throw errors.unauthorized();
  // Only elements the player has seen as theirs, or today's targets (shown to everyone): a report
  // can't be filed against arbitrary ids. One statement checks and inserts.
  const row = await q1<{ allowed: boolean }>(
    `WITH ok AS (
       SELECT $3::BOOL OR EXISTS (
         SELECT 1 FROM ${t("discoveries")} WHERE player_id = $1::INT8 AND element_id = $2::INT8
       ) AS allowed
     ), ins AS (
       INSERT INTO ${t("element_reports")} (player_id, element_id, reason)
       SELECT $1::INT8, $2::INT8, $4::STRING FROM ok WHERE ok.allowed
       ON CONFLICT (player_id, element_id) DO NOTHING
       RETURNING element_id
     )
     SELECT ok.allowed, (SELECT count(*) FROM ins) AS inserted -- reading ins keeps the insert explicit
       FROM ok`,
    [player.id, body.id, target, body.reason ?? null],
  );
  if (!row?.allowed) throw errors.forbidden("You can only report elements in your library or today's challenge.");
  return json({ ok: true } satisfies ReportResponse);
}
