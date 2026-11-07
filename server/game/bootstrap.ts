// POST /api/bootstrap: resolve (or create / adopt) the player, optionally import a legacy
// inventory, and return everything the client needs for a session in one response.
import crypto from "node:crypto";
import type { Context } from "@netlify/functions";
import { z } from "zod";
import type { BootstrapResponse, PowSolution } from "../../src/shared/api.ts";
import { BODY_LIMIT_BOOTSTRAP, checkCsrf, clientIp, errors, ipHash, json, readJson } from "../http.ts";
import { checkPowSolution, issuePow, verifyPow, type PowCheck } from "../pow.ts";
import { BUDGETS, LIMITS, enforce } from "../ratelimit.ts";
import { encodeSession, sessionCookie, sessionPlayer, type PlayerRow } from "../session.ts";
import { challengeStats, dailyChallenge, resolveDay } from "./challenges.ts";
import { toElementDTO, toLibraryEntry } from "./dto.ts";
import {
  claimLegacyPlayer,
  countFirsts,
  createPlayer,
  ensureStarters,
  importLegacy,
  isLegacyUserId,
  knownCount,
  library,
  recentElements,
  touchPlayer,
} from "./players.ts";

export const BootstrapSchema = z.object({
  clientDate: z.string().max(32),
  pow: z.object({ salt: z.string().max(128), nonce: z.string().max(64) }).optional(),
  legacy: z
    .object({
      userId: z.string().max(200).nullable(),
      // Truncated to MAX_LEGACY_IDS during import; the 1 MB body cap bounds the array.
      elementIds: z.array(z.string().max(32)),
      // This browser's claim token (src/app/lib/legacy.ts): binds the legacy player on first adoption.
      claim: z.string().regex(/^[0-9a-f]{32}$/).optional(),
    })
    .optional(),
});

/** Earth, Water, Air, Fire and Time. */
const STARTER_COUNT = 5;

const POW_MESSAGES: Record<Exclude<PowCheck, "ok">, string> = {
  malformed: "Proof-of-work solution was malformed.",
  bad_signature: "Proof-of-work challenge was not issued by this server.",
  expired: "Proof-of-work challenge expired. Solve the new one.",
  insufficient: "Proof-of-work solution is incorrect.",
  replayed: "Proof-of-work challenge was already used.",
};

/**
 * New players must present a fresh, unspent PoW solution and fit the creation limits. The
 * global player budget is charged last, so a replayed salt or an over-limit IP never spends it.
 */
async function createWithPow(pow: PowSolution | undefined, ip: string): Promise<PlayerRow> {
  if (!pow) throw errors.powRequired(issuePow());
  const stateless = checkPowSolution(pow);
  if (stateless !== "ok") throw errors.powRequired(issuePow(), POW_MESSAGES[stateless]);
  await enforce([
    { limit: LIMITS.createIp, subject: ip },
    { limit: LIMITS.createIpDay, subject: ip },
  ]);
  const spent = await verifyPow(pow);
  if (spent !== "ok") throw errors.powRequired(issuePow(), POW_MESSAGES[spent]);
  await enforce([{ limit: BUDGETS.players, subject: "all" }]);
  return createPlayer(ip);
}

export async function bootstrap(req: Request, context: Context): Promise<Response> {
  checkCsrf(req);
  const body = await readJson(req, BootstrapSchema, BODY_LIMIT_BOOTSTRAP);
  const ip = ipHash(clientIp(req, context));
  const today = resolveDay(body.clientDate);

  let [player] = await Promise.all([sessionPlayer(req), enforce([{ limit: LIMITS.bootstrapIp, subject: ip }])]);
  let adopted = false;
  let claimed = false;
  const legacyUserId = body.legacy?.userId;
  if (!player && isLegacyUserId(legacyUserId)) {
    await enforce([{ limit: LIMITS.adoptIp, subject: ip }]);
    const claimHash = body.legacy?.claim ? crypto.createHash("sha256").update(body.legacy.claim).digest("hex") : null;
    const claim = await claimLegacyPlayer(legacyUserId, claimHash);
    if (claim.player) {
      await ensureStarters(claim.player.id);
      player = claim.player;
      adopted = true;
    }
    // Bound to another browser: this one becomes a new player (PoW-gated; the check above is
    // stateless, so the 401 pow_required retry lands here again) and only gets a copy of the
    // inventory below. Firsts and challenge history stay with the bound player.
    claimed = claim.claimed;
  }
  player ??= await createWithPow(body.pow, ip);

  let legacyImport: BootstrapResponse["legacyImport"];
  if (body.legacy) {
    const r = await importLegacy(player.id, body.legacy.elementIds);
    legacyImport = { ...r, adopted, claimed };
  }

  const playerId = player.id;
  // Legacy players are backfilled without starter rows. Adoption adds them, but a legacy player
  // can also arrive via a transfer code (or lose them some other way), so make sure every load
  // has all starters; this is a no-op once they're there.
  const libraryWithStarters = async () => {
    const rows = await library(playerId);
    if (rows.filter((r) => r.is_starter).length >= STARTER_COUNT) return rows;
    await ensureStarters(playerId);
    return library(playerId);
  };
  const [lib, firsts, known, challenge, chStats, recent] = await Promise.all([
    libraryWithStarters(),
    countFirsts(playerId),
    knownCount(),
    dailyChallenge(playerId, today),
    challengeStats(playerId, today),
    recentElements(),
    touchPlayer(playerId),
  ]);

  const response: BootstrapResponse = {
    player: { id: player.public_id, createdAt: player.created_at.toISOString(), legacy: player.legacy_user_id != null },
    library: lib.map((row) => toLibraryEntry(row, playerId)),
    stats: {
      known,
      mine: lib.length,
      firsts,
      challengesCompleted: chStats.completed,
      streak: chStats.streak,
    },
    challenge,
    history: chStats.history,
    recent: recent.map(toElementDTO),
    ...(legacyImport ? { legacyImport } : {}),
  };
  return json(response, { headers: { "set-cookie": sessionCookie(req, encodeSession(playerId, player.session_version)) } });
}
