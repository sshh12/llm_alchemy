// Proof-of-work gate for player creation. The salt is stateless and self-describing:
// `<issuedAt base36>.<random>.<hmac>`; the server only stores it once it is spent.
import { randomBytes } from "node:crypto";
import type { PowChallenge, PowSolution } from "../src/shared/api.ts";
import { checkPow } from "../src/shared/pow.ts";
import { sign, verifySignature } from "./crypto.ts";
import { env } from "./env.ts";
import { consumeOnce } from "./ratelimit.ts";

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
