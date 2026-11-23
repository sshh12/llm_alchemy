import { describe, expect, it } from "vitest";
import { ALLOWED, CHALLENGE_DENY, compoundHits, DENYLIST, EMOJI_DENY, EMOJI_REVIEW, emojiKey, emojiSafety, isChallengeDenied, isSchoolSafe, schoolSafety } from "./schoolSafety.ts";

describe("schoolSafety", () => {
  it("denies the target names flagged in the Nov 2026 review", () => {
    for (const name of ["Murder", "Rifle", "Roadkill", "Panic Room", "Death", "Poison", "Drug", "Gun", "Rum", "Whisky", "Zombie", "Sake", "Hell", "Crusade"]) {
      expect(isSchoolSafe(name), name).toBe(false);
    }
  });

  it("reports the category and the matched words", () => {
    expect(schoolSafety("Machine Gun")).toEqual({ ok: false, category: "violence", match: "Machine Gun" });
    expect(schoolSafety("Drunk Driving")).toEqual({ ok: false, category: "alcohol", match: "Drunk" });
    expect(schoolSafety("Holy War")).toEqual({ ok: false, category: "violence", match: "Holy War" });
    expect(schoolSafety("Self-Harm").category).toBe("self-harm");
    expect(schoolSafety("Nazi Germany").category).toBe("hate");
    expect(schoolSafety("Messiah").category).toBe("religion");
    // Added after reviewing the first v4 re-picks.
    for (const name of ["Lockdown", "Flamethrower", "Sect", "Forgery", "Rusty Blade", "Famine"]) expect(isSchoolSafe(name), name).toBe(false);
  });

  it("denies the scheduled and pool names a Nov 2026 re-review found (one-word compounds, drinks, slang)", () => {
    for (const name of [
      "Kidnapper", "Mojito", "Hot Toddy", "Firewater", "Jungle Juice", "Hotbox", "Bartender", "Eskimo", "Squirtgun",
      "Gunfight", "Gunner", "Warhead", "Smokebomb", "Shotglass", "Shot Glass", "Pub", "Grog", "Daiquiri", "Piña Colada",
      "Katana", "Cutlass", "Greatsword", "Longsword", "Broadsword", "Battleaxe", "Saber", "Warship", "Spear",
    ]) {
      expect(isSchoolSafe(name), name).toBe(false);
    }
  });

  it("matches whole words, case-insensitively, with plurals, hyphens and apostrophes", () => {
    for (const name of ["GUNS", "zombies", "Crusades", "Cyber-Hell", "Hell's Gate", "Self Harm", "self-harm", "Post-Apocalypse", "Time Bomb", "Rosé Wine"]) {
      expect(isSchoolSafe(name), name).toBe(false);
    }
  });

  it("does not match inside other words", () => {
    for (const name of [
      "Shell", "Hello", "Gunsmoke", "Begun", "Drum", "Rumble", "Seaweed", "Tumbleweed", "Swordfish", "Ganges",
      "Skill", "Glass", "Bass", "Methane", "Warm", "Warsaw", "Sussex", "Butterfly", "Stable", "Kale", "Begin",
      "Pomegranate", "Christmas", "Grassland", "Skeleton", "Ghost", "Explosion", "Blood Cell", "Fruit Punch",
      "Hanging Gardens of Babylon", "Card Dealer", "Phoenix", "Volcano", "Geyser", "Steam", "Mud", "Insect",
      "Culture", "Rollerblade", "Section", "Axe", "Pickaxe", "Publish", "Spearmint", "Warrior",
      "Chocolate Bar", "Apple Cider", "Sabertooth",
    ]) {
      expect(isSchoolSafe(name), name).toBe(true);
    }
  });

  it("allows only exact allowlisted names, ignoring case and hyphens", () => {
    for (const name of ["Root Beer", "root beer", "Killer Whale", "Dust Devil", "Dust-Devil", "Poison Ivy", "Shooting Star", "Glue Gun", "Bath Bomb", "Saber-Toothed Tiger"]) {
      expect(isSchoolSafe(name), name).toBe(true);
    }
    // Compounds around an allowed name are judged on their own.
    for (const name of ["Root Beer Keg Stand Whisky", "Steam-Powered Bullet Train", "Killer Whale Killer", "Devil"]) {
      expect(isSchoolSafe(name), name).toBe(false);
    }
  });

  it("excludes toy guns (documented decision)", () => {
    for (const name of ["Water Pistol", "Water Gun", "Squirt Gun", "Squirtgun", "Watergun", "Nail Gun", "Toy Gun"]) expect(isSchoolSafe(name), name).toBe(false);
  });

  it("denies the pred-v6 teacher-risk review terms (whole words, plural s, explicit compounds)", () => {
    const cases: [string, string][] = [
      ["Plantation", "hate"], ["Hearse", "death"], ["Necropolis", "death"], ["Mortuary", "death"], ["Munchies", "drugs"],
      ["Lubricant", "sexual"], ["Love Triangle", "sexual"], ["Shrapnel", "violence"], ["Bulletproof", "violence"],
      ["Gas Mask", "violence"], ["Gas-Mask", "violence"], ["Gunpowder", "violence"], ["Warhammer", "violence"], ["Swordsman", "violence"],
      ["Swordsmith", "violence"], ["Prisoner", "crime-gore"], ["Prisoners", "crime-gore"], ["Jailhouse", "crime-gore"], ["Warlock", "occult"],
      ["Chernobyl", "death"], ["Hindenburg", "death"], ["Bulletproof Vest", "violence"],
    ];
    for (const [name, category] of cases) expect(schoolSafety(name).category, name).toBe(category);
  });

  it("keeps the harmless compounds a stem rule would have caught", () => {
    for (const name of ["Warehouse", "Warning Sign", "Swordfish", "Deadlock", "Warrior", "Warriors", "Plant", "Mask", "Triangle", "Gas"]) {
      expect(isSchoolSafe(name), name).toBe(true);
    }
    // ...but lists them for a human (generator review printout).
    expect(compoundHits("Warehouse")).toEqual(["warehouse"]);
    expect(compoundHits("Swordfish Tank")).toEqual(["swordfish"]);
    expect(compoundHits("War")).toEqual([]);
    expect(compoundHits("Warm Front")).toEqual([]); // "warm" is only 1 letter longer than "war"
    expect(compoundHits("Volcano")).toEqual([]);
  });

  it("CHALLENGE_DENY matches exact names only", () => {
    expect(CHALLENGE_DENY.size).toBeGreaterThanOrEqual(0);
    expect(isChallengeDenied("Volcano")).toBe(false);
  });

  it("denies the Nov 2026 plan-review misses (tobacco, burial, poison and disease, occult, weapons)", () => {
    const cases: [string, string][] = [
      ["Ashtray", "tobacco"], ["Tomb", "death"], ["Tombs", "death"], ["Toxin", "death"], ["Toxins", "death"], ["Tumor", "death"],
      ["Tumour", "death"], ["Post-Apocalyptic Wasteland", "death"], ["Apocalyptic", "death"], ["Fiend", "occult"], ["Netherworld", "occult"],
      ["Hellgate", "occult"], ["Eldritch Abomination", "crime-gore"], ["Battleship", "violence"], ["Blaster", "violence"], ["Cyberattack", "violence"],
    ];
    for (const [name, category] of cases) expect(schoolSafety(name).category, name).toBe(category);
    // Neighbours stay allowed: the matching is whole-word.
    for (const name of ["Toxic", "Blast", "Tombola", "Ship", "Cyber", "Bar", "Cider", "Chocolate Bar", "Apple Cider Vinegar"]) expect(isSchoolSafe(name), name).toBe(true);
  });

  it("CHALLENGE_DENY: the interim teacher list, drinks, memorials and franchise names (exact names)", () => {
    for (const name of ["Bar", "Cider", "Mocktail", "Memorial Park", "Marriage", "Date", "Cover-Up", "Cover Up", "social media", "Nirvana", "Bunker", "Amazon", "Jedi", "Sith", "Jacuzzi", "Bureaucracy"]) {
      expect(isChallengeDenied(name), name).toBe(true);
    }
    for (const name of ["Chocolate Bar", "Apple Cider", "Amazon Rainforest", "Date Palm", "Army", "Witch", "Ghost", "Skeleton", "Park", "Media"]) expect(isChallengeDenied(name), name).toBe(false);
  });

  it("emojiSafety: the strict emoji set denies, with or without the variation selector; the review set does not", () => {
    expect(emojiSafety("🍺")).toMatchObject({ ok: false, category: "alcohol" });
    expect(emojiSafety("🚬")).toMatchObject({ ok: false, category: "tobacco" });
    expect(emojiSafety("⚰️")).toMatchObject({ ok: false, category: "death" });
    expect(emojiSafety("⚰")).toMatchObject({ ok: false, category: "death" });
    expect(emojiSafety("🪦").ok).toBe(false);
    for (const e of ["☠️", "💊", "🔫", "🌋", null, undefined, ""]) expect(emojiSafety(e).ok, String(e)).toBe(true);
    expect(EMOJI_REVIEW.has(emojiKey("☠️"))).toBe(true);
    expect(EMOJI_REVIEW.has(emojiKey("🍺"))).toBe(false);
    expect(Object.keys(EMOJI_DENY)).toHaveLength(8);
  });

  it("keeps the lists normalized", () => {
    for (const terms of Object.values(DENYLIST)) {
      for (const t of terms) expect(t).toBe(t.toLowerCase().trim());
    }
    for (const key of ALLOWED) expect(key).toBe(key.toLowerCase());
  });
});
