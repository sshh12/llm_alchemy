import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PRODUCTION_HOST } from "../../lib/experiments.ts";
import {
  ActivityClock,
  DEFAULT_TIMINGS,
  attentionBusy,
  SHOWN_KEY,
  markShown,
  readTimings,
  resetShownForTests,
  secsSince,
  shownOn,
  tickMs,
  todayCounts,
  trigger,
} from "./idleCard.ts";

const T = DEFAULT_TIMINGS;

describe("ActivityClock + trigger", () => {
  it("shows after a minute without input on a visible page", () => {
    const c = new ActivityClock(0, T.idleMs);
    c.input(5_000);
    expect(trigger(c, 5_000 + T.idleMs - 1, T)).toBeNull();
    expect(trigger(c, 5_000 + T.idleMs, T)).toBe("idle");
  });

  it("any input restarts the pause", () => {
    const c = new ActivityClock(0, T.idleMs);
    c.input(50_000);
    expect(trigger(c, 100_000, T)).toBeNull();
  });

  it("hidden time is never idle or active, and coming back starts a fresh pause", () => {
    const c = new ActivityClock(0, T.idleMs);
    c.input(1_000);
    c.hide();
    expect(c.idleFor(500_000)).toBe(0);
    c.show(500_000);
    expect(trigger(c, 500_000 + T.idleMs - 1, T)).toBeNull();
    c.input(500_010); // the gap since showing (10 ms) is active; the hidden span is not
    expect(c.activeMs()).toBe(1_000 + 10);
  });

  it("counts only short gaps as active time, then waits for a lull", () => {
    const c = new ActivityClock(0, T.idleMs);
    let t = 0;
    while (t < T.activeMs) c.input((t += 30_000)); // steady play: a combine every 30 s
    c.input((t += 120_000)); // a two-minute gap is idle, not active
    expect(c.activeMs()).toBe(T.activeMs);
    expect(trigger(c, t + T.lullMs - 1, T)).toBeNull(); // still mid-play
    expect(trigger(c, t + T.lullMs, T)).toBe("active");
  });

  it("checks once a second, faster only for shortened test timers", () => {
    expect(tickMs(T)).toBe(1_000);
    expect(tickMs({ idleMs: 1_200, activeMs: 0, lullMs: 400 })).toBe(200);
    expect(tickMs({ idleMs: 0, activeMs: 0, lullMs: 0 })).toBe(100);
  });
});

describe("todayCounts", () => {
  const now = new Date(2026, 10, 30, 14, 0); // local time
  const at = (d: number, h: number) => new Date(2026, 10, d, h).toISOString();
  it("counts today's non-starter discoveries and world firsts in local time", () => {
    const owned = {
      fire: { discoveredAt: at(30, 9), first: false }, // starter, created today
      steam: { discoveredAt: at(30, 9), first: false },
      mud: { discoveredAt: at(30, 0), first: true }, // local midnight belongs to today
      lava: { discoveredAt: at(29, 23), first: true }, // yesterday
      rain: { discoveredAt: at(30, 13), first: true },
      junk: { discoveredAt: "not a date", first: true },
    };
    const elements = { fire: { starter: true }, steam: { starter: false }, mud: { starter: false }, rain: { starter: false } };
    expect(todayCounts(owned, elements, now)).toEqual({ discoveries: 3, firsts: 2 });
  });
});

describe("readTimings", () => {
  it("honors the test override off the production host only", () => {
    expect(readTimings("localhost", { idleMs: 1500 })).toEqual({ ...T, idleMs: 1500 });
    expect(readTimings(PRODUCTION_HOST, { idleMs: 1500 })).toEqual(T);
  });
  it("ignores garbage", () => {
    expect(readTimings("localhost", { idleMs: -1, activeMs: "5", lullMs: Number.NaN })).toEqual(T);
    expect(readTimings("localhost", "fast")).toEqual(T);
    expect(readTimings("localhost", null)).toEqual(T);
  });
});

describe("once per local day", () => {
  let store: Map<string, string>;
  beforeEach(() => {
    resetShownForTests();
    store = new Map();
    vi.stubGlobal("window", {
      localStorage: { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => store.set(k, v) },
    });
  });
  afterEach(() => vi.unstubAllGlobals());

  it("remembers the day it was shown", () => {
    expect(shownOn("2026-11-30")).toBe(false);
    markShown("2026-11-30");
    expect(store.get(SHOWN_KEY)).toBe("2026-11-30");
    expect(shownOn("2026-11-30")).toBe(true);
    expect(shownOn("2026-12-01")).toBe(false); // a tab left open overnight gets the next day's card
  });

  it("still shows once per page when storage is unavailable", () => {
    vi.stubGlobal("window", {
      get localStorage(): Storage {
        throw new Error("SecurityError");
      },
    });
    expect(shownOn("2026-11-30")).toBe(false);
    markShown("2026-11-30");
    expect(shownOn("2026-11-30")).toBe(true);
  });
});

describe("secsSince", () => {
  it("rounds and caps at an hour", () => {
    expect(secsSince(0, 2_400)).toBe(2);
    expect(secsSince(0, 10 * 3_600_000)).toBe(3_600);
    expect(secsSince(5_000, 0)).toBe(0);
  });
});

describe("attentionBusy", () => {
  const calm = { onboarding: false, welcome: null, coach: null, sheet: null, celebrations: [], details: null, shelf: "peek" } as const;

  it("steps aside for onboarding, the expanded welcome card, the coach, sheets, cards and menus", () => {
    expect(attentionBusy(calm, true)).toBe(false);
    expect(attentionBusy({ ...calm, onboarding: true }, true)).toBe(true);
    expect(attentionBusy({ ...calm, welcome: "expanded" }, true)).toBe(true);
    expect(attentionBusy({ ...calm, coach: { a: "x", b: "y", at: 0 } }, true)).toBe(true);
    expect(attentionBusy({ ...calm, sheet: "settings" }, true)).toBe(true);
    expect(attentionBusy({ ...calm, celebrations: [{}] }, true)).toBe(true);
    expect(attentionBusy({ ...calm, details: {} }, true)).toBe(true);
  });

  it("not for the collapsed first-run welcome card, which stays up until closed (firstRun and idleCard both in treatment)", () => {
    expect(attentionBusy({ ...calm, welcome: "collapsed" }, true)).toBe(false);
    expect(attentionBusy({ ...calm, welcome: "collapsed" }, false)).toBe(false);
  });

  it("on phones, while the library shelf is pulled up", () => {
    expect(attentionBusy({ ...calm, shelf: "half" }, false)).toBe(true);
    expect(attentionBusy({ ...calm, shelf: "half" }, true)).toBe(false);
  });
});
