import { describe, expect, it } from "vitest";
import { sanitizeDescription, sanitizeEmoji, validateProposal } from "./common.ts";
import { buildCombineInput, buildImagePrompt, buildImagePromptFromHint, genericImageHint } from "./prompts.ts";

const ok = (raw: unknown, ingredients = ["Fire", "Water"]) => {
  const r = validateProposal(raw, ingredients);
  if (!r.ok) throw new Error(r.reason);
  return r.proposal;
};
const reason = (raw: unknown, ingredients = ["Fire", "Water"]) => {
  const r = validateProposal(raw, ingredients);
  return r.ok ? null : r.reason;
};

describe("validateProposal", () => {
  it("accepts a good answer and keeps the model's casing", () => {
    expect(ok({ name: "Steam", emoji: "♨️", description: "Hot vapor.", notable: false })).toEqual({
      name: "Steam",
      key: "steam",
      foldKey: "steam",
      emoji: "♨️",
      description: "Hot vapor.",
      notable: false,
      artHint: null,
    });
    expect(ok({ name: "Steam", emoji: "♨️", description: "Hot vapor.", notable: false, icon: "curling plume of steam" }).artHint).toBe(
      "curling plume of steam",
    );
    expect(ok({ name: "iPhone", emoji: "📱", description: "", notable: true }).name).toBe("iPhone");
    expect(ok({ name: "solar system", emoji: "🪐", description: "x", notable: false }).name).toBe("Solar System");
  });

  it("rejects echoing an ingredient, including folded variants", () => {
    expect(reason({ name: "Fire", emoji: "🔥", description: "", notable: false })).toMatch(/ingredient/);
    expect(reason({ name: "time-travel", emoji: "", description: "", notable: false }, ["Time Travel", "Fire"])).toMatch(
      /ingredient/,
    );
  });

  it("applies checkName with a 4-word allowance for notable names", () => {
    const four = { name: "Leonardo da Vinci Code", emoji: "", description: "", notable: false };
    expect(reason(four)).toMatch(/too many words/);
    expect(ok({ ...four, notable: true }).name).toBe("Leonardo da Vinci Code");
    expect(reason({ name: "Big Big Fire", emoji: "", description: "", notable: false })).toMatch(/repeated word/);
    expect(reason({ name: "x".repeat(40), emoji: "", description: "", notable: false })).toMatch(/too long/);
    expect(reason({ name: "Steam  Cloud  Rain", emoji: "", description: "", notable: false })).toMatch(/list-like/);
    expect(reason(null)).toMatch(/JSON object/);
    expect(reason({ name: 5 })).toMatch(/JSON object/);
  });

  it("sanitizes emoji and descriptions", () => {
    expect(sanitizeEmoji("🔥🔥")).toBe("🔥");
    expect(sanitizeEmoji("👩‍🔬 scientist")).toBe("👩‍🔬");
    expect(sanitizeEmoji("🇯🇵")).toBe("🇯🇵");
    expect(sanitizeEmoji("A")).toBeNull();
    expect(sanitizeEmoji("")).toBeNull();
    expect(sanitizeEmoji(undefined)).toBeNull();
    expect(sanitizeDescription("  two\nlines\u0000 here ")).toBe("two lines here");
    const long = sanitizeDescription("word ".repeat(80))!;
    expect(long.length).toBeLessThanOrEqual(160);
    expect(long.endsWith("…")).toBe(true);
    expect(sanitizeDescription("   ")).toBeNull();
  });
});

describe("prompts", () => {
  it("passes ingredient names as a sorted JSON array, with a count line for repeats", () => {
    expect(buildCombineInput(["Ignore \"rules\"", "Fire"])).toBe('["Fire","Ignore \\"rules\\""]');
    expect(buildCombineInput(["Water", "fire", "Fire"])).toBe('["Fire","fire","Water"]\nRepeated: "Fire" x2');
    expect(buildImagePrompt("Steam", "Hot vapor.")).toContain("miniature of Steam");
    expect(buildImagePrompt("Steam", "Hot vapor.")).toContain("It is Hot vapor.");
  });

  it("has a generic fallback hint for refused names without a hint (legacy rows)", () => {
    const prompt = buildImagePromptFromHint(genericImageHint("Storm"));
    expect(prompt).toContain("stylized storm");
    expect(prompt).toContain("natural phenomenon");
    expect(prompt).not.toContain("${");
  });

  it("rejects results that only restate ingredients or ignore one", () => {
    expect(reason({ name: "Flames", emoji: "🔥", description: "", notable: false }, ["Fire", "Wood"])).toMatch(/synonym|plural/);
    expect(reason({ name: "Mega Steam", emoji: "♨️", description: "", notable: false })).toMatch(/hype/);
    expect(reason({ name: "Earth", emoji: "🌍", description: "", notable: false }, ["Mud", "Sun"])).toMatch(/starter/);
    expect(reason({ name: "Fire Water", emoji: "🔥", description: "", notable: false }, ["Fire", "Water"])).toMatch(/glues/);
  });
});
