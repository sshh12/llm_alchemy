import { describe, expect, it } from "vitest";
import { LIMITS, counterKey, evaluate, windowOf, type Limit } from "./ratelimit.ts";

const MIN = 60_000;
const lim = (limit: number, windowMs = MIN): Limit => ({ name: "t", limit, windowMs });

describe("fixed windows", () => {
  it("aligns windows to the epoch", () => {
    expect(windowOf(0, MIN)).toEqual({ index: 0, startsAt: 0, endsAt: MIN });
    expect(windowOf(MIN - 1, MIN).index).toBe(0);
    expect(windowOf(MIN, MIN).index).toBe(1);
    // Daily windows are UTC days.
    const day = 86_400_000;
    const t = Date.parse("2026-11-06T23:59:59Z");
    expect(new Date(windowOf(t, day).startsAt).toISOString()).toBe("2026-11-06T00:00:00.000Z");
    expect(new Date(windowOf(t, day).endsAt).toISOString()).toBe("2026-11-07T00:00:00.000Z");
  });

  it("changes keys per window and per subject", () => {
    const l = lim(5);
    expect(counterKey(l, "p1", 10)).toBe(counterKey(l, "p1", MIN - 1));
    expect(counterKey(l, "p1", 10)).not.toBe(counterKey(l, "p1", MIN));
    expect(counterKey(l, "p1", 10)).not.toBe(counterKey(l, "p2", 10));
  });

  it("allows up to the limit and reports time to reset", () => {
    const l = lim(3);
    const now = 5 * MIN + 15_000;
    const key = counterKey(l, "s", now);
    expect(evaluate([{ limit: l, subject: "s" }], new Map([[key, 3]]), now)).toEqual({ ok: true });
    expect(evaluate([{ limit: l, subject: "s" }], new Map([[key, 4]]), now)).toEqual({
      ok: false,
      limit: l,
      retryAfterMs: 45_000,
    });
  });

  it("reports the longest wait among violated limits", () => {
    const short = { name: "a", limit: 1, windowMs: MIN };
    const long = { name: "b", limit: 1, windowMs: 60 * MIN };
    const now = 30_000;
    const counts = new Map([
      [counterKey(short, "s", now), 2],
      [counterKey(long, "s", now), 2],
    ]);
    const r = evaluate([{ limit: short, subject: "s" }, { limit: long, subject: "s" }], counts, now);
    expect(r).toMatchObject({ ok: false, limit: long, retryAfterMs: 60 * MIN - 30_000 });
  });

  it("never asks to retry in under a second", () => {
    const l = lim(0);
    const now = MIN - 1;
    const r = evaluate([{ limit: l, subject: "s" }], new Map([[counterKey(l, "s", now), 1]]), now);
    expect(r).toMatchObject({ ok: false, retryAfterMs: 1_000 });
  });

  it("has unique rule names", () => {
    const names = Object.values(LIMITS).map((l) => l.name);
    expect(new Set(names).size).toBe(names.length);
  });
});
