// POST /api/player: reset progress, issue a transfer code, or redeem one on another device.
import type { Context } from "@netlify/functions";
import { z } from "zod";
import type { PlayerResponse } from "../../src/shared/api.ts";
import { q, t, withTx } from "../db.ts";
import { BODY_LIMIT_DEFAULT, checkCsrf, clientIp, errors, ipHash, json, readJson } from "../http.ts";
import { LIMITS, enforce } from "../ratelimit.ts";
import {
  decodeTransferCode,
  encodeSession,
  encodeTransferCode,
  loadPlayer,
  requirePlayer,
  sessionCookie,
} from "../session.ts";

export const PlayerActionSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("reset") }),
  z.object({ action: z.literal("transfer-code") }),
  z.object({ action: z.literal("redeem"), code: z.string().max(200) }),
]);

/** Library back to the starters. Firsts (elements.discovered_by) and challenge history are untouched. */
async function resetLibrary(playerId: string): Promise<void> {
  await withTx(async (c) => {
    await q(
      `DELETE FROM ${t("discoveries")}
        WHERE player_id = $1
          AND element_id NOT IN (SELECT id FROM ${t("elements")} WHERE is_starter)`,
      [playerId],
      c,
    );
    await q(
      `INSERT INTO ${t("discoveries")} (player_id, element_id, source)
       SELECT $1, e.id, 'starter' FROM ${t("elements")} e WHERE e.is_starter
       ON CONFLICT DO NOTHING`,
      [playerId],
      c,
    );
  });
}

export async function playerAction(req: Request, context: Context): Promise<Response> {
  checkCsrf(req);
  const body = await readJson(req, PlayerActionSchema, BODY_LIMIT_DEFAULT);

  switch (body.action) {
    case "reset": {
      const player = await requirePlayer(req);
      await enforce([{ limit: LIMITS.resetPlayer, subject: player.id }]);
      await resetLibrary(player.id);
      return json({ ok: true, action: "reset" } satisfies PlayerResponse);
    }
    case "transfer-code": {
      const player = await requirePlayer(req);
      await enforce([{ limit: LIMITS.transferPlayer, subject: player.id }]);
      const code = encodeTransferCode(player.id, player.session_version);
      return json({ ok: true, action: "transfer-code", code } satisfies PlayerResponse);
    }
    case "redeem": {
      // No session needed: this is how a fresh browser joins an existing player.
      await enforce([{ limit: LIMITS.redeemIp, subject: ipHash(clientIp(req, context)) }]);
      const claims = decodeTransferCode(body.code);
      const player = claims ? await loadPlayer(claims.p) : undefined;
      if (!claims || !player || player.session_version !== claims.v) {
        throw errors.badRequest("That transfer code is not valid.");
      }
      return json({ ok: true, action: "redeem" } satisfies PlayerResponse, {
        headers: { "set-cookie": sessionCookie(req, encodeSession(player.id, player.session_version)) },
      });
    }
  }
}
