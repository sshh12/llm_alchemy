import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ElementRow } from "./dto.ts";
import {
  computeStreak,
  dailyChallenges,
  isTodayTarget,
  plausibleDays,
  resolveDay,
  teaserFor,
  tiersFor,
  type ChallengeRow,
} from "./challenges.ts";

const m = vi.hoisted(() => ({ db: vi.fn() }));
vi.mock("../db.ts", async (orig) => ({
  ...(await orig<typeof import("../db.ts")>()),
  t: (name: string) => `test.${name}`,
  q: (text: string, params: unknown[] = []) => m.db(text, params),
}));

describe("streaks", () => {
  it("counts the run ending today", () => {
    expect(computeStreak(["2026-11-04", "2026-11-05", "2026-11-06"], "2026-11-06")).toEqual({ current: 3, best: 3 });
  });

  it("keeps the streak alive until today is over", () => {
    expect(computeStreak(["2026-11-04", "2026-11-05"], "2026-11-06")).toEqual({ current: 2, best: 2 });
  });

  it("breaks after a missed day and remembers the best run", () => {
    const days = ["2026-10-01", "2026-10-02", "2026-10-03", "2026-10-04", "2026-11-03", "2026-11-04"];
    expect(computeStreak(days, "2026-11-06")).toEqual({ current: 0, best: 4 });
    expect(computeStreak(days, "2026-11-05")).toEqual({ current: 2, best: 4 });
  });

  it("handles empty, duplicate and unsorted input across month ends", () => {
    expect(computeStreak([], "2026-11-06")).toEqual({ current: 0, best: 0 });
    expect(computeStreak(["2026-11-01", "2026-10-31", "2026-11-01"], "2026-11-01")).toEqual({ current: 2, best: 2 });
  });
});

describe("challenge days", () => {
  const now = new Date("2026-11-06T12:00:00Z");

  it("accepts any real local date and falls back to UTC otherwise", () => {
    expect(resolveDay("2026-11-06", now)).toBe("2026-11-06");
    expect(resolveDay("2026-11-07", now)).toBe("2026-11-07"); // UTC+12..14
    expect(resolveDay("2026-11-08", now)).toBe("2026-11-06");
    expect(resolveDay("garbage", now)).toBe("2026-11-06");
    expect(resolveDay(undefined, now)).toBe("2026-11-06");
  });

  it("lists every day that is today somewhere", () => {
    expect(plausibleDays(now)).toEqual(["2026-11-06", "2026-11-07"]);
    expect(plausibleDays(new Date("2026-11-06T11:00:00Z"))).toEqual(["2026-11-05", "2026-11-06", "2026-11-07"]);
  });

  it("finds the tier of a target", () => {
    const c: ChallengeRow = {
      day: "2026-11-06",
      easy_id: "1",
      hard_id: "2",
      expert_id: "3",
      easy_steps: 2,
      hard_steps: 4,
      expert_steps: 6,
    };
    expect(tiersFor(c, "2")).toEqual(["hard"]);
    expect(tiersFor(c, "9")).toEqual([]);
  });
});

describe("tomorrow's teaser", () => {
  const el = (id: string, name: string, ready: boolean): ElementRow => ({
    id,
    name,
    emoji: null,
    description: null,
    notable: false,
    depth: 2,
    steps: 2,
    is_starter: false,
    status: "active",
    image_status: ready ? "ready" : "none",
    image_key: ready ? "k1" : null,
  });
  const day = (d: string, easy: string): ChallengeRow => ({
    day: d,
    easy_id: easy,
    hard_id: `${easy}2`,
    expert_id: `${easy}3`,
    easy_steps: 2,
    hard_steps: 4,
    expert_steps: 6,
  });

  beforeEach(() => {
    m.db.mockReset();
  });

  it("shows art only when ready and counts letters without spaces", () => {
    expect(teaserFor(el("5", "Hot Air Balloon", true))).toEqual({ img: "/img/5/k1", letters: 13 });
    expect(teaserFor(el("5", "Steam", false))).toEqual({ img: null, letters: 5 });
    expect(Object.keys(teaserFor(el("5", "Steam", true))).sort()).toEqual(["img", "letters"]); // never the name or id
  });

  it("reads today's targets and tomorrow's easy target in one element query", async () => {
    const rows: Record<string, ChallengeRow> = { "2031-01-10": day("2031-01-10", "10"), "2031-01-11": day("2031-01-11", "20") };
    const elements = [el("10", "Mud", true), el("102", "Brick", false), el("103", "House", false), el("20", "Rain Cloud", true)];
    m.db.mockImplementation(async (sql: string, params: unknown[]) => {
      if (sql.includes("FROM test.challenges")) return rows[String(params[0])] ? [rows[String(params[0])]] : [];
      if (sql.includes("FROM test.elements")) return elements.filter((e) => (params[0] as string[]).includes(e.id));
      if (sql.includes("challenge_completions")) return [{ tier: "easy" }];
      throw new Error(`unexpected ${sql}`);
    });
    const r = await dailyChallenges("7", "2031-01-10");
    expect(r.challenge?.targets.map((t) => [t.tier, t.element.name, t.completed])).toEqual([
      ["easy", "Mud", true],
      ["hard", "Brick", false],
      ["expert", "House", false],
    ]);
    expect(r.tomorrow).toEqual({ img: "/img/20/k1", letters: 9 });
    const elementQueries = m.db.mock.calls.filter((c) => String(c[0]).includes("FROM test.elements"));
    expect(elementQueries).toHaveLength(1);
    expect(elementQueries[0]![1]).toEqual([["10", "102", "103", "20"]]);
  });

  it("has no teaser without a row for tomorrow, and no challenge without one for today", async () => {
    m.db.mockImplementation(async (sql: string, params: unknown[]) => {
      if (sql.includes("FROM test.challenges")) return params[0] === "2031-02-02" ? [day("2031-02-02", "30")] : [];
      if (sql.includes("FROM test.elements")) return [el("30", "Lava", false)];
      return [];
    });
    expect(await dailyChallenges("7", "2031-02-01")).toEqual({ challenge: null, tomorrow: { img: null, letters: 4 } });
    expect(await dailyChallenges("7", "2031-02-05")).toEqual({ challenge: null, tomorrow: null });
    expect(m.db.mock.calls.some((c) => String(c[0]).includes("challenge_completions"))).toBe(false);
  });
});

describe("today's targets", () => {
  it("are any target of a day that is today somewhere", async () => {
    const now = new Date("2031-03-01T12:00:00Z"); // 03-01 and 03-02 are today somewhere
    m.db.mockImplementation(async (_sql: string, params: unknown[]) =>
      params[0] === "2031-03-02"
        ? [{ day: "2031-03-02", easy_id: "1", hard_id: "2", expert_id: "3", easy_steps: 2, hard_steps: 4, expert_steps: 6 }]
        : [],
    );
    expect(await isTodayTarget("3", now)).toBe(true);
    expect(await isTodayTarget("4", now)).toBe(false);
  });
});
