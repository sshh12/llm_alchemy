// HMAC helpers keyed by SESSION_SECRET. Every signature is domain-separated by a
// `purpose` so a value signed for one use (e.g. a PoW salt) can never be replayed
// as another (e.g. a session cookie).
import { createHmac, timingSafeEqual } from "node:crypto";
import { env } from "./env.ts";

export type SignPurpose = "session" | "transfer" | "pow" | "ip" | "safety";

export function hmac(purpose: SignPurpose, data: string): Buffer {
  return createHmac("sha256", env.sessionSecret).update(`${purpose}\n${data}`).digest();
}

/** base64url HMAC, optionally truncated to `bytes` bytes. */
export function sign(purpose: SignPurpose, data: string, bytes = 32): string {
  return hmac(purpose, data).subarray(0, bytes).toString("base64url");
}

/** Constant-time check of a base64url signature produced by `sign` with the same length. */
export function verifySignature(purpose: SignPurpose, data: string, signature: string, bytes = 32): boolean {
  const expected = Buffer.from(sign(purpose, data, bytes));
  const actual = Buffer.from(signature);
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

/** Stable pseudonymous id for a player, sent to OpenAI as `safety_identifier`. */
export function safetyId(playerId: string): string {
  return hmac("safety", playerId).subarray(0, 16).toString("hex");
}
