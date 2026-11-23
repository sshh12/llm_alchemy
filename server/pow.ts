// Proof-of-work gate for player creation. The salt is stateless and self-describing:
// `<issuedAt base36>.<random>.<hmac>`; the server only stores it once it is spent.
//
// PoW funnel stats (daily counters via bumpStat, kept 90 days; never the salt or the IP):
//   pow:issued:<browser|bot>    a pow_required challenge was sent
//   pow:redeemed:<browser|bot>  a valid solution was spent
//   pow:latency:<band>          issue -> redemption time of that solution (LATENCY_BANDS)
// Issued minus redeemed is the share of new visitors lost while solving or on the second POST.
import { randomBytes } from "node:crypto";
import { latencyBand, type PowChallenge, type PowSolution } from "../src/shared/api.ts";
import { checkPow } from "../src/shared/pow.ts";
import { sign, verifySignature } from "./crypto.ts";
import { env } from "./env.ts";
import { bumpStat, consumeOnce } from "./ratelimit.ts";
import type { UaClass } from "./ua.ts";

export const POW_TTL_MS = 10 * 60_000;
const SKEW_MS = 60_000;
const SIG_BYTES = 12;

export function issuePow(nowMs = Date.now()): PowChallenge {
  const body = `${nowMs.toString(36)}.${randomBytes(12).toString("base64url")}`;
  return { salt: `${body}.${sign("pow", body, SIG_BYTES)}`, bits: env.powBits };
}

export type PowCheck = "ok" | "malformed" | "bad_signature" | "expired" | "insufficient" | "replayed";

/** Stateless checks: shape, signature, freshness, work. */
export function checkPowSolution(sol: PowSolution, nowMs = Date.now()): PowCheck {
  const m = /^([0-9a-z]{1,11})\.([A-Za-z0-9_-]{16})\.([A-Za-z0-9_-]{16})$/.exec(sol.salt);
  if (!m || typeof sol.nonce !== "string") return "malformed";
  const [, ts, rand, sig] = m as unknown as [string, string, string, string];
  if (!verifySignature("pow", `${ts}.${rand}`, sig, SIG_BYTES)) return "bad_signature";
  const issuedAt = Number.parseInt(ts, 36);
  if (issuedAt > nowMs + SKEW_MS || nowMs - issuedAt > POW_TTL_MS) return "expired";
  if (!checkPow(sol.salt, sol.nonce, env.powBits)) return "insufficient";
  return "ok";
}

/** Full verification; on success the salt is spent and can never be used again. */
export async function verifyPow(sol: PowSolution, nowMs = Date.now()): Promise<PowCheck> {
  const r = checkPowSolution(sol, nowMs);
  if (r !== "ok") return r;
  return (await consumeOnce(`pow:${sol.salt}`, POW_TTL_MS + SKEW_MS, nowMs)) ? "ok" : "replayed";
}

/** When the server issued `salt` (ms since the epoch), or null if it isn't one of ours in shape. */
export function powIssuedAt(salt: string): number | null {
  const m = /^([0-9a-z]{1,11})\./.exec(salt);
  if (!m) return null;
  const t = Number.parseInt(m[1]!, 36);
  return Number.isFinite(t) ? t : null;
}

/** Duration bands of the PoW latency and boot-abandon stats (shared with GA app_ready boot_band). */
export { LATENCY_BANDS, latencyBand, type LatencyBand } from "../src/shared/api.ts";

/** Crawlers apart from everyone else: the PoW funnel is about real browsers. */
export const powAudience = (uaClass: UaClass | undefined): "browser" | "bot" => (uaClass === "bot" ? "bot" : "browser");

/** Count a pow_required challenge (best-effort, never throws). */
export function recordPowIssued(uaClass: UaClass | undefined, nowMs = Date.now()): Promise<void> {
  return bumpStat(`pow:issued:${powAudience(uaClass)}`, 1, nowMs);
}

/**
 * Count a spent (valid) solution and how long it took from issue to redemption. The two upserts
 * run in parallel, so they cost one round trip; callers overlap it with their next statement.
 */
export async function recordPowRedeemed(sol: PowSolution, uaClass: UaClass | undefined, nowMs = Date.now()): Promise<void> {
  const issuedAt = powIssuedAt(sol.salt);
  await Promise.all([
    bumpStat(`pow:redeemed:${powAudience(uaClass)}`, 1, nowMs),
    ...(issuedAt != null ? [bumpStat(`pow:latency:${latencyBand(nowMs - issuedAt)}`, 1, nowMs)] : []),
  ]);
}
