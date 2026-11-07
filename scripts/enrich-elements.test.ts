import { describe, expect, it } from "vitest";
import { validateItem } from "./enrich-elements.ts";

describe("validateItem", () => {
  it("accepts casing-only changes with one emoji", () => {
    expect(validateItem("isaac newton", { name: "Isaac Newton", emoji: "🍎", notable: true })).toEqual({
      name: "Isaac Newton",
      emoji: "🍎",
      notable: true,
    });
    expect(validateItem("dna", { name: "DNA", emoji: "🧬", notable: false })?.name).toBe("DNA");
    expect(validateItem("t-rex", { name: "T-Rex", emoji: "🦖", notable: false })?.name).toBe("T-Rex");
    expect(validateItem("scientist", { name: "Scientist", emoji: "🧑‍🔬", notable: false })?.emoji).toBe("🧑‍🔬");
  });

  it("title-cases an all-lowercase answer", () => {
    expect(validateItem("steam engine", { name: "steam engine", emoji: "🚂", notable: false })?.name).toBe("Steam Engine");
  });

  it("rejects changed words, missing or multiple emoji, bad types", () => {
    expect(validateItem("steam", { name: "Steamy", emoji: "♨️", notable: false })).toBeNull();
    expect(validateItem("steam", { name: "Steam", emoji: "♨️♨️", notable: false })).toBeNull();
    expect(validateItem("steam", { name: "Steam", emoji: "S", notable: false })).toBeNull();
    expect(validateItem("steam", { name: "Steam", emoji: "", notable: false })).toBeNull();
    expect(validateItem("steam", { name: "Steam", emoji: "♨️", notable: "no" })).toBeNull();
  });
});
