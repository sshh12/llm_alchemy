import { describe, expect, it } from "vitest";
import { ALLOWED, DENYLIST, isSchoolSafe, schoolSafety } from "./schoolSafety.ts";

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
      "Shell", "Hello", "Gunpowder", "Begun", "Drum", "Rumble", "Seaweed", "Tumbleweed", "Swordfish", "Ganges",
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

  it("keeps the lists normalized", () => {
    for (const terms of Object.values(DENYLIST)) {
      for (const t of terms) expect(t).toBe(t.toLowerCase().trim());
    }
    for (const key of ALLOWED) expect(key).toBe(key.toLowerCase());
  });
});
