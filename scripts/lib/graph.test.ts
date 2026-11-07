import { describe, expect, it } from "vitest";
import { bfsTiers, computeDepthSteps, derivationClosure, histogram, sortIds, suggestRarityThresholds, type GraphRecipe } from "./graph.ts";

const S = ["e", "w", "a", "f", "t"];
const r = (ingredients: string[], result: string): GraphRecipe => ({ ingredients, result });

describe("sortIds", () => {
  it("sorts numerically, not lexicographically, and keeps duplicates", () => {
    expect(sortIds(["1000000000000000010", "990000000000000001", "990000000000000001"])).toEqual([
      "990000000000000001",
      "990000000000000001",
      "1000000000000000010",
    ]);
  });
});

describe("computeDepthSteps", () => {
  const recipes = [
    r(["w", "f"], "steam"), // depth 1, steps 1
    r(["e", "w"], "mud"), // 1, 1
    r(["mud", "f"], "brick"), // 2, 2
    r(["brick", "brick"], "wall"), // 3, 3 (distinct ingredients counted once)
    r(["brick", "wall"], "house"), // 4, 1+2+3 = 6
    r(["steam", "mud", "e", "a"], "house"), // 2, 1+1+1 = 3  (cheaper multi-ingredient route)
    r(["ghost", "f"], "unreachable"),
    r(["steam", "steam"], "steam"), // self-loop is harmless
  ];
  const { depth, steps } = computeDepthSteps(S, recipes);

  it("assigns starters 0", () => {
    for (const s of S) {
      expect(depth.value.get(s)).toBe(0);
      expect(steps.value.get(s)).toBe(0);
    }
  });

  it("computes min generations and min combinations", () => {
    expect(depth.value.get("brick")).toBe(2);
    expect(steps.value.get("brick")).toBe(2);
    expect(depth.value.get("wall")).toBe(3);
    expect(steps.value.get("wall")).toBe(3);
    expect(depth.value.get("house")).toBe(2);
    expect(steps.value.get("house")).toBe(3);
    expect(steps.via.get("house")).toBe(5);
  });

  it("leaves unreachable elements out", () => {
    expect(depth.value.has("unreachable")).toBe(false);
    expect(steps.value.has("ghost")).toBe(false);
  });

  it("walks derivation trees", () => {
    const c = derivationClosure(["brick"], recipes, steps);
    expect([...c.elements].sort()).toEqual(["brick", "e", "f", "mud", "w"]);
    expect([...c.recipes].sort()).toEqual([1, 2]);
  });
});

describe("bfsTiers", () => {
  it("matches the notebook tiers over 2-ingredient recipes (incl. self-pairs)", () => {
    const tiers = bfsTiers(S, [
      r(["f", "f"], "sun"),
      r(["sun", "w"], "rainbow"),
      r(["w", "a", "f"], "storm"), // arity 3: ignored by the BFS
      r(["rainbow", "rainbow"], "unicorn"),
    ]);
    expect(tiers.get("sun")).toBe(1);
    expect(tiers.get("rainbow")).toBe(2);
    expect(tiers.get("unicorn")).toBe(3);
    expect(tiers.has("storm")).toBe(false);
  });
});

describe("suggestRarityThresholds", () => {
  it("returns monotonic thresholds close to the target shares", () => {
    // 100 elements: depth d has the counts below.
    const h = histogram([...Array(10).fill(1), ...Array(30).fill(2), ...Array(30).fill(3), ...Array(18).fill(4), ...Array(9).fill(5), ...Array(3).fill(6)]);
    const { thresholds, share } = suggestRarityThresholds(h);
    expect(thresholds).toEqual({ common: 0, uncommon: 3, rare: 4, epic: 5, legendary: 6 });
    expect(share.common).toBeCloseTo(0.4);
    expect(share.legendary).toBeCloseTo(0.03);
  });

  it("stays strictly increasing on a degenerate histogram", () => {
    const { thresholds } = suggestRarityThresholds(histogram([0, 1, 1, 1]));
    expect(thresholds.common).toBe(0);
    expect(thresholds.uncommon).toBeLessThan(thresholds.rare);
    expect(thresholds.rare).toBeLessThan(thresholds.epic);
    expect(thresholds.epic).toBeLessThan(thresholds.legendary);
  });
});
