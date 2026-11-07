import { beforeAll, describe, expect, it } from "vitest";
import { solvePow } from "../src/shared/pow.ts";
import { POW_TTL_MS, checkPowSolution, issuePow } from "./pow.ts";

beforeAll(() => {
  process.env.SESSION_SECRET = "test-secret-".padEnd(48, "x");
  process.env.POW_BITS = "8";
});

describe("proof of work", () => {
  it("issues signed salts with the configured difficulty", () => {
    const c = issuePow();
    expect(c.bits).toBe(8);
    expect(c.salt.split(".")).toHaveLength(3);
    expect(issuePow().salt).not.toBe(c.salt);
  });

  it("accepts a valid fresh solution", () => {
    const now = 1_790_000_000_000;
    const { salt, bits } = issuePow(now);
    const nonce = solvePow(salt, bits)!;
    expect(checkPowSolution({ salt, nonce }, now + 1_000)).toBe("ok");
  });

  it("rejects insufficient work", () => {
    const { salt } = issuePow();
    // Find a nonce that does NOT meet 8 bits (most do).
    let bad = 0;
    while (checkPowSolution({ salt, nonce: bad.toString(36) }) === "ok") bad++;
    expect(checkPowSolution({ salt, nonce: bad.toString(36) })).toBe("insufficient");
  });

  it("rejects expired, future and forged salts", () => {
    const now = 1_790_000_000_000;
    const { salt, bits } = issuePow(now);
    const nonce = solvePow(salt, bits)!;
    expect(checkPowSolution({ salt, nonce }, now + POW_TTL_MS + 1)).toBe("expired");
    expect(checkPowSolution({ salt, nonce }, now - 5 * 60_000)).toBe("expired");
    const [ts, rand, sig] = salt.split(".") as [string, string, string];
    const forged = `${(now + 1).toString(36)}.${rand}.${sig}`;
    expect(checkPowSolution({ salt: forged, nonce }, now)).toBe("bad_signature");
    expect(checkPowSolution({ salt: `${ts}.${rand}`, nonce }, now)).toBe("malformed");
    expect(checkPowSolution({ salt, nonce: "" }, now)).toBe("insufficient");
  });
});
