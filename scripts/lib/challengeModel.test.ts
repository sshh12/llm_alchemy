import { describe, expect, it } from "vitest";
import { addDays } from "../../src/shared/dates.ts";
import {
  armFor,
  namedHoliday,
  THIRD_CUTS,
  thirdOf,
  BAND_FLOOR,
  BANDS,
  blockArm,
  COEF_SELECT,
  dayClass,
  dayType,
  EXPLORE_BAND,
  EXPLORE_WINDOW,
  HOLDOUT_WINDOW,
  logit,
  predict,
  predictLogit,
  REACH_FLOOR,
  sigmoid,
} from "./challengeModel.ts";

describe("predict (COEF_SELECT spot values, spec §2.1)", () => {
  const p = (tier: "easy" | "hard" | "expert", r: number, s: number, off = false) => predict(COEF_SELECT, tier, r, s, off);
  it("matches the spec table to 4 decimals", () => {
    expect(p("easy", 1, 1)).toBeCloseTo(0.574, 4);
    expect(p("easy", 0.553, 2)).toBeCloseTo(0.4454, 4); // Fog; observed 47%
    expect(p("hard", 0.1, 3)).toBeCloseTo(0.1064, 4);
    expect(p("expert", REACH_FLOOR, 6)).toBeCloseTo(0.01609, 5);
    expect(p("expert", REACH_FLOOR, 6, true)).toBeCloseTo(0.0716, 4);
  });

  it("floors reach, clips steps and treats unknown steps as the clip", () => {
    expect(predictLogit(COEF_SELECT, "hard", 0, 3)).toBe(predictLogit(COEF_SELECT, "hard", REACH_FLOOR, 3));
    expect(predictLogit(COEF_SELECT, "hard", 2, 3)).toBe(predictLogit(COEF_SELECT, "hard", 1, 3));
    expect(predictLogit(COEF_SELECT, "expert", 0.01, 99)).toBe(predictLogit(COEF_SELECT, "expert", 0.01, 40));
    expect(predictLogit(COEF_SELECT, "expert", 0.01, Number.POSITIVE_INFINITY)).toBe(predictLogit(COEF_SELECT, "expert", 0.01, 40));
    expect(predictLogit(COEF_SELECT, "easy", 0.5, 0)).toBe(predictLogit(COEF_SELECT, "easy", 0.5, 1));
  });

  it("gives the reach needed to enter the school bands (§2.1)", () => {
    // hard at 7%: 3.2% at 3 steps; expert at 3%: 1.3% at 6 steps.
    expect(p("hard", 0.032, 3)).toBeGreaterThan(0.069);
    expect(p("hard", 0.032, 3)).toBeLessThan(0.071);
    expect(p("expert", 0.013, 6)).toBeCloseTo(0.03, 3);
    expect(sigmoid(logit(0.3))).toBeCloseTo(0.3, 12);
  });

  it("school bands are disjoint in tier order, so p-order holds by construction", () => {
    for (const dt of ["school", "mon", "off"] as const) {
      const b = BANDS[dt];
      expect(BAND_FLOOR[dt].easy).toBeGreaterThan(b.hard.hi);
      expect(b.hard.lo).toBeGreaterThanOrEqual(b.expert.hi);
      expect(BAND_FLOOR[dt].easy).toBeLessThanOrEqual(b.easy.lo);
    }
    expect(EXPLORE_BAND.hi).toBeLessThanOrEqual(BANDS.school.hard.lo);
  });
});

describe("dayType (US classroom calendar, §4.1)", () => {
  it("matches the spec table", () => {
    const table: [string, string][] = [
      ["2026-11-26", "off"], // Thanksgiving
      ["2026-11-25", "off"], // Thanksgiving Wednesday
      ["2026-11-27", "off"],
      ["2026-11-30", "mon"],
      ["2026-12-01", "school"],
      ["2026-12-22", "school"],
      ["2026-12-23", "off"],
      ["2027-01-01", "off"],
      ["2027-01-04", "mon"],
      ["2027-01-18", "off"], // MLK
      ["2027-02-15", "off"], // Presidents' Day
      ["2027-05-31", "off"], // Memorial Day
      ["2027-06-18", "school"],
      ["2027-06-21", "off"],
      ["2027-08-13", "off"],
      ["2027-08-16", "mon"],
      ["2027-09-06", "off"], // Labor Day
      ["2027-11-24", "off"], // Thanksgiving 2027 is 11-25
      ["2027-11-23", "school"],
      ["2026-11-28", "off"], // Saturday
      ["2026-11-29", "off"], // Sunday
    ];
    for (const [d, t] of table) expect(dayType(d), d).toBe(t);
  });
});

describe("experiment arms (§6)", () => {
  const weekdays = (from: string, to: string) => {
    const out: string[] = [];
    for (let d = from; d <= to; d = addDays(d, 1)) if (dayClass(d) === "wk") out.push(d);
    return out;
  };

  it("is a pure function of the date", () => {
    expect(armFor("2027-01-12")).toEqual(armFor("2027-01-12"));
  });

  it("permuted blocks: every full block holds each arm exactly once", () => {
    for (let b = -3; b < 50; b++) {
      const arms = [0, 1, 2].map((i) => blockArm(b * 3 + i, 3, "t").arm).sort();
      expect(arms).toEqual([0, 1, 2]);
      expect(blockArm(b * 3, 3, "t").block).toBe(b);
    }
  });

  it("block permutations vary from block to block (the hash is mixed)", () => {
    const perms = new Set<string>();
    for (let b = 0; b < 60; b++) perms.add([0, 1, 2].map((i) => blockArm(b * 3 + i, 3, "hard-wk").arm).join(""));
    expect(perms.size).toBe(6);
  });

  it("hard thirds are balanced per block of 3 within each day class", () => {
    for (const cls of ["wk", "off"] as const) {
      const days: string[] = [];
      for (let d = "2026-11-30"; days.length < 90; d = addDays(d, 1)) if (dayClass(d) === cls) days.push(d);
      for (let i = 0; i + 3 <= days.length; i += 3) {
        const thirds = days.slice(i, i + 3).map((d) => armFor(d).hard.third);
        expect([...thirds].sort(), days[i]).toEqual([0, 1, 2]);
        expect(new Set(days.slice(i, i + 3).map((d) => armFor(d).hard.block)).size).toBe(1);
      }
    }
  });

  it("off-day expert thirds are balanced; weekday expert is band or explore", () => {
    const offs: string[] = [];
    for (let d = "2026-11-30"; offs.length < 60; d = addDays(d, 1)) if (dayClass(d) === "off") offs.push(d);
    for (let i = 0; i < offs.length; i += 3) expect(offs.slice(i, i + 3).map((d) => armFor(d).expert.assigned).sort()).toEqual([0, 1, 2]);
    for (const d of weekdays("2026-11-30", "2027-06-30")) expect(["band", "explore"]).toContain(armFor(d).expert.assigned);
  });

  it("explore: 1 weekday in 4 from 2026-11-30 to 2027-04-30, never after, never on off days", () => {
    const inWin = weekdays(EXPLORE_WINDOW.from, EXPLORE_WINDOW.to);
    for (let i = 0; i + 4 <= inWin.length; i += 4) {
      expect(inWin.slice(i, i + 4).filter((d) => armFor(d).expert.assigned === "explore").length).toBe(1);
    }
    for (const d of weekdays("2027-05-01", "2027-12-31")) expect(armFor(d).expert.assigned).toBe("band");
    for (const d of weekdays("2026-11-01", "2026-11-29")) expect(armFor(d).expert.assigned).toBe("band");
  });

  it("holdout: 1 weekday in 6 in its window (about 7 days), none outside", () => {
    const inWin = weekdays(HOLDOUT_WINDOW.from, HOLDOUT_WINDOW.to);
    const held = inWin.filter((d) => armFor(d).holdout.assigned);
    for (let i = 0; i + 6 <= inWin.length; i += 6) expect(inWin.slice(i, i + 6).filter((d) => armFor(d).holdout.assigned).length).toBe(1);
    expect(held.length).toBeGreaterThanOrEqual(7);
    expect(held.length).toBeLessThanOrEqual(8);
    for (const d of [...weekdays("2027-02-06", "2027-06-01"), ...weekdays("2026-11-01", "2026-11-29")]) expect(armFor(d).holdout.assigned).toBe(false);
    expect(armFor("2026-12-05").holdout).toEqual({ assigned: false, block: null }); // Saturday
  });

  it("days before the epoch get negative blocks, consistently", () => {
    const a = armFor("2026-11-25");
    expect(a.dayType).toBe("off");
    expect(a.hard.block).toBeLessThan(0);
  });
});

describe("named holidays and frozen third cuts", () => {
  it("namedHoliday: Thanksgiving (4th Thursday), Dec 24-25, Jan 1, Jul 4", () => {
    expect(namedHoliday("2026-11-26")).toBe("thanksgiving");
    expect(namedHoliday("2027-11-25")).toBe("thanksgiving");
    expect(namedHoliday("2027-11-26")).toBeNull();
    expect(namedHoliday("2027-12-24")).toBe("christmas");
    expect(namedHoliday("2027-12-25")).toBe("christmas");
    expect(namedHoliday("2028-01-01")).toBe("new-year");
    expect(namedHoliday("2027-07-04")).toBe("july-4");
    expect(namedHoliday("2027-07-05")).toBeNull();
  });

  it("THIRD_CUTS are ordered inside each band and thirdOf slices by them", () => {
    for (const [dt, c] of Object.entries(THIRD_CUTS)) {
      const b = BANDS[dt as keyof typeof BANDS];
      expect(c.hard[0]).toBeLessThan(c.hard[1]);
      expect(c.hard[0]).toBeGreaterThan(b.hard.lo);
      expect(c.hard[1]).toBeLessThan(b.hard.hi);
      if (c.expert) {
        expect(c.expert[0]).toBeLessThan(c.expert[1]);
        expect(c.expert[0]).toBeGreaterThan(b.expert.lo);
        expect(c.expert[1]).toBeLessThan(b.expert.hi);
      }
    }
    expect(THIRD_CUTS.school.expert).toBeNull();
    expect(thirdOf(0.05, [0.06, 0.08])).toBe(0);
    expect(thirdOf(0.06, [0.06, 0.08])).toBe(1);
    expect(thirdOf(0.09, [0.06, 0.08])).toBe(2);
  });
});
