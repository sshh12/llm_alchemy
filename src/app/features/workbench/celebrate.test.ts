import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiFailure } from "../../lib/api.ts";
import { chooseCelebration, combineFailedParams, FollowupTracker, retryBucket } from "./celebrate.ts";

describe("chooseCelebration", () => {
  const never = () => {
    throw new Error("must not draw");
  };

  it("always shows the card for the session's first, notable, epic and legendary firsts, without a draw", () => {
    expect(chooseCelebration({ sessionFirst: true, notable: false, rarity: "common" }, never)).toEqual({ kind: "card", reason: "session_first" });
    expect(chooseCelebration({ sessionFirst: false, notable: true, rarity: "common" }, never)).toEqual({ kind: "card", reason: "notable" });
    expect(chooseCelebration({ sessionFirst: false, notable: false, rarity: "epic" }, never)).toEqual({ kind: "card", reason: "rare" });
    expect(chooseCelebration({ sessionFirst: false, notable: false, rarity: "legendary" }, never)).toEqual({ kind: "card", reason: "rare" });
  });

  it("the session's first wins over the other reasons", () => {
    expect(chooseCelebration({ sessionFirst: true, notable: true, rarity: "legendary" }, never).reason).toBe("session_first");
  });

  it("draws 50/50 for every other first", () => {
    for (const rarity of ["common", "uncommon", "rare"] as const) {
      expect(chooseCelebration({ sessionFirst: false, notable: false, rarity }, () => 0.49)).toEqual({ kind: "card", reason: "random_card" });
      expect(chooseCelebration({ sessionFirst: false, notable: false, rarity }, () => 0.5)).toEqual({ kind: "toast", reason: "random_toast" });
    }
  });
});

describe("FollowupTracker", () => {
  let now = 0;
  let sent: Record<string, unknown>[] = [];
  let t: FollowupTracker;
  beforeEach(() => {
    vi.useFakeTimers();
    now = 1_000;
    sent = [];
    t = new FollowupTracker((p) => sent.push(p), () => now);
  });
  afterEach(() => vi.useRealTimers());

  it("a combine within 60 s settles it as continued", () => {
    t.start({ kind: "toast", reason: "random_toast" });
    now += 12_000;
    t.combine();
    expect(sent).toEqual([{ kind: "toast", reason: "random_toast", cont60: true, via: "combine" }]);
    // Once per first: later combines and the timer send nothing more.
    t.combine();
    vi.advanceTimersByTime(120_000);
    expect(sent).toHaveLength(1);
  });

  it("no combine for 60 s sends cont60 false from the timer", () => {
    t.start({ kind: "card", reason: "random_card" });
    now += 60_000;
    vi.advanceTimersByTime(60_000);
    expect(sent).toEqual([{ kind: "card", reason: "random_card", cont60: false, via: "timer" }]);
  });

  it("a combine arriving after the window (timer throttled) is not a continuation", () => {
    t.start({ kind: "card", reason: "random_card" });
    now += 75_000;
    t.combine();
    expect(sent).toEqual([{ kind: "card", reason: "random_card", cont60: false, via: "combine" }]);
  });

  it("hiding the page first settles it as not continued", () => {
    t.start({ kind: "card", reason: "session_first" });
    now += 5_000;
    t.hidden();
    expect(sent).toEqual([{ kind: "card", reason: "session_first", cont60: false, via: "hidden" }]);
    expect(t.active).toBe(false);
  });

  it("nothing pending: combine and hidden are no-ops", () => {
    t.combine();
    t.hidden();
    expect(sent).toEqual([]);
  });

  it("overlapping merges: a second world-first doesn't settle the first; the next combine settles both", () => {
    // Two pairs dropped back to back: both combines started before either result came back.
    t.combine();
    t.combine();
    t.start({ kind: "card", reason: "session_first" });
    now += 1_000;
    t.start({ kind: "toast", reason: "random_toast" });
    expect(sent).toEqual([]); // no combine has started after either yet
    expect(t.active).toBe(true);
    now += 10_000;
    t.combine();
    expect(sent).toEqual([
      { kind: "card", reason: "session_first", cont60: true, via: "combine" },
      { kind: "toast", reason: "random_toast", cont60: true, via: "combine" },
    ]);
    expect(t.active).toBe(false);
    vi.advanceTimersByTime(120_000);
    expect(sent).toHaveLength(2);
  });

  it("overlapping world-firsts with no combine after them each time out on their own", () => {
    t.start({ kind: "card", reason: "session_first" });
    now += 20_000;
    vi.advanceTimersByTime(20_000);
    t.start({ kind: "toast", reason: "random_toast" });
    now += 40_000;
    vi.advanceTimersByTime(40_000);
    expect(sent).toEqual([{ kind: "card", reason: "session_first", cont60: false, via: "timer" }]);
    t.hidden(); // the player leaves: the second is not continued either
    expect(sent.at(-1)).toEqual({ kind: "toast", reason: "random_toast", cont60: false, via: "hidden" });
    expect(t.active).toBe(false);
  });
});

describe("combine_failed params", () => {
  it("buckets the retry hint", () => {
    expect(retryBucket(undefined)).toBeUndefined();
    expect(retryBucket(-1)).toBeUndefined();
    expect(retryBucket(0)).toBe("<5");
    expect(retryBucket(4_999)).toBe("<5");
    expect(retryBucket(5_000)).toBe("5-30");
    expect(retryBucket(29_999)).toBe("5-30");
    expect(retryBucket(30_000)).toBe("30-120");
    expect(retryBucket(120_000)).toBe("120+");
  });

  it("names the rule, platform for a bare 429, and the retry bucket", () => {
    expect(combineFailedParams(new ApiFailure("rate_limited", "x", 429, 20_000, undefined, "combine.player"))).toEqual({
      code: "rate_limited",
      limit: "combine.player",
      retry_s: "5-30",
    });
    expect(combineFailedParams(new ApiFailure("rate_limited", "x", 429, 3_000, undefined, "platform"))).toEqual({
      code: "rate_limited",
      limit: "platform",
      retry_s: "<5",
    });
    // A 429 without a limit field still reads as the platform rule.
    expect(combineFailedParams(new ApiFailure("rate_limited", "x", 429))).toEqual({ code: "rate_limited", limit: "platform" });
    expect(combineFailedParams(new ApiFailure("budget_exhausted", "x", 503, 600_000, undefined, "budget.llm"))).toEqual({
      code: "budget_exhausted",
      limit: "budget.llm",
      retry_s: "120+",
    });
    expect(combineFailedParams(new ApiFailure("fizzled", "x", 422))).toEqual({ code: "fizzled" });
    expect(combineFailedParams(new Error("boom"))).toEqual({ code: "network" });
  });
});
