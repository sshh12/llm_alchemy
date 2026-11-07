// Web Worker: brute-forces the bootstrap proof-of-work off the main thread.
import { solvePow } from "../../shared/pow.ts";
import type { PowChallenge } from "../../shared/api.ts";

self.onmessage = (e: MessageEvent<PowChallenge>) => {
  const { salt, bits } = e.data;
  self.postMessage({ nonce: solvePow(salt, bits) });
};
