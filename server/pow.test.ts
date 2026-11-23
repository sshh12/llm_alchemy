import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { solvePow } from "../src/shared/pow.ts";
import { POW_TTL_MS, checkPowSolution, issuePow, latencyBand, powIssuedAt, recordPowIssued, recordPowRedeemed } from "./pow.ts";

const m = vi.hoisted(() => ({ bumpStat: vi.fn(async (_name: string, _n?: number, _nowMs?: number) => {}) }));
vi.mock("./ratelimit.ts", async (orig) => ({ ...(await orig<typeof import("./ratelimit.ts")>()), bumpStat: m.bumpStat }));

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

describe("PoW funnel stats", () => {
  beforeEach(() => {
    m.bumpStat.mockClear();
  });

  it("reads the issue time back out of a salt", () => {
    const now = 1_790_000_000_000;
    expect(powIssuedAt(issuePow(now).salt)).toBe(now);
    expect(powIssuedAt("not a salt")).toBeNull();
  });

  it("bands latency", () => {
    expect([-50, 0, 1_999, 2_000, 3_999, 4_000, 8_000, 15_000, 29_999, 30_000, 600_000, Number.NaN].map(latencyBand)).toEqual([
      "<2s",
      "<2s",
      "<2s",
      "2-4s",
      "2-4s",
      "4-8s",
      "8-15s",
      "15-30s",
      "15-30s",
      "30s+",
      "30s+",
      "<2s",
    ]);
  });

  it("counts issued challenges by audience", async () => {
    await recordPowIssued("chromeos");
    await recordPowIssued("bot");
    await recordPowIssued(undefined);
    expect(m.bumpStat.mock.calls.map((c) => c[0])).toEqual(["pow:issued:browser", "pow:issued:bot", "pow:issued:browser"]);
  });

  it("counts a redemption with its issue-to-redeem latency", async () => {
    const issued = 1_790_000_000_000;
    const { salt } = issuePow(issued);
    await recordPowRedeemed({ salt, nonce: "x" }, "ios", issued + 9_500);
    expect(m.bumpStat.mock.calls.map((c) => c[0]).sort()).toEqual(["pow:latency:8-15s", "pow:redeemed:browser"]);
  });
});
