import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  ART_PACE,
  BUDGETS,
  LIMITS,
  allowedAt,
  bumpStat,
  counterKey,
  dayTrafficShare,
  enforce,
  evaluate,
  hit,
  imageBudgets,
  windowOf,
  type Limit,
} from "./ratelimit.ts";

// An in-memory counters table behind the statements hit() and bumpStat() send: the multi-row
// upsert (keys, costs, expiries), the refund UPDATE (keys, costs) and the single-row stat upsert.
const db = vi.hoisted(() => ({
  counts: new Map<string, number>(),
  expires: new Map<string, string>(),
  /** Keys of each charging upsert, in order. */
  statements: [] as string[][],
  refunds: [] as string[][],
}));
vi.mock("./db.ts", () => ({
  t: (name: string) => `test.${name}`,
  q: async (sql: string, params: unknown[]) => {
    if (/^\s*UPDATE/.test(sql)) {
      const [keys, costs] = params as [string[], number[]];
      db.refunds.push(keys);
      keys.forEach((k, i) => db.counts.has(k) && db.counts.set(k, db.counts.get(k)! - costs[i]!));
      return [];
    }
    if (/VALUES \(\$1, \$2, \$3\)/.test(sql)) {
      const [key, n, expiresAt] = params as [string, number, string];
      db.counts.set(key, (db.counts.get(key) ?? 0) + n);
      db.expires.set(key, expiresAt);
      return [];
    }
    const [keys, costs, expiries] = params as [string[], number[], string[]];
    db.statements.push(keys);
    // ON CONFLICT keeps the stored expiry unless the statement moves it (to the later of the two).
    const extends_ = /expires_at = greatest\(c\.expires_at, excluded\.expires_at\)/.test(sql);
    return keys.map((key, i) => {
      const prev = db.expires.get(key);
      db.counts.set(key, (db.counts.get(key) ?? 0) + costs[i]!);
      if (prev === undefined) db.expires.set(key, expiries[i]!);
      else if (extends_ && Date.parse(expiries[i]!) > Date.parse(prev)) db.expires.set(key, expiries[i]!);
      return { key, count: String(db.counts.get(key)) };
    });
  },
}));

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
const lim = (limit: number, windowMs = MIN): Limit => ({ name: "t", limit, windowMs });
const stat = (name: string, nowMs: number) => db.counts.get(`stat:${name}:${Math.floor(nowMs / DAY)}`) ?? 0;

beforeEach(() => {
  db.counts.clear();
  db.expires.clear();
  db.statements.length = 0;
  db.refunds.length = 0;
  delete process.env.IMAGE_DAILY_CAP;
  delete process.env.IMAGE_MONTHLY_CAP;
});

describe("fixed windows", () => {
  it("aligns windows to the epoch", () => {
    expect(windowOf(0, MIN)).toEqual({ index: 0, startsAt: 0, endsAt: MIN });
    expect(windowOf(MIN - 1, MIN).index).toBe(0);
    expect(windowOf(MIN, MIN).index).toBe(1);
    // Daily windows are UTC days.
    const t = Date.parse("2026-11-06T23:59:59Z");
    expect(new Date(windowOf(t, DAY).startsAt).toISOString()).toBe("2026-11-06T00:00:00.000Z");
    expect(new Date(windowOf(t, DAY).endsAt).toISOString()).toBe("2026-11-07T00:00:00.000Z");
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
  const playerHour = { limit: { name: "p.hour", limit: 100, windowMs: HOUR }, subject: "p1" };
  const budget = { limit: { name: "budget.x", limit: 100, windowMs: DAY }, subject: "all" };
  const count = (h: { limit: Limit; subject: string }) => db.counts.get(counterKey(h.limit, h.subject, now)) ?? 0;

  it("charges a global budget only after the per-subject limits pass", async () => {
    expect(await hit([player, budget], now)).toEqual({ ok: true });
    expect(await hit([player, budget], now)).toEqual({ ok: true });
    expect(count(budget)).toBe(2);
    // Over the per-player limit: rejected, and the budget is untouched (however often it repeats).
    for (let i = 0; i < 5; i++) expect(await hit([player, budget], now)).toMatchObject({ ok: false, limit: player.limit });
    expect(count(budget)).toBe(2);
    expect(count(player)).toBe(7); // the violated rule keeps every attempt: hammering stays limited
  });

  it("refunds the other local limits when one is violated, so a minute throttle never becomes an hour lock", async () => {
    await hit([player, playerHour], now);
    await hit([player, playerHour], now);
    for (let i = 0; i < 10; i++) expect(await hit([player, playerHour], now)).toMatchObject({ ok: false, limit: player.limit });
    expect(count(player)).toBe(12);
    expect(count(playerHour)).toBe(2);
    expect(db.refunds).toHaveLength(10);
    expect(db.refunds[0]).toEqual([counterKey(playerHour.limit, "p1", now)]);
  });

  it("refunds every counter of a request a global budget rejects", async () => {
    const tight = { limit: { ...budget.limit, limit: 1 }, subject: "all" };
    expect(await hit([player, playerHour, tight], now)).toEqual({ ok: true });
    const other = [
      { ...player, subject: "p2" },
      { ...playerHour, subject: "p2" },
    ];
    expect(await hit([...other, tight], now)).toMatchObject({ ok: false, limit: tight.limit });
    expect(count(tight)).toBe(1);
    expect(other.map(count)).toEqual([0, 0]); // per-player caps count only served requests
  });

  it("with two budgets and the first exhausted, leaves the second unchanged", async () => {
    const day = { limit: { name: "budget.d", limit: 1, windowMs: DAY }, subject: "all" };
    const month = { limit: { name: "budget.m", limit: 1_000, windowMs: 30 * DAY }, subject: "all" };
    expect(await hit([player, day, month], now)).toEqual({ ok: true });
    for (let i = 0; i < 3; i++) expect(await hit([{ ...player, subject: `q${i}` }, day, month], now)).toMatchObject({ ok: false, limit: day.limit });
    expect(count(month)).toBe(1); // no phantom monthly charges from daily-cap denials
    expect(count(day)).toBe(1);
  });

  it("refunds weighted costs", async () => {
    const items = { limit: { name: "items", limit: 1_000, windowMs: HOUR }, subject: "p1" };
    const jev = { limit: { name: "budget.j", limit: 2_500, windowMs: DAY }, subject: "all" };
    expect(await hit([{ ...items, cost: 900 }, { ...jev, cost: 900 }], now)).toEqual({ ok: true });
    expect(await hit([{ ...items, subject: "p2", cost: 900 }, { ...jev, cost: 900 }], now)).toEqual({ ok: true });
    expect(await hit([{ ...items, subject: "p3", cost: 900 }, { ...jev, cost: 900 }], now)).toMatchObject({ ok: false, limit: jev.limit });
    expect(count(jev)).toBe(1_800);
    expect(count({ ...items, subject: "p3" })).toBe(0);
  });

  it("uses one statement unless budgets and local limits are mixed", async () => {
    await hit([player], now);
    await hit([budget], now);
    expect(db.statements).toHaveLength(2);
    await hit([player, budget], now);
    expect(db.statements.slice(2)).toEqual([[counterKey(player.limit, "p1", now)], [counterKey(budget.limit, "all", now)]]);
    expect(db.refunds).toHaveLength(0); // refunds only on the denial path
  });

  it("reports an exhausted budget", async () => {
    const tight = { limit: { ...budget.limit, limit: 1 }, subject: "all" };
    await hit([player, tight], now);
    expect(await hit([{ ...player, subject: "p2" }, tight], now)).toMatchObject({ ok: false, limit: tight.limit });
  });

  it("counts every denial under its rule's daily stat", async () => {
    const tight = { limit: { ...budget.limit, name: "budget.tight", limit: 1 }, subject: "all" };
    await hit([player, tight], now);
    await hit([{ ...player, subject: "p2" }, tight], now); // budget denial
    await hit([player], now);
    await hit([player], now); // local denial
    expect(stat("denied:budget.tight", now)).toBe(1);
    expect(stat("denied:p", now)).toBe(1);
  });

  it("keeps global budget rows 90 days past their window, local rows a minute", async () => {
    await hit([player, budget], now);
    expect(db.expires.get(counterKey(budget.limit, "all", now))).toBe(new Date(windowOf(now, DAY).endsAt + 90 * DAY).toISOString());
    expect(db.expires.get(counterKey(player.limit, "p1", now))).toBe(new Date(windowOf(now, MIN).endsAt + MIN).toISOString());
  });

  it("gives a budget row written before the 90-day history its history expiry on the next charge", async () => {
    const key = counterKey(budget.limit, "all", now);
    const { endsAt } = windowOf(now, DAY);
    db.counts.set(key, 40);
    db.expires.set(key, new Date(endsAt + MIN).toISOString()); // the old "window end + 1 min"
    await hit([player, budget], now);
    expect(db.counts.get(key)).toBe(41);
    expect(db.expires.get(key)).toBe(new Date(endsAt + 90 * DAY).toISOString());
    // Never moved earlier.
    db.expires.set(key, new Date(endsAt + 100 * DAY).toISOString());
    await hit([{ ...player, subject: "p2" }, budget], now);
    expect(db.expires.get(key)).toBe(new Date(endsAt + 100 * DAY).toISOString());
  });

  it("treats every BUDGETS entry as a global budget", () => {
    for (const b of [BUDGETS.llm, BUDGETS.image, BUDGETS.imageMonth, BUDGETS.players, BUDGETS.jev, ...imageBudgets("fresh")]) {
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
    // 50,000 / 1,500 → the 34th request breaks the hourly item limit and must not reach the budget.
    for (let i = 1; i < 33; i++) await hit(sortHits, now);
    expect(await hit(sortHits, now)).toMatchObject({ ok: false, limit: LIMITS.sortItemsPlayerHour });
    expect(db.counts.get(counterKey(BUDGETS.jev, "all", now))).toBe(33 * cost);
    expect(db.counts.get(counterKey(LIMITS.sortItemsIpDay, "ip9", now))).toBe(33 * cost); // refunded
    expect(BUDGETS.jev).toMatchObject({ limit: 2_500_000, windowMs: 86_400_000 });
  });

  it("enforce names the tripped rule", async () => {
    await enforce([player], now);
    await enforce([player], now);
    await expect(enforce([player], now)).rejects.toMatchObject({ status: 429, extra: { limit: "p" } });
    const tight = { limit: { ...budget.limit, limit: 0 }, subject: "all" };
    await expect(enforce([tight], now)).rejects.toMatchObject({ status: 503, code: "budget_exhausted", extra: { limit: "budget.x" } });
  });
});

describe("bumpStat", () => {
  it("adds to a per-UTC-day key kept 90 days", async () => {
    const now = Date.parse("2026-11-22T20:00:00Z");
    await bumpStat("fizzle:validation", 1, now);
    await bumpStat("fizzle:validation", 2, now);
    const key = `stat:fizzle:validation:${Math.floor(now / DAY)}`;
    expect(db.counts.get(key)).toBe(3);
    expect(db.expires.get(key)).toBe("2027-02-21T00:00:00.000Z");
  });
});

describe("art pacing", () => {
  const at = (iso: string) => Date.parse(iso);
  const [freshDay, freshMonth] = imageBudgets("fresh") as [Limit, Limit];
  const [backlogDay, backlogMonth] = imageBudgets("backlog") as [Limit, Limit];

  it("shares the un-paced budgets' counters across both lanes", () => {
    const now = at("2026-11-23T15:00:00Z");
    for (const [paced, base] of [
      [freshDay, BUDGETS.image],
      [backlogDay, BUDGETS.image],
      [freshMonth, BUDGETS.imageMonth],
      [backlogMonth, BUDGETS.imageMonth],
    ] as const) {
      expect(counterKey(paced, "all", now)).toBe(counterKey(base, "all", now));
    }
  });

  it("weights the daily allowance by when players discover things", () => {
    expect(dayTrafficShare(at("2026-11-23T00:00:00Z"))).toBe(0);
    expect(dayTrafficShare(at("2026-11-23T01:00:00Z"))).toBeCloseTo(0.03, 6);
    expect(dayTrafficShare(at("2026-11-23T00:30:00Z"))).toBeCloseTo(0.015, 6); // linear within the hour
    expect(dayTrafficShare(at("2026-11-23T12:00:00Z"))).toBeCloseTo(0.28, 6);
    expect(dayTrafficShare(at("2026-11-23T21:00:00Z"))).toBeCloseTo(0.911, 6);
    expect(dayTrafficShare(at("2026-11-23T23:59:59.999Z"))).toBeCloseTo(1, 4);
    // Fresh may run 10% of the cap ahead of pace: ~38% of 2,000 by 12:00 UTC; backlog 5% behind.
    const noon = at("2026-11-23T12:00:00Z");
    expect(allowedAt(freshDay, noon)).toBeCloseTo(760, 6);
    expect(allowedAt(backlogDay, noon)).toBeCloseTo(460, 6);
    expect(allowedAt(freshDay, at("2026-11-23T23:00:00Z"))).toBe(2_000);
    expect(allowedAt(backlogDay, at("2026-11-23T00:30:00Z"))).toBe(0); // backlog waits for the day's traffic
    expect(ART_PACE.fresh.dayLead).toBe(0.1);
  });

  it("accrues a 40,000 monthly budget at ~1,333 a day", () => {
    const start = windowOf(at("2026-11-23T00:00:00Z"), 30 * DAY).startsAt;
    expect(new Date(start).toISOString()).toBe("2026-11-03T00:00:00.000Z");
    expect(allowedAt(backlogMonth, start + DAY) - allowedAt(backlogMonth, start)).toBeCloseTo(1_333.33, 1);
    expect(allowedAt(freshMonth, start)).toBeCloseTo(1_333.33, 1); // one day ahead
    expect(allowedAt(backlogMonth, start + 30 * DAY - 1)).toBeCloseTo(40_000, 0);
  });

  it("lets fresh art through at 01:00 UTC 11-23 with a 55,000 cap and 34,800 spent", async () => {
    process.env.IMAGE_MONTHLY_CAP = "55000";
    const now = at("2026-11-23T01:00:00Z");
    db.counts.set(counterKey(BUDGETS.imageMonth, "all", now), 34_800);
    db.counts.set(counterKey(BUDGETS.image, "all", now), 150);
    // Fresh: 55,000 × 21.04 / 30 ≈ 38,580 by now; daily 2,000 × (3% + 10%) = 260.
    expect(await hit(imageBudgets("fresh").map((limit) => ({ limit, subject: "all" })), now)).toEqual({ ok: true });
    expect(db.counts.get(counterKey(BUDGETS.imageMonth, "all", now))).toBe(34_801);
    // Backlog is behind on the day (2,000 × (3% − 5%) < 0) and is deferred by pace, not budget.
    const r = await hit(imageBudgets("backlog").map((limit) => ({ limit, subject: "all" })), now);
    expect(r).toMatchObject({ ok: false, limit: { name: "budget.image" }, paced: true });
    expect(db.counts.get(counterKey(BUDGETS.imageMonth, "all", now))).toBe(34_801); // refunded
    expect(db.counts.get(counterKey(BUDGETS.image, "all", now))).toBe(151);
  });

  it("defers a 40,000 monthly budget's backlog by pace until the accrual catches up", () => {
    const now = at("2026-11-23T01:00:00Z");
    const key = counterKey(BUDGETS.imageMonth, "all", now);
    // 40,000 × 20.04 / 30 ≈ 26,722 accrued: a count of 26,800 waits ~78 / 1,333 days ≈ 1.4 h.
    const r = evaluate([{ limit: backlogMonth, subject: "all" }], new Map([[key, 26_800]]), now);
    expect(r).toMatchObject({ ok: false, paced: true });
    if (r.ok) throw new Error("unreachable");
    expect(r.retryAfterMs / HOUR).toBeCloseTo(1.4, 1);
    // Over the cap itself: a plain budget denial until the window ends.
    const spent = evaluate([{ limit: freshMonth, subject: "all" }], new Map([[key, 40_001]]), now);
    expect(spent).toEqual({ ok: false, limit: freshMonth, retryAfterMs: at("2026-12-03T00:00:00Z") - now });
  });

  it("retries a paced daily denial when the allowance reaches the count, at least a minute out", () => {
    const now = at("2026-11-23T12:00:00Z");
    const key = counterKey(BUDGETS.image, "all", now);
    // Fresh allowance at 12:00 is 760 and grows 2,000 × 3% = 60/h in 12-13 UTC: 800 at 12:40.
    const r = evaluate([{ limit: freshDay, subject: "all" }], new Map([[key, 800]]), now);
    if (r.ok) throw new Error("expected a denial");
    expect(r.paced).toBe(true);
    expect(r.retryAfterMs / MIN).toBeCloseTo(40, 0);
    // 761 is reached 30 s after 12:00:30, but a paced retry is never hinted under a minute.
    const soon = evaluate([{ limit: freshDay, subject: "all" }], new Map([[key, 761]]), now + 30_000);
    expect(soon).toMatchObject({ ok: false, retryAfterMs: MIN });
    // Backlog never reaches 96% of the cap today: retry at the day's end.
    const late = at("2026-11-23T23:30:00Z");
    const never = evaluate([{ limit: backlogDay, subject: "all" }], new Map([[counterKey(BUDGETS.image, "all", late), 1_950]]), late);
    expect(never).toMatchObject({ ok: false, paced: true, retryAfterMs: 30 * MIN });
  });

  it("follows a cap change at once (IMAGE_MONTHLY_CAP read lazily)", () => {
    const now = at("2026-11-23T01:00:00Z");
    const before = allowedAt(imageBudgets("backlog")[1]!, now);
    process.env.IMAGE_MONTHLY_CAP = "55000";
    expect(allowedAt(imageBudgets("backlog")[1]!, now) / before).toBeCloseTo(55 / 40, 6);
  });
});
