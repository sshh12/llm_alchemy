import { describe, expect, it } from "vitest";
import { DEMO_RECIPE, STARTER_ORDER, starterRank } from "./starters.ts";

describe("starters", () => {
  it("puts the onboarding demo pair first on the shelf", () => {
    expect([DEMO_RECIPE.a, DEMO_RECIPE.b]).toEqual(STARTER_ORDER.slice(0, 2));
  });

  it("ranks starters by shelf position, case-insensitively, and unknown names last", () => {
    expect(STARTER_ORDER.map(starterRank)).toEqual([0, 1, 2, 3, 4]);
    expect(starterRank("water")).toBe(0);
    expect(starterRank("Steam")).toBe(STARTER_ORDER.length);
  });
});
