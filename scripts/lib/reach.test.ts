import { describe, expect, it } from "vitest";
import { REACH_FLOOR } from "./challengeModel.ts";
import { computeReach, MAX_WINDOW_SHARE, reachInputsFromJson, reachInputsToJson, reachOf, windowShare, type ReachInputs } from "./reach.ts";

const hourly = (entries: [string, number, number][]) => new Map(entries.map(([h, n28, n7]) => [h, { n28, n7 }]));

describe("computeReach", () => {
  const base: ReachInputs = {
    asOf: "2026-11-23T00:00:00.000Z",
    n28: 100,
    n7: 50,
    owners: new Map([
      ["a", { owners: 50, owners7: 10 }],
      ["b", { owners: 10, owners7: 0 }],
      ["c", { owners: 300, owners7: 80 }],
    ]),
    // 1,000 cohort discoveries; 250 of them on 2026-11-20 00:00-11:59 UTC.
    hourly: hourly([
      ["2026-11-20T00", 100, 20],
      ["2026-11-20T11", 150, 30],
      ["2026-11-21T12", 50, 0], // 36 h after 11-20 00:00: outside the window
      ["2026-11-18T05", 700, 150],
    ]),
    windows: new Map([["b", ["2026-11-20"]]]),
  };

  it("divides owners by the cohort, floors and caps", () => {
    const r = computeReach(base);
    expect(r.reach.get("a")).toBeCloseTo(0.5, 12);
    expect(r.reach.get("c")).toBe(1); // capped
    expect(r.reach7.get("a")).toBeCloseTo(0.2, 12);
    expect(r.reach7.has("b")).toBe(false); // no owners7: floor on lookup
    expect(reachOf(r.reach7, "b")).toBe(REACH_FLOOR);
    expect(reachOf(r.reach, "zzz")).toBe(REACH_FLOOR);
    expect(r.owners.get("a")).toBe(50);
    expect([r.cohortN, r.cohortN7, r.mode]).toEqual([100, 50, "r1"]);
  });

  it("shrinks the denominator by the share of discoveries inside the target windows", () => {
    expect(windowShare(["2026-11-20"], base.hourly, "n28", 1000)).toBeCloseTo(0.25, 12);
    expect(windowShare(["2026-11-20", "2026-11-20"], base.hourly, "n28", 1000)).toBeCloseTo(0.25, 12); // a day counts once
    const r = computeReach(base);
    expect(r.reach.get("b")).toBeCloseTo(10 / (100 * 0.75), 12);
  });

  it("caps the window share at 0.9", () => {
    const h = hourly([["2026-11-20T03", 1000, 0], ["2026-11-01T00", 10, 0]]);
    expect(windowShare(["2026-11-20"], h, "n28", 1010)).toBe(MAX_WINDOW_SHARE);
  });

  it("round-trips through JSON", () => {
    const back = reachInputsFromJson(JSON.parse(JSON.stringify(reachInputsToJson(base))));
    expect(computeReach(back)).toEqual(computeReach(base));
  });

  it("handles an empty cohort", () => {
    const r = computeReach({ ...base, n28: 0, n7: 0 });
    expect(r.reach.size).toBe(0);
  });
});
