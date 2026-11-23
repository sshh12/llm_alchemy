import { describe, expect, it } from "vitest";
import {
  computeAha,
  directLinks,
  editDistance1,
  inSeason,
  isAbstract,
  isTwinTrap,
  nameWords,
  NEAR_NAME_MIN_REACH,
  NEAR_NAME_RATIO,
  NearNameIndex,
  nearNameTrap,
  phraseWords,
  seasonalRule,
  singular,
  synonymTrap,
  topTwin,
  TwinIndex,
  twinKey,
} from "./challengeFeatures.ts";

describe("nameWords (variety, §3 C11)", () => {
  it("keeps 3+ letter words minus stop words, drops a trailing s, adds synonym groups", () => {
    expect([...nameWords("The Rocks and Stones")].sort()).toEqual(["rock", "stone"]);
    expect([...nameWords("Fog")]).toEqual(["fog", "syn:0"]);
    expect(nameWords("Mist").has("syn:0")).toBe(true);
    expect(nameWords("Sea").has("syn:4")).toBe(true);
    expect(nameWords("Ocean").has("syn:4")).toBe(true);
    expect(nameWords("Ocean Liner").has("syn:4")).toBe(false); // whole names only
    expect([...nameWords("Bus")]).toEqual(["bus"]); // 3 letters: kept as is
  });
});

describe("spelling twins (§3 C8)", () => {
  it("folds case, spaces, punctuation and plurals", () => {
    expect(twinKey("Black Hole")).toBe("blackhole");
    expect(twinKey("Blackhole")).toBe("blackhole");
    expect(twinKey("Black Holes")).toBe("blackhole");
    expect(twinKey("Jack-O'-Lantern")).toBe("jackolantern");
    expect(singular("berries")).toBe("berry");
    expect(singular("ashes")).toBe("ash"); // the sh/ch + es fold the sim needed
    expect(singular("boxes")).toBe("box");
    expect(singular("glass")).toBe("glass");
    expect(singular("bus")).toBe("bus");
  });

  it("edit distance 1", () => {
    expect(editDistance1("volcano", "volcanoe")).toBe(true);
    expect(editDistance1("volcano", "volkano")).toBe(true);
    expect(editDistance1("volcano", "vulkano")).toBe(false);
    expect(editDistance1("abc", "abc")).toBe(true);
  });

  const idx = new TwinIndex([
    { id: "1", name: "Black Hole", emoji: "🕳️" },
    { id: "2", name: "Blackhole", emoji: "⚫" },
    { id: "3", name: "Volcano", emoji: "🌋" },
    { id: "4", name: "Volcanoe", emoji: "🌋" },
    { id: "5", name: "Volkano", emoji: "🔥" },
    { id: "6", name: "Fog", emoji: "🌫️" },
    { id: "7", name: "Fig", emoji: "🌫️" },
  ]);

  it("same key always; edit distance 1 only with the same emoji and a 6+ character key", () => {
    expect(idx.twinsOf("1", "Black Hole", "🕳️")).toEqual(["2"]);
    expect(idx.twinsOf("3", "Volcano", "🌋")).toEqual(["4"]); // Volkano has another emoji
    expect(idx.twinsOf("6", "Fog", "🌫️")).toEqual([]); // too short for ED1
  });

  it("is a trap only when a twin is at least as widely made", () => {
    const reach = new Map([["1", 0.01], ["2", 0.02], ["3", 0.3], ["4", 0.0004]]);
    const r = (id: string) => reach.get(id) ?? 0.0004;
    expect(isTwinTrap({ id: "1", name: "Black Hole", emoji: "🕳️" }, idx, r)).toBe("2");
    expect(isTwinTrap({ id: "2", name: "Blackhole", emoji: "⚫" }, idx, r)).toBeNull();
    expect(isTwinTrap({ id: "3", name: "Volcano", emoji: "🌋" }, idx, r)).toBeNull();
  });

  it("synonym trap: a kid synonym with 2x the reach (needs classifier tags)", () => {
    const i2 = new TwinIndex([{ id: "s", name: "Sea" }, { id: "o", name: "Ocean" }]);
    const reach = new Map([["s", 0.05], ["o", 0.2]]);
    const r = (id: string) => reach.get(id)!;
    expect(synonymTrap("s", ["Ocean"], i2, r)).toBe("o");
    expect(synonymTrap("o", ["Sea"], i2, r)).toBeNull();
    expect(synonymTrap("s", null, i2, r)).toBeNull();
  });
});

describe("abstract names", () => {
  it("flags abstract-noun suffixes on the last word, with an allow list", () => {
    for (const n of ["Happiness", "Electricity", "Friendship Bracelet Movement", "Civilization", "Abundance"]) expect(isAbstract(n), n).toBe(true);
    for (const n of ["Station", "Potion", "Television", "Kingdom", "City", "Ocean", "Dragon", "Explosion", "Wisdom Tree"]) expect(isAbstract(n), n).toBe(false);
  });
});

describe("seasons (§3.1)", () => {
  it("keeps seasonal names to their months", () => {
    expect(inSeason("Snowman", "2027-07-14", "off")).toBe(false);
    expect(inSeason("Snowman", "2027-01-12", "school")).toBe(true);
    expect(inSeason("Sandcastle", "2027-01-12", "school")).toBe(false);
    expect(inSeason("Sandcastle", "2027-06-02", "school")).toBe(true);
    expect(inSeason("Christmas Tree", "2026-12-15", "school")).toBe(true);
    expect(inSeason("Christmas Tree", "2027-01-05", "school")).toBe(false);
    expect(inSeason("Valentine", "2027-02-10", "school")).toBe(true);
    expect(inSeason("Volcano", "2027-07-14", "off")).toBe(true);
  });

  it("Halloween only on Oct 24-31 off days", () => {
    expect(inSeason("Jack-o-Lantern", "2027-10-30", "off")).toBe(true);
    expect(inSeason("Halloween", "2027-10-29", "school")).toBe(false);
    expect(inSeason("Halloween", "2027-10-16", "off")).toBe(false);
  });

  it("does not catch Sledgehammer or Frosting", () => {
    expect(seasonalRule("Sledgehammer")).toBeNull();
    expect(seasonalRule("Frosting")).toBeNull();
    expect(seasonalRule("Frostbite")).not.toBeNull();
    expect(seasonalRule("Sled")).not.toBeNull();
  });

  it("autumn in Sep-Nov, cherry blossoms in Mar-May, surfing and water slides in May-Sep", () => {
    expect(inSeason("Autumn", "2026-12-30", "off")).toBe(false);
    expect(inSeason("Autumn", "2027-10-12", "school")).toBe(true);
    expect(inSeason("Autumn Leaves", "2027-08-12", "school")).toBe(false);
    expect(inSeason("Cherry Blossom", "2029-09-12", "school")).toBe(false);
    expect(inSeason("Cherry Blossoms", "2028-04-12", "school")).toBe(true);
    for (const n of ["Surfer", "Surfboard", "Surfing", "Water Slide", "Waterslide"]) {
      expect(inSeason(n, "2027-01-12", "school"), n).toBe(false);
      expect(inSeason(n, "2027-07-12", "off"), n).toBe(true);
    }
    // Guards: no "surf*" stem (Surface) and no bare "fall" (Waterfall).
    for (const n of ["Surface", "Waterfall", "Fall", "Cherry", "Blossom", "Slide"]) expect(seasonalRule(n), n).toBeNull();
  });
});

describe("C8b and C12: top twin and near-name traps", () => {
  it("topTwin returns the most widely made twin", () => {
    const els = [
      { id: "1", name: "Ash", emoji: "🌋" },
      { id: "2", name: "Ashes", emoji: "🪶" },
      { id: "3", name: "ASH", emoji: "x" },
      { id: "4", name: "Comet" },
    ];
    const idx = new TwinIndex(els);
    const reach = (id: string) => ({ "1": 0.376, "2": 0.34, "3": 0.01, "4": 0.1 })[id] ?? 0;
    expect(topTwin(els[0]!, idx, reach)).toEqual({ id: "2", reach: 0.34 });
    expect(topTwin(els[3]!, idx, reach)).toBeNull();
  });

  it("near-name trap: a containing name made by >= 3x as many players and >= 1%", () => {
    const els = [
      { id: "1", name: "Acid" },
      { id: "2", name: "Acid Rain" },
      { id: "3", name: "Machine" },
      { id: "4", name: "Time Machine" },
      { id: "5", name: "Robot" },
      { id: "6", name: "Robot Arm" },
      { id: "7", name: "Fern" },
      { id: "8", name: "Fern Gardens" },
      { id: "9", name: "Stick" },
      { id: "10", name: "Glow Sticks" },
      { id: "11", name: "Rain" },
    ];
    const r: Record<string, number> = { "1": 0.01, "2": 0.105, "3": 0.015, "4": 0.187, "5": 0.05, "6": 0.1, "7": 0.001, "8": 0.008, "9": 0.0024, "10": 0.023, "11": 0.5 };
    const reach = (id: string) => r[id] ?? 0;
    const idx = new NearNameIndex(els, reach);
    const trap = (id: string) => nearNameTrap(id, els.find((e) => e.id === id)!.name, idx, reach);
    expect(trap("1")).toBe("2");
    expect(trap("3")).toBe("4");
    expect(trap("5")).toBeNull(); // only 2x
    expect(trap("7")).toBeNull(); // 8x, but under NEAR_NAME_MIN_REACH
    expect(trap("9")).toBe("10"); // plural folded per word
    expect(trap("11")).toBeNull(); // Rain is more widely made than Acid Rain
    expect(trap("2")).toBeNull(); // a name never contains itself
    expect(NEAR_NAME_RATIO).toBe(3);
    expect(NEAR_NAME_MIN_REACH).toBe(0.01);
    expect(phraseWords("Glow Sticks")).toEqual(["glow", "stick"]);
  });
});

describe("aha and links", () => {
  // 1,2 starters (steps 0). 10 = 1+2 (steps 1). 20 = 10+1 (steps 2, near-optimal), 20 = 10+10 (cost 3 <= 3: near-optimal too).
  const elements = [
    { id: "1", name: "Water", emoji: "💧" },
    { id: "2", name: "Fire", emoji: "🔥" },
    { id: "10", name: "Steam", emoji: "💨" },
    { id: "20", name: "Steam Engine", emoji: "🚂" },
    { id: "30", name: "Cloud", emoji: "💨" },
  ];
  const steps = new Map<string, number>([["1", 0], ["2", 0], ["10", 1], ["20", 2], ["30", 5]]);
  const pairs = [
    { ingredients: ["1", "2"], result: "10" },
    { ingredients: ["10", "1"], result: "20" },
    { ingredients: ["10", "10"], result: "20" },
    { ingredients: ["10", "2"], result: "30" },
    { ingredients: ["20", "20"], result: "20" }, // self-recipe: ignored
  ];
  const aha = computeAha(elements, pairs, steps);

  it("counts near-optimal recipes and name/emoji links", () => {
    expect(aha.get("20")).toEqual({ nearOpt: 2, nameLink: true, emojiLink: false, aha: Math.log(3) + 0.7 });
    expect(aha.get("30")).toEqual({ nearOpt: 1, nameLink: false, emojiLink: true, aha: Math.log(2) + 0.7 });
    expect(aha.get("1")!.aha).toBe(0);
  });

  it("direct links", () => {
    const link = directLinks(pairs);
    expect(link("10", "20")).toBe(true);
    expect(link("20", "10")).toBe(false);
    expect(link("20", "20")).toBe(false);
  });
});
