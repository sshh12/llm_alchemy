// School-safety filter for daily-challenge TARGETS (scripts/lib/challenges.ts buildPools and
// scripts/check-challenges.ts). A target is a prompt every player sees ("make Murder"), and a
// large share of players are under-13 classrooms on school iPads, where one teacher-visible
// prompt like that can get the site blocked for a whole district. So the bar is "fine to project
// in a primary-school classroom", and when in doubt a name is excluded: excluding a target only
// shrinks a candidate pool; the element itself stays fully playable.
//
// Matching: each term is a whole word or phrase, case-insensitive, at word boundaries, with an
// optional plural "s" ("Gun" and "Guns" but not "Gunsmoke" or "Begun"; "Hell" but not "Shell";
// no "es", which turned "Gang" into "Ganges"). Spaces in a phrase also match a hyphen
// ("Self Harm" = "Self-Harm"). Compounds written as one word must be listed on their own
// ("shotgun", "roadkill", "gunpowder"), as must irregular plurals ("knives"); COMPOUND_STEMS
// below only feeds a human review list.
//
// Deliberately NOT denied, because the plain meaning is everyday or school content and the
// denied phrases around them catch the bad uses: blood (biology; "bloody", "bloodshed",
// "blood diamond" are denied), explosion, nuclear, army, tank, cannonball, skeleton, skull,
// ghost, witch, god/angel/heaven/temple (mythology and landmarks), punch (the drink), hanging
// (gardens, baskets), dealer (cards, art), die (dice), axe (a woodcutting tool; "battleaxe" is
// denied), bar (chocolate, iron), cider (apple juice in the US). The game's own "Bar" and "Cider"
// elements are the pub and the drink (Alcohol + Apple, a beer emoji), so those exact names are in
// CHALLENGE_DENY below instead; the words stay allowed in other names.
//
// Emoji: EMOJI_DENY (tobacco, alcohol, coffin, headstone) denies a target whatever its name, with no
// false positive among the Nov 2026 candidates; EMOJI_REVIEW is a broader set with real false
// positives (Pirate ☠️, Medicine 💊, Laser 🔫), so it only feeds the generator's review printout.
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
    // Teacher-risk review for the pred-v6 generator (Nov 2026): war gear and one-word compounds
    // of denied words. Listed explicitly (no stem rule): a stem rule would also hit Warehouse,
    // Warning Sign, Swordfish and Deadlock.
    "shrapnel", "bulletproof", "gas mask", "gunpowder", "warhammer", "swordsman", "swordsmen", "swordsmith",
    // Nov 2026 plan review: compounds of denied words ("battle", "attack") and a ray gun.
    "battleship", "blaster", "cyberattack",
  ],
  death: [
    "death", "dead", "dying", "deadly", "kill", "killer", "killing", "killed", "murder", "murderer", "assassin",
    "assassination", "execution", "executioner", "homicide", "corpse", "carcass", "cadaver", "zombie", "undead",
    "grave", "graveyard", "gravestone", "tombstone", "coffin", "casket", "funeral", "cemetery", "morgue",
    "grim reaper", "reaper", "poison", "poisoned", "poisoning", "guillotine", "gallows", "noose",
    "electric chair", "doomsday", "apocalypse", "plague", "black death", "famine", "pandemic", "cancer",
    "hearse", "necropolis", "mortuary",
    // Named real-world mass-casualty disasters.
    "chernobyl", "hindenburg",
    // Nov 2026 plan review: burial ("coffin" and "grave" are denied), poison and cancer synonyms,
    // and "apocalyptic", which the whole-word "apocalypse" does not catch ("Post-Apocalyptic").
    "tomb", "toxin", "tumor", "tumour", "apocalyptic",
  ],
  drugs: [
    "drug", "cocaine", "heroin", "meth", "methamphetamine", "marijuana", "cannabis", "weed", "opium", "opioid",
    "narcotic", "overdose", "lsd", "ecstasy", "stoner", "pot leaf", "hotbox", "bong", "munchies",
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
  tobacco: ["tobacco", "cigarette", "cigar", "nicotine", "vape", "vaping", "hookah", "ashtray"],
  sexual: [
    "sex", "sexy", "porn", "nude", "naked", "stripper", "prostitute", "hooker", "condom", "erotic", "orgasm",
    "brothel", "lingerie", "boob", "penis", "vagina", "seduction", "lust", "playboy", "fetish", "viagra", "harem",
    "lubricant", "love triangle",
  ],
  hate: [
    "nazi", "hitler", "swastika", "kkk", "terrorist", "terrorism", "terror", "genocide", "holocaust", "racist",
    "racism", "slave", "slavery", "supremacist", "supremacy", "fascist", "fascism", "extremist", "dictator",
    "blood diamond", "plantation",
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
    "jail", "mugshot", "panic room", "forgery", "prisoner", "jailhouse",
    "abomination",
  ],
  occult: [
    "hell", "hellfire", "hellhound", "satan", "satanic", "lucifer", "demon", "devil", "antichrist", "occult", "ouija", "exorcism", "warlock",
    // Demon and underworld synonyms (Nov 2026 plan review).
    "fiend", "netherworld", "hellgate",
  ],
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

/**
 * Exact target names a human reviewer rejected (weekly read of the planned names, docs: spec
 * §9.2), compared by foldKey(nameKey(name)). The fast fix for a teacher-visible miss: add the name,
 * re-plan; check-challenges reports stored days that use one as broken ("challenge-deny").
 * Elements stay fully playable; they are only never challenge targets.
 */
export const CHALLENGE_DENY: ReadonlySet<string> = new Set(
  [
    // The game's pub, alcoholic cider, a cocktail without alcohol (made almost only via Cocktail),
    // and a park of war and disaster memorials (Nov 2026 plan review). The words stay allowed.
    "Bar", "Cider", "Mocktail", "Memorial Park",
    // Interim teacher list until the classifier's teacher flag exists (spec §7): romance and
    // reproduction, religious practice, disease, military acts and gear, adult media and finance,
    // and adult abstractions kids don't know. Army, Witch, Ghost and Skeleton stay allowed (policy).
    "Marriage", "Honeymoon", "Matchmaker", "Massage", "Parent", "Child", "Date",
    "Prayer", "Worship", "Scripture", "Belief", "Nirvana",
    "Outbreak", "Infection", "Infestation", "Vaccine",
    "Siege", "Mutiny", "Soldier", "Military Uniform", "Armored Vehicle", "Bunker",
    "Cryptocurrency", "Tabloid", "Paparazzi", "Cover-Up", "Social Media", "Influencer", "Fallout",
    "Bureaucracy", "Inflation",
    // Franchise and brand names (a daily target promotes them to every player, and missing art is
    // generated live): Amazon, Discord, Star Wars, DC, Toho, Terminator, Marvel, Skyrim.
    "Amazon", "Discord", "Jedi", "Sith", "Lightsaber", "Batmobile", "Aquaman", "Godzilla", "Terminator",
    "Sharknado", "Adamantium", "Dragonborn", "Jacuzzi",
    // Rollout review of the review-emoji list (2026-11-23): gore, weapons drawn as weapons (axe,
    // swords, gun, bomb), champagne imagery, and demons/religious objects. Medicine, Cure,
    // Antibiotic, Monster and Pendant stay allowed.
    "Blood", "Double-Axe", "Duel", "Laser", "Cannonball", "Bottle", "Glassware",
    "Pandemonium", "Underworld", "Bogeyman", "Altar",
  ].map((n: string) => foldKey(nameKey(n))),
);

export const isChallengeDenied = (name: string): boolean => CHALLENGE_DENY.has(foldKey(nameKey(name)));

/** Emoji compared without variation selectors ("⚰️" = "⚰"). */
export const emojiKey = (emoji: string): string => emoji.replace(/[\uFE0E\uFE0F]/g, "").trim();

/** Target emoji denied outright (tobacco, alcohol, coffin, headstone): no false positive in the Nov 2026 candidates. */
export const EMOJI_DENY: Readonly<Record<string, SafetyCategory>> = Object.fromEntries(
  (
    [
      ["🚬", "tobacco"],
      ["🍺", "alcohol"],
      ["🍻", "alcohol"],
      ["🍷", "alcohol"],
      ["🥃", "alcohol"],
      ["🍸", "alcohol"],
      ["⚰️", "death"],
      ["🪦", "death"],
    ] as const
  ).map(([e, c]) => [emojiKey(e), c]),
);

/** Emoji worth a human look (real false positives: Pirate ☠️, Medicine 💊, Laser 🔫, Bracelet 📿): review printout only. */
export const EMOJI_REVIEW: ReadonlySet<string> = new Set(
  ["☠️", "💊", "🔫", "📿", "🥂", "🍾", "💣", "⚔️", "🗡️", "🪓", "🪖", "👹", "😈", "🕉️", "🛐", "🩸", "💉"].map(emojiKey),
);

/** The EMOJI_DENY verdict for a target's emoji (null/empty emoji: ok here; the generator requires one separately). */
export function emojiSafety(emoji: string | null | undefined): SafetyVerdict {
  if (!emoji) return { ok: true };
  const category = EMOJI_DENY[emojiKey(emoji)];
  return category ? { ok: false, category, match: emoji } : { ok: true };
}

/**
 * Stems of denied words that also start harmless compounds (Warehouse, Swordfish, Deadlock), so
 * they are NOT matched automatically: the generator's review printout lists pool names with a
 * word that starts with one of them (and is longer), for a human to decide (add the compound to
 * DENYLIST, or leave it).
 */
export const COMPOUND_STEMS: readonly string[] = [
  "war", "sword", "gun", "bullet", "prison", "jail", "bomb", "grave", "coffin", "poison", "zombie", "corpse",
  "kill", "murder", "drug", "beer", "wine", "dead", "blood", "knife", "blade", "hell", "demon", "devil", "slave",
];

/** Words of `name` that start with a COMPOUND_STEMS stem and are 2+ letters longer (review list only). */
export function compoundHits(name: string): string[] {
  const out: string[] = [];
  for (const w of cleanName(name).toLowerCase().split(/[^a-z]+/)) {
    if (COMPOUND_STEMS.some((st) => w.length >= st.length + 2 && w.startsWith(st))) out.push(w);
  }
  return out;
}
