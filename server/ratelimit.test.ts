import { beforeEach, describe, expect, it, vi } from "vitest";
import { BUDGETS, LIMITS, counterKey, evaluate, hit, windowOf, type Limit } from "./ratelimit.ts";

// An in-memory counters table behind the upsert hit() sends.
const db = vi.hoisted(() => ({ counts: new Map<string, number>(), statements: [] as string[][] }));
vi.mock("./db.ts", () => ({
  t: (name: string) => `test.${name}`,
  q: async (_sql: string, [keys, costs]: [string[], number[]]) => {
    db.statements.push(keys);
    return keys.map((key, i) => {
      db.counts.set(key, (db.counts.get(key) ?? 0) + costs[i]!);
      return { key, count: String(db.counts.get(key)) };
    });
  },
}));

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

describe("hit", () => {
  const now = Date.parse("2026-11-07T12:00:00Z");
  const player = { limit: { name: "p", limit: 2, windowMs: MIN }, subject: "p1" };
  const budget = { limit: { name: "budget.x", limit: 100, windowMs: 24 * 60 * MIN }, subject: "all" };
  const budgetCount = () => db.counts.get(counterKey(budget.limit, "all", now)) ?? 0;

  beforeEach(() => {
    db.counts.clear();
    db.statements.length = 0;
  });

  it("charges a global budget only after the per-subject limits pass", async () => {
    expect(await hit([player, budget], now)).toEqual({ ok: true });
    expect(await hit([player, budget], now)).toEqual({ ok: true });
    expect(budgetCount()).toBe(2);
    // Over the per-player limit: rejected, and the budget is untouched (however often it repeats).
    for (let i = 0; i < 5; i++) expect(await hit([player, budget], now)).toMatchObject({ ok: false, limit: player.limit });
    expect(budgetCount()).toBe(2);
    expect(db.counts.get(counterKey(player.limit, "p1", now))).toBe(7);
  });

  it("uses one statement unless budgets and local limits are mixed", async () => {
    await hit([player], now);
    await hit([budget], now);
    expect(db.statements).toHaveLength(2);
    await hit([player, budget], now);
    expect(db.statements.slice(2)).toEqual([[counterKey(player.limit, "p1", now)], [counterKey(budget.limit, "all", now)]]);
  });

  it("reports an exhausted budget", async () => {
    const tight = { limit: { ...budget.limit, limit: 1 }, subject: "all" };
    await hit([player, tight], now);
    expect(await hit([{ ...player, subject: "p2" }, tight], now)).toMatchObject({ ok: false, limit: tight.limit });
  });

  it("treats every BUDGETS entry as a global budget", () => {
    for (const b of [BUDGETS.llm, BUDGETS.image, BUDGETS.imageMonth, BUDGETS.players, BUDGETS.jev]) {
      expect(b.name).toMatch(/^budget\./);
    }
    for (const l of Object.values(LIMITS)) expect(l.name).not.toMatch(/^budget\./);
  });

  it("charges weighted sort costs, and the Jev budget only after the sort item limits pass", async () => {
    const cost = 1_500;
    const sortHits = [
      { limit: LIMITS.sortItemsPlayerHour, subject: "p9", cost },
      { limit: LIMITS.sortItemsIpDay, subject: "ip9", cost },
      { limit: BUDGETS.jev, subject: "all", cost },
    ];
    expect(await hit(sortHits, now)).toEqual({ ok: true });
    expect(db.counts.get(counterKey(BUDGETS.jev, "all", now))).toBe(cost);
    // 200,000 / 1,500 → the 134th request breaks the hourly item limit and must not reach the budget.
    for (let i = 1; i < 133; i++) await hit(sortHits, now);
    expect(await hit(sortHits, now)).toMatchObject({ ok: false, limit: LIMITS.sortItemsPlayerHour });
    expect(db.counts.get(counterKey(BUDGETS.jev, "all", now))).toBe(133 * cost);
    expect(BUDGETS.jev).toMatchObject({ limit: 2_500_000, windowMs: 86_400_000 });
  });
});
