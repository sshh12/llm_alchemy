// School-safety filter for daily-challenge TARGETS (scripts/lib/challenges.ts buildPools and
// scripts/check-challenges.ts). A target is a prompt every player sees ("make Murder"), and a
// large share of players are under-13 classrooms on school iPads, where one teacher-visible
// prompt like that can get the site blocked for a whole district. So the bar is "fine to project
// in a primary-school classroom", and when in doubt a name is excluded: excluding a target only
// shrinks a candidate pool; the element itself stays fully playable.
//
// Matching: each term is a whole word or phrase, case-insensitive, at word boundaries, with an
// optional plural "s" ("Gun" and "Guns" but not "Gunpowder" or "Begun"; "Hell" but not "Shell";
// no "es", which turned "Gang" into "Ganges"). Spaces in a phrase also match a hyphen
// ("Self Harm" = "Self-Harm"). Compounds written as one word must be listed on their own
// ("shotgun", "roadkill"), as must irregular plurals ("knives").
//
// Deliberately NOT denied, because the plain meaning is everyday or school content and the
// denied phrases around them catch the bad uses: blood (biology; "bloody", "bloodshed",
// "blood diamond" are denied), explosion, nuclear, army, tank, cannonball, skeleton, skull,
// ghost, witch, god/angel/heaven/temple (mythology and landmarks), punch (the drink), hanging
// (gardens, baskets), dealer (cards, art), die (dice), axe (a woodcutting tool; "battleaxe" is
// denied), bar (chocolate, iron), cider (apple juice in the US).
//
// ALLOWED: a short list of exact full names whose flagged word has a different, harmless meaning
// there (a soda, an animal, a plant, a tool, a geology term). Decision on toy guns: "Water
// Pistol", "Water Gun", "Squirt Gun" and the like are NOT allowed: many schools apply
// zero-tolerance rules to toy guns too, and the pools are big enough to lose them. Add a name
// only when it is unambiguous to a 7-year-old and to a teacher reading over their shoulder.
import { cleanName, foldKey, nameKey } from "../../src/shared/names.ts";

export type SafetyCategory =
  | "violence"
  | "death"
  | "drugs"
  | "alcohol"
  | "tobacco"
  | "sexual"
  | "hate"
  | "religion"
  | "self-harm"
  | "crime-gore"
  | "occult"
  | "profanity";

/** Denied whole words/phrases per category (lowercase; see the matching rules above). */
export const DENYLIST: Record<SafetyCategory, readonly string[]> = {
  violence: [
    "gun", "handgun", "shotgun", "gunshot", "gunfire", "gunman", "machine gun", "firearm", "rifle", "pistol",
    "revolver", "musket", "bullet", "ammo", "ammunition", "grenade", "bomb", "nuke", "missile", "bazooka",
    "rocket launcher", "landmine", "land mine", "torpedo", "sniper", "shooting", "shooter", "assault", "weapon",
    "cannon", "sword", "dagger", "knife", "knives", "machete", "switchblade", "bayonet", "war", "warfare",
    "warzone", "battle", "battlefield", "bloodshed", "massacre", "slaughter", "combat", "attack", "violence",
    "violent", "stab", "explosive", "dynamite", "tnt", "c4", "napalm", "conquest", "flamethrower", "crossbow",
    "blade", "nuclear explosion", "nuclear fallout", "mushroom cloud",
    // One-word compounds (the plural "s" is the only suffix matched; see the top).
    "squirtgun", "watergun", "raygun", "gunfight", "gunner", "gunslinger", "gunpoint", "gunboat", "warhead",
    "warship", "warlord", "warplane", "smokebomb", "firebomb", "stinkbomb",
    // Swords and other hand weapons, like "sword" and "blade" above.
    "katana", "cutlass", "longsword", "greatsword", "broadsword", "shortsword", "saber", "sabre", "scimitar",
    "rapier", "battleaxe", "spear", "halberd",
    // US schools run "lockdown" drills for armed intruders.
    "lockdown",
    // Religious wars.
    "crusade", "crusader", "inquisition", "holy war", "jihad",
  ],
  death: [
    "death", "dead", "dying", "deadly", "kill", "killer", "killing", "killed", "murder", "murderer", "assassin",
    "assassination", "execution", "executioner", "homicide", "corpse", "carcass", "cadaver", "zombie", "undead",
    "grave", "graveyard", "gravestone", "tombstone", "coffin", "casket", "funeral", "cemetery", "morgue",
    "grim reaper", "reaper", "poison", "poisoned", "poisoning", "guillotine", "gallows", "noose",
    "electric chair", "doomsday", "apocalypse", "plague", "black death", "famine", "pandemic", "cancer",
  ],
  drugs: [
    "drug", "cocaine", "heroin", "meth", "methamphetamine", "marijuana", "cannabis", "weed", "opium", "opioid",
    "narcotic", "overdose", "lsd", "ecstasy", "stoner", "pot leaf", "hotbox", "bong",
  ],
  alcohol: [
    "alcohol", "alcoholic", "beer", "wine", "whisky", "whiskey", "vodka", "rum", "gin", "tequila", "sake",
    "champagne", "cocktail", "liquor", "brandy", "bourbon", "scotch", "mead", "ale", "lager", "moonshine",
    "booze", "drunk", "hangover", "brewery", "distillery", "margarita", "martini", "sangria", "absinthe",
    "bar fight", "mojito", "daiquiri", "pina colada", "toddy", "grog", "keg", "jungle juice", "pub", "tavern",
    "saloon", "bartender", "shot glass", "shotglass",
    // Drink slang and an ethnic slur at once.
    "firewater",
  ],
  tobacco: ["tobacco", "cigarette", "cigar", "nicotine", "vape", "vaping", "hookah"],
  sexual: [
    "sex", "sexy", "porn", "nude", "naked", "stripper", "prostitute", "hooker", "condom", "erotic", "orgasm",
    "brothel", "lingerie", "boob", "penis", "vagina", "seduction", "lust", "playboy", "fetish", "viagra", "harem",
  ],
  hate: [
    "nazi", "hitler", "swastika", "kkk", "terrorist", "terrorism", "terror", "genocide", "holocaust", "racist",
    "racism", "slave", "slavery", "supremacist", "supremacy", "fascist", "fascism", "extremist", "dictator",
    "blood diamond",
    // Ethnic slurs that read as plain words.
    "eskimo",
  ],
  // Sacred figures: "make <prophet>" by mixing elements is offensive to some families.
  religion: ["messiah", "prophet", "jesus", "christ", "allah", "muhammad", "mohammed", "crucifixion", "cult", "sect"],
  "self-harm": ["suicide", "suicidal", "self harm"],
  "crime-gore": [
    "roadkill", "gore", "gory", "bloody", "bloodbath", "guts", "decapitation", "dismemberment", "mutilation",
    "torture", "carnage", "cannibal", "cannibalism", "crime", "criminal", "robbery", "robber", "heist", "kidnap",
    "kidnapping", "kidnapper", "hostage", "arson", "arsonist", "gangster", "gang", "thug", "mafia", "cartel", "prison",
    "jail", "mugshot", "panic room", "forgery",
  ],
  occult: ["hell", "hellfire", "hellhound", "satan", "satanic", "lucifer", "demon", "devil", "antichrist", "occult", "ouija", "exorcism"],
  profanity: ["damn", "crap", "shit", "fuck", "ass", "bitch", "bastard", "piss", "butt", "poop", "fart"],
};

/**
 * Exact full names (compared by foldKey(nameKey(name)), so case, hyphens and apostrophes do not
 * matter) that are allowed although they contain a denied word.
 */
export const ALLOWED: ReadonlySet<string> = new Set(
  [
    // Drinks without alcohol, food, tools.
    "Root Beer", "Root Beer Float", "Ginger Beer", "Ginger Ale", "Shrimp Cocktail", "Fruit Cocktail",
    "Scotch Tape", "Scotch Egg", "Cotton Gin", "Glue Gun", "Hot Glue Gun", "Paint Stripper", "Wire Stripper",
    "Bath Bomb", "Bullet Train", "Blade of Grass", "Grass Blade",
    // Animals, plants, weather, geology, geography.
    "Killer Whale", "Pistol Shrimp", "Tasmanian Devil", "Dust Devil", "Steam Devil", "Poison Ivy", "Poison Oak",
    "Poison Dart Frog", "Corpse Flower", "Lava Bomb", "Volcanic Bomb", "Dead Sea", "Shooting Star", "Shooting Stars",
    "Saber-Toothed Tiger", "Sabre-Toothed Tiger", "Saber-Tooth Tiger", "Sabre-Tooth Tiger", "Saber-Toothed Cat",
  ].map((n) => foldKey(nameKey(n))),
);

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const termSource = (term: string) => escape(term).replace(/[ -]/g, "[\\s-]+");

const CATEGORY_RES = (Object.entries(DENYLIST) as [SafetyCategory, readonly string[]][]).map(([category, terms]) => ({
  category,
  // Longest first so "machine gun" reports as itself rather than "gun".
  re: new RegExp(`\\b(?:${[...terms].sort((a, b) => b.length - a.length).map(termSource).join("|")})s?\\b`, "i"),
}));

export interface SafetyVerdict {
  ok: boolean;
  category?: SafetyCategory;
  /** The denied word or phrase as it appears in the name. */
  match?: string;
}

/** Whether `name` is fine as a daily-challenge target for an under-13 classroom (see top). */
export function schoolSafety(name: string): SafetyVerdict {
  if (ALLOWED.has(foldKey(nameKey(name)))) return { ok: true };
  const clean = cleanName(name); // diacritics folded: "Rosé Wine" is matched as "Rose Wine"
  for (const { category, re } of CATEGORY_RES) {
    const m = re.exec(clean);
    if (m) return { ok: false, category, match: m[0] };
  }
  return { ok: true };
}

export const isSchoolSafe = (name: string): boolean => schoolSafety(name).ok;
