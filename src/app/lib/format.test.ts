import { describe, expect, it } from "vitest";
import { formatGoal, formatPercent, goalProgress, milestoneReached, nextMilestone, prevMilestone } from "./format.ts";

describe("formatPercent", () => {
  it("floors at <0.1% and never rounds up", () => {
    expect(formatPercent(5, 63_418)).toBe("<0.1%");
    expect(formatPercent(0, 10)).toBe("0%");
    expect(formatPercent(19, 100)).toBe("19.0%");
    expect(formatPercent(10, 10)).toBe("100%");
  });
});

describe("goals ladder", () => {
  it("climbs 25, 50, 100, 150, 250, 500, then every 250", () => {
    const seen: number[] = [];
    for (let n = 0; n < 1_600; n++) {
      const r = nextMilestone(n);
      if (seen.at(-1) !== r) seen.push(r);
    }
    expect(seen).toEqual([25, 50, 100, 150, 250, 500, 750, 1_000, 1_250, 1_500, 1_750]);
  });

  it("a library sitting on a rung works toward the next one", () => {
    expect(nextMilestone(5)).toBe(25);
    expect(nextMilestone(24)).toBe(25);
    expect(nextMilestone(25)).toBe(50);
    expect(nextMilestone(500)).toBe(750);
    expect(nextMilestone(749)).toBe(750);
    expect(nextMilestone(750)).toBe(1_000);
  });

  it("prevMilestone is the last rung reached", () => {
    expect(prevMilestone(0)).toBe(0);
    expect(prevMilestone(24)).toBe(0);
    expect(prevMilestone(25)).toBe(25);
    expect(prevMilestone(149)).toBe(100);
    expect(prevMilestone(500)).toBe(500);
    expect(prevMilestone(999)).toBe(750);
    expect(prevMilestone(1_000)).toBe(1_000);
  });

  it("milestoneReached reports a rung only when an increase crosses it", () => {
    expect(milestoneReached(24, 25)).toBe(25);
    expect(milestoneReached(25, 26)).toBeNull();
    expect(milestoneReached(49, 50)).toBe(50);
    expect(milestoneReached(749, 750)).toBe(750);
    expect(milestoneReached(5, 6)).toBeNull();
    // Never on a decrease (reset) or no change.
    expect(milestoneReached(60, 5)).toBeNull();
    expect(milestoneReached(50, 50)).toBeNull();
    // A jump over two rungs reports the higher one.
    expect(milestoneReached(20, 60)).toBe(50);
  });

  it("formats progress as count/next with thousands separators", () => {
    expect(formatGoal(47)).toBe("47/50");
    expect(formatGoal(50)).toBe("50/100");
    expect(formatGoal(1_247)).toBe("1,247/1,250");
  });

  it("goalProgress runs from the last rung to the next", () => {
    expect(goalProgress(0)).toBe(0);
    expect(goalProgress(25)).toBe(0);
    expect(goalProgress(75)).toBe(0.5);
    expect(goalProgress(99)).toBeCloseTo(0.98);
    expect(goalProgress(625)).toBe(0.5);
  });
});
