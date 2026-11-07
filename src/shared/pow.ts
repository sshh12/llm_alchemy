// Proof-of-work used to make mass player creation expensive for bots while costing a
// real browser well under a second (solved in a Web Worker). Pure + isomorphic.
import { sha256 } from "@noble/hashes/sha2.js";

const encoder = new TextEncoder();

/** Number of leading zero bits in a byte array. */
export function leadingZeroBits(bytes: Uint8Array): number {
  let bits = 0;
  for (const b of bytes) {
    if (b === 0) {
      bits += 8;
      continue;
    }
    bits += Math.clz32(b) - 24;
    break;
  }
  return bits;
}

export function powHash(salt: string, nonce: string): Uint8Array {
  return sha256(encoder.encode(`${salt}:${nonce}`));
}

export function checkPow(salt: string, nonce: string, bits: number): boolean {
  if (nonce.length === 0 || nonce.length > 32) return false;
  return leadingZeroBits(powHash(salt, nonce)) >= bits;
}

/**
 * Brute-force a nonce. Yields control every `chunk` attempts via the optional callback
 * (return false from it to abort). Expected attempts ≈ 2^bits.
 */
export function solvePow(
  salt: string,
  bits: number,
  onProgress?: (attempts: number) => boolean | void,
  chunk = 20_000,
): string | null {
  for (let i = 0; i < 2 ** (bits + 8); i++) {
    const nonce = i.toString(36);
    if (leadingZeroBits(powHash(salt, nonce)) >= bits) return nonce;
    if (onProgress && i % chunk === 0 && i > 0 && onProgress(i) === false) return null;
  }
  return null;
}
