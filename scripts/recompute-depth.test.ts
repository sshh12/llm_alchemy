import { describe, expect, it } from "vitest";
import { loweredDepthSteps } from "./recompute-depth.ts";

describe("loweredDepthSteps", () => {
  const el = (id: string, depth: number | null, steps: number | null, isStarter = false) => ({ id, isStarter, depth, steps });

  it("lowers descendants of a shortcut and never raises or clears a value", () => {
    // 1, 2 starters. A live combine found 1+2 = 10 (a shortcut), and lowered only 10 itself;
    // 11 (made from 10) still has the old values. 12 is stored lower than the graph says.
    const elements = [el("1", 0, 0, true), el("2", 0, 0, true), el("10", 1, 1), el("11", 5, 9), el("12", 1, 1), el("13", 4, 4), el("14", null, null)];
    const recipes = [
      { ingredients: ["1", "2"], result: "10" },
      { ingredients: ["10", "10"], result: "11" },
      { ingredients: ["11", "2"], result: "12" },
      { ingredients: ["99", "1"], result: "14" }, // 99 is not active: not a live recipe
    ];
    const updates = loweredDepthSteps(elements, recipes);
    expect(updates.map((u) => [u.id, u.depth, u.steps])).toEqual([["11", 2, 2]]);
    // 12 stays at its lower stored values, 13 (unreachable) and 14 are untouched.
  });

  it("fills NULL values of reachable elements", () => {
    const updates = loweredDepthSteps([el("1", 0, 0, true), el("10", null, 3)], [{ ingredients: ["1", "1"], result: "10" }]);
    expect(updates).toEqual([{ id: "10", depth: 1, steps: 1, before: { depth: null, steps: 3 } }]);
  });
});
