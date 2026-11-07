import { describe, expect, it } from "vitest";
import { computeStreak, plausibleDays, resolveDay, tiersFor, type ChallengeRow } from "./challenges.ts";

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
