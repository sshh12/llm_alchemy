import { describe, expect, it } from "vitest";
import { ruleViolations, sanitizeDescription, sanitizeEmoji, validateProposal } from "./common.ts";
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

describe("anti-pattern names (the old model's ladders)", () => {
  const rej = (name: string, ingredients: string[], notable = false) => ruleViolations(name, ingredients, { notable }).join("; ");
  const okName = (name: string, ingredients: string[], notable = false) => expect(rej(name, ingredients, notable)).toBe("");

  it("rejects counted and multiplied forms, spaced or glued", () => {
    expect(rej("Double Flag", ["Flag", "Flag"])).toMatch(/counts or multiplies/);
    expect(rej("Quadruple Flag", ["Double Flag", "Double Flag"])).toMatch(/counts or multiplies/);
    expect(rej("Doublejar", ["Jar", "Jar"])).toMatch(/counts or multiplies/);
    expect(rej("Doublepanoramajungle", ["Double Panorama", "Jungle"])).toMatch(/counts or multiplies/);
    expect(rej("Quadrupled Teapot", ["Teapot", "Teapot", "Teapot", "Teapot"])).toMatch(/counts or multiplies/);
    expect(rej("Decuple Raincoat", ["Raincoat", "Octuple Raincoat"])).toMatch(/counts or multiplies/);
    expect(rej("Twin Wizard", ["Wizard", "Wizard"])).toMatch(/counts or multiplies/);
    expect(rej("Dualblade", ["Sword", "Sword"])).toMatch(/counts or multiplies/);
    expect(rej("Wizard Trio", ["Wizard", "Wizard", "Wizard"])).toMatch(/counts or multiplies/);
    expect(rej("Pair of Chickens", ["Chicken", "Chicken"])).toMatch(/counts or multiplies/);
    expect(rej("Pair", ["Jar", "Jar"])).toMatch(/counts or multiplies/);
    expect(rej("Two Swords", ["Sword", "Sword"])).toMatch(/counts or multiplies/);
    expect(rej("Sixtyfourfold Potion", ["Potion", "Potion"])).toMatch(/counts or multiplies/);
    expect(rej("Nonuplets", ["Triplets", "Triplets", "Triplets"])).toMatch(/counts or multiplies/);
    // the reason tells the retry what to do instead
    expect(rej("Double Flag", ["Flag", "Flag"])).toMatch(/Flag x2 = Bunting/);
  });

  it("rejects spelled-out arithmetic but keeps single numbers and number titles", () => {
    expect(rej("Sixty-Four", ["Thirty-Two", "Thirty-Two"])).toMatch(/arithmetic/);
    expect(rej("Two Hundred Fifty-Six", ["Hundred Twenty-Eight", "Hundred Twenty-Eight"])).toMatch(/arithmetic/);
    expect(rej("Sixty-Four Potion", ["Thirty-Two Potion", "Thirty-Two Potion"])).toMatch(/arithmetic/);
    okName("Four", ["Two", "Two"]);
    okName("Twenty-First Century", ["Future", "Time"]);
    okName("Forty-Two", ["Question", "Universe"]);
    okName("Nineteen Eighty-Four", ["Big Brother", "Book"], true);
    okName("Seven Seas", ["Ocean", "Seven"]);
    okName("Four-Leaf Clover", ["Luck", "Clover"]);
  });

  it("rejects hype and size words, spaced, stacked or glued", () => {
    expect(rej("Mega Steam", ["Fire", "Water"])).toMatch(/hype/);
    expect(rej("Megageyser", ["Geyser", "Geyser"])).toMatch(/hype/);
    expect(rej("Megacontinent", ["Supercontinent", "Supercontinent"])).toMatch(/hype/);
    expect(rej("Mega Ultra Robot", ["Robot", "Robot"])).toMatch(/hype/);
    expect(rej("Ultramegarobot", ["Robot", "Megabot"])).toMatch(/hype/);
    expect(rej("Ultimate Golem", ["Golem", "Golem"])).toMatch(/hype/);
    expect(rej("Colossal Golem", ["Giant Golem", "Giant Golem"])).toMatch(/hype/);
    expect(rej("Oqua Hypertower", ["Oqua", "Tower"])).toMatch(/hype/);
  });

  it("rejects meme-suffix mashups", () => {
    for (const [name, ings] of [
      ["Cakeception", ["Cake", "Cake"]],
      ["Glitchpocalypse", ["Glitch", "Apocalypse"]],
      ["Smogzilla", ["Smog", "Monster"]],
      ["Mythpunk", ["Myth", "Steampunk"]],
      ["Chronoverse", ["Time", "Universe"]],
      ["Popcornado", ["Popcorn", "Tornado"]],
      ["Smogopolis", ["Smog", "City"]],
      ["Fashionasaur", ["Fashion", "Dinosaur"]],
      ["Farmageddon", ["Farm", "Apocalypse"]],
    ] as const) {
      expect(rej(name, [...ings])).toMatch(/trendy suffix/);
    }
  });

  it("allows established terms that look like those patterns", () => {
    for (const [name, ings] of [
      ["Double Rainbow", ["Rainbow", "Rain"]],
      ["Double-Decker Bus", ["Bus", "Bus"]],
      ["Triple Crown", ["Horse", "Crown"]],
      ["Twins", ["Baby", "Baby"]],
      ["Triplets", ["Baby", "Baby", "Baby"]],
      ["Twin Towers", ["Tower", "Tower"]],
      ["String Quartet", ["Violin", "Cello"]],
      ["Quartet", ["Two", "Two"]],
      ["Giant Panda", ["Bear", "Bamboo"]],
      ["Giant Panda Cub", ["Panda", "Baby"]],
      ["Big Bang", ["Universe", "Explosion"]],
      ["Supernova", ["Star", "Explosion"]],
      ["Supervolcano", ["Super", "Volcano"]],
      ["Megalodon", ["Giant", "Shark"]],
      ["Ultraviolet", ["Light", "Purple"]],
      ["Hyperspace", ["Space", "Speed"]],
      ["Omnivore", ["Animal", "Food"]],
      ["Multiverse", ["Universe", "Universe"]],
      ["Steampunk", ["Steam", "Punk"]],
      ["Cyberpunk", ["Computer", "City"]],
      ["Tornado", ["Wind", "Wind"]],
      ["Earthquake", ["Earth", "Earth"]],
      ["Dinosaur", ["Lizard", "Time"]],
      ["Apocalypse", ["Fire", "World"]],
      ["Electron", ["Atom", "Energy"]],
      ["Metropolis", ["City", "City"]],
      ["Snowman", ["Snow", "Man"]],
      ["Stone Giant", ["Golem", "Mountain"]],
      ["Giant", ["Human", "Mountain"]],
      ["Manifold", ["Engine", "Pipe"]],
      ["Twinkle", ["Star", "Light"]],
      ["Bunting", ["Flag", "Flag"]],
      ["Forest", ["Tree", "Tree"]],
    ] as const) {
      okName(name, [...ings]);
    }
  });

  it("lets proper nouns through the glued, hype and number checks, but not the multiplier words", () => {
    okName("Big Ben", ["Clock", "London"], true);
    okName("Sharknado", ["Shark", "Tornado"], true);
    okName("Megatron", ["Robot", "Truck"], true);
    okName("Super Mario", ["Plumber", "Mushroom"], true);
    okName("Fantastic Four", ["Hero", "Four"], true);
    okName("Super Smash Bros", ["Brawl", "Nintendo"], true);
    expect(rej("Super Smash Bros", ["Brawl", "Nintendo"])).toMatch(/hype/);
    expect(rej("Quadruple Flag", ["Flag", "Flag"], true)).toMatch(/counts or multiplies/);
    expect(validateProposal({ name: "Big Ben", emoji: "🕰️", description: "x", notable: true }, ["Clock", "London"]).ok).toBe(true);
  });

  it("rejects ingredients glued with a shared letter, unless the result is an established term", () => {
    expect(rej("Dreamachine", ["Dream", "Machine"])).toMatch(/glues/);
    expect(rej("Panoramajungle", ["Panorama", "Jungle"])).toMatch(/glues/);
    expect(rej("Rainbowpegasus", ["Rainbow", "Pegasus"])).toMatch(/glues/);
    okName("Steampunk", ["Steam", "Punk"]);
    okName("Time Machine", ["Time", "Machine"]);
    okName("Sandcastle", ["Sand", "Castle"]);
  });
});
