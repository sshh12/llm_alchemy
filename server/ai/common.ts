// Types, errors and output validation shared by the live and mock AI backends.
import { checkName, cleanName, foldKey, nameKey, titleCase } from "../../src/shared/names.ts";

/** A validated element proposal, ready to be stored. */
export interface ElementProposal {
  /** Display name ("Steam", "Isaac Newton"). */
  name: string;
  /** Unique identity (elements.name_key). */
  key: string;
  /** Loose identity used to reuse near-duplicates (elements.fold_key). */
  foldKey: string;
  emoji: string | null;
  description: string | null;
  notable: boolean;
  /** Short visual description for the image model (the LLM's "icon" field). */
  artHint: string | null;
}

/** A result the model must not give for this combination, with feedback for the retry. */
export interface AvoidResult {
  /** elements.name_key of the forbidden result. */
  key: string;
  /** e.g. "that is what Fire + Water already makes". */
  because: string;
}

export interface GeneratedImage {
  bytes: Uint8Array;
  ext: "webp" | "png";
  contentType: string;
}

/** The model could not produce a valid element (after one corrective retry). Nothing is saved. */
export class Fizzled extends Error {
  constructor(readonly reason: string) {
    super(`fizzled: ${reason}`);
    this.name = "Fizzled";
  }
}

/** The AI provider failed (network, timeout, 5xx, quota). */
export class AiUnavailable extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "AiUnavailable";
  }
}

/** The image model's safety system refused the subject. Never retry it. */
export class Blocked extends Error {
  constructor() {
    super("image blocked by moderation");
    this.name = "Blocked";
  }
}

const MAX_DESCRIPTION_CHARS = 160;
const PICTOGRAPHIC = /\p{Extended_Pictographic}|\p{Regional_Indicator}/u;
const segmenter = new Intl.Segmenter("en", { granularity: "grapheme" });

/** First grapheme if it is an emoji, else null (the client then shows a generic placeholder). */
export function sanitizeEmoji(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const first = segmenter.segment(raw.trim())[Symbol.iterator]().next().value?.segment;
  return first && first.length <= 16 && PICTOGRAPHIC.test(first) ? first : null;
}

/** One line of plain text, capped at a word boundary. */
export function sanitizeDescription(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  let s = raw.replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu, " ").replace(/\s+/g, " ").trim();
  if (s.length > MAX_DESCRIPTION_CHARS) {
    const cut = s.slice(0, MAX_DESCRIPTION_CHARS - 1);
    s = `${cut.slice(0, Math.max(cut.lastIndexOf(" "), 40)).replace(/[\s,;:.-]+$/, "")}…`;
  }
  return s.length > 0 ? s : null;
}

/** Keep the model's casing ("iPhone", "DNA"), but title-case an all-lowercase answer. */
export function displayName(raw: string, key: string): string {
  const cleaned = cleanName(raw);
  return cleaned === cleaned.toLowerCase() ? titleCase(key) : cleaned;
}

export type ProposalCheck = { ok: true; proposal: ElementProposal } | { ok: false; reason: string };

const STARTERS = new Set(["earth", "water", "air", "fire", "time"]);
/** Echo check: results that merely restate a common ingredient. */
const SYNONYMS: Record<string, string[]> = {
  air: ["wind", "breeze", "gust", "draft", "draught"],
  fire: ["flame", "flames", "blaze"],
  earth: ["soil", "dirt"],
  clock: ["timepiece", "watch"],
  stone: ["rock", "pebble"],
  rock: ["stone", "pebble"],
  human: ["person", "people"],
  water: ["liquid"],
  coffee: ["espresso", "brew"],
  time: ["clock"],
  lightning: ["electricity", "thunderbolt", "spark"],
};
const squash = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, "");
const SMALL_WORDS = new Set(["of", "the", "and", "a", "an", "in", "on", "at", "to", "for", "de", "da", "von"]);
const stem = (w: string) => w.replace(/(ed|y|s|es)$/, "");

function permutations<T>(arr: T[]): T[][] {
  return arr.length <= 1 ? [arr] : arr.flatMap((x, i) => permutations([...arr.slice(0, i), ...arr.slice(i + 1)]).map((r) => [x, ...r]));
}

/** `n` is `parts` glued in order, each join optionally sharing 1-2 letters (Dream + Machine = "Dreamachine"). */
function gluesTo(parts: string[], n: string, at = 0, i = 0): boolean {
  if (i === parts.length) return at === n.length;
  const p = parts[i]!;
  for (let k = 0; k <= (i === 0 ? 0 : Math.min(2, at, p.length - 1)); k++) {
    if (n.slice(at - k, at) === p.slice(0, k) && n.startsWith(p.slice(k), at) && gluesTo(parts, n, at + p.length - k, i + 1)) return true;
  }
  return false;
}

// ---------------------------------------------------------------- anti-pattern names
// The naming ladders the 2023-2025 model produced and the purge removed (docs/ARCHITECTURE.md,
// "Element purge"): counted forms (Double Flag -> Quadruple Flag, Doublejar, Twin Wizard,
// Sixty-Four), hype words (Megageyser, Mega Ultra Robot) and meme-suffix mashups (Cakeception,
// Smogzilla, Mythpunk). Each relabels an ingredient instead of naming a new thing, draws the same
// picture again, and starts an endless series of near-duplicates. Established terms are allowed.

/**
 * Real words and established terms that look like one of those patterns. Matched squashed (so
 * "Double-Decker" = "double decker"), as the whole name or as a run of words inside it, with an
 * optional plural "s"/"es". Also exempts the established term from the ingredient-glue check
 * (Steam + Punk = Steampunk, Super + Volcano = Supervolcano, Snow + Man = Snowman).
 */
const ESTABLISHED = new Set(
  `double bass | double decker | double agent | double rainbow | double helix | double dutch | double vision | double trouble |
  double shot | double scoop | double dip | double chin | double cross | double take | double jeopardy | double fault | double header |
  double feature | double barrel shotgun | double barreled shotgun | double bed | double boiler | double star | double edged sword |
  double sided tape | double headed eagle | double espresso | double cheeseburger | double axe | double bladed axe | double dragon |
  double fudge | double play | double double | double dare | doubletree | doublemint | doublet | doubloon | double o seven |
  triple crown | triple jump | triple threat | triple decker | triple decker sandwich | triple axel | triple point | triple goddess |
  triple sec | triple play | triple entente | triple alliance | triple h | triplet | quadruplet | quintuplet | sextuplet | septuplet |
  octuplet | quadruplex | quadruple bypass | tuple | tuplet | scruple | twin | twins | identical twins | twin peaks | twin towers |
  twin cities | twin prime | twin flame | twin bed | twin engine | dynamic duo | comedy duo | dual core | dual screen | dualshock |
  quad bike | quadcopter | quad core | string quartet | barbershop quartet | jazz trio | piano trio | brass quintet | eightfold path |
  dual line kite | double edged | double bladed sword | doubles | triple shot | big three | big four | big five | one billion |
  twelve days of christmas | thousand and one nights | megamouth shark | colossal squid | infinite staircase |
  twenty first century | twenty one | forty two | one hundred | one thousand | one million | seven seas | seven wonders |
  four seasons | nine lives | three musketeers | seven dwarfs | three little pigs | ten commandments | seven deadly sins |
  big bang | big ben | big dipper | big apple | big top | big cat | big mac | big bad wolf | big brother | big bird | big wheel |
  big hero 6 | big foot | giant panda | giant squid | giant sequoia | giant tortoise | giant octopus | giant pacific octopus |
  giant clam | giant isopod | giant salamander | giant anteater | giant redwood | giant slalom | giant sloth | giant kelp |
  super bowl | super mario | super saiyan | super soldier | super glue | super speed | super nintendo | super sentai |
  supreme court | supreme being | ultimate frisbee | mega man | mega city | titanic | extraterrestrial |
  infinity gauntlet | infinity stone | infinity pool | infinity mirror | infinity scarf | infinity symbol | infinite loop |
  superior | superintendent | supervisor | supervision | supermarket | superman | supermen | superwoman | supergirl | superboy |
  superhero | superheroine | supervillain | supernatural | supernova | supernovae | superstar | superstition | superstitious |
  superficial | superfluous | superpower | superhuman | supermodel | supersonic | supercar | supercharger | supercharged |
  supercomputer | superconductor | superconductivity | superglue | supermassive | supermassive black hole | superlative |
  superstructure | superstore | superhighway | supercontinent | supercell | supercluster | supervolcano | supergiant | superbug |
  superposition | superfluid | superfood | superfruit | superbloom | superstorm | superalloy | superyacht | superbike | supertanker |
  supermoon | superorganism | superball | supercollider | superdome | superego | superscript | supersymmetry | supergroup |
  superintelligence | supercenter | superfund | supersize | supersede | superimpose |
  megaphone | megatron | megazord | megalith | megalithic | megalodon | megafauna | megaton | megawatt | megabyte | megahertz |
  megapixel | megavolt | megastar | megastore | megaplex | megacity | megalopolis | megamind | megastructure | megachurch |
  megatherium | megalosaurus | megalosaur | megaraptor | megacorporation | megacorp | megaregion | megatsunami | megaflood |
  megadrought | megalomania | megalomaniac | megadeth |
  gigantic | gigantism | gigabyte | gigawatt | gigahertz | gigaton | gigafactory | gigantopithecus | gigantosaurus | gigantosaur |
  giganotosaurus | terabyte | terahertz | terawatt | terabit |
  ultrasound | ultraviolet | ultrasonic | ultramarine | ultramodern | ultralight | ultramarathon | ultraman |
  hyperspace | hyperdrive | hyperloop | hyperlink | hypertext | hyperbole | hyperbola | hyperbolic | hypercube | hypersonic |
  hypernova | hypercar | hyperactive | hyperactivity | hypertension | hyperthermia | hyperventilation | hyperinflation |
  hypermarket | hyperion | hyperbaric | hypersleep | hyperplane | hyperreality | supercharge | superheat | omnivorous |
  omnivore | omnibus | omnipotent | omnipotence | omniscient | omniscience | omnipresent | omnipresence | omniverse | omnitrix |
  inception | conception | deception | perception | reception | exception | interception | contraception | misconception |
  preconception | apocalypse | armageddon | universe | multiverse | metaverse | spiderverse | monsterverse | converse | traverse |
  transverse | perverse | steampunk | cyberpunk | dieselpunk | biopunk | solarpunk | atompunk | clockpunk | cypherpunk |
  frostpunk | electron | neutron | positron | cyclotron | synchrotron | magnetron | betatron | cybertron | voltron | metatron |
  jumbotron | mellotron | metropolis | necropolis | acropolis | cosmopolis | technopolis | heliopolis | tornado | sharknado |
  firenado | aficionado | coronado | carbonado | godzilla | mechagodzilla | mozilla | bridezilla | fantastic | dystopia |
  zootopia | capricorn | dinosaur | pterosaur | plesiosaur | pliosaur | mosasaur | ichthyosaur | titanosaur | hadrosaur |
  allosaur | stegosaur | ankylosaur | tyrannosaur | brontosaur | archosaur | nodosaur | bulbasaur | earthquake | moonquake |
  starquake | seaquake | icequake | marsquake | timequake | tsunami |
  snowman | sandcastle | firefly | rainbow | moonlight | sunlight | starfish | firework | waterfall | sandstorm | snowstorm |
  thunderstorm | firestorm | snowflake | raindrop | sunflower | moonstone | bloodstone | hot air balloon | stone age | ice age |
  iron age | bronze age | golden age | space age | time machine | time travel | steam engine | steamboat`
    .split("|")
    .map(squash)
    .filter(Boolean),
);
const established = (s: string) =>
  ESTABLISHED.has(s) || (s.endsWith("s") && ESTABLISHED.has(s.slice(0, -1))) || (s.endsWith("es") && ESTABLISHED.has(s.slice(0, -2)));

/** Double, triple, quadruple ... decuple, spaced or glued ("Doublejar", "Quadrupled Teapot"). */
const MULTIPLIER = /(doubl|tripl|tupl|cupl|rupl|nupl)/;
const NUMBERS =
  "one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|" +
  "twenty|thirty|forty|fifty|sixty|seventy|eighty|ninety|hundred|thousand|million|billion|trillion";
const NUMBER_WORD = new RegExp(
  `^(${NUMBERS}|first|second|third|fourth|fifth|sixth|seventh|eighth|ninth|tenth|eleventh|twelfth|[a-z]+teenth|[a-z]+tieth|hundredth|thousandth|millionth)$`,
);
const N_FOLD = new RegExp(`^(${NUMBERS}|many|multi|\\d+)+fold$`);
const SMALL_COUNT = /^(two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|both|several|multiple|many)$/;
const COUNT_LEAD = /^(twin|dual|duo|trio|quad|pair)$/;
const COUNT_OF = /^(pair|couple|duo|trio|cluster)$/;
const COUNT_TAIL = /^(twins|duo|trio|quartet|quintet|sextet|septet|octet|pair|squared|cubed)$/;
const COUNT_GLUED = /^(twin|dual)(?!k|ge|ing|ism|ity|ist)[a-z]{4,}$/;
/** Hype/size words used as a prefix ("Mega Mountain", "Ultimate Golem"; "Gas Giant" is fine). "Double" is a multiplier. */
const HYPE_WORD = /^(super|mega|ultra|hyper|giga|tera|omni|uber|extra|giant|big|ultimate|supreme|colossal|gigantic|titanic|infinite|infinity)$/;
const HYPE_GLUED = /^(super|mega|giga|tera|ultra|hyper|omni|uber)[a-z]{3,}$/;
const MEME_SUFFIX = /^[a-z]{3,}(ception|pocalypse|calypse|geddon|verse|punk|tron|opolis|nado|zilla|licious|tastic|topia|icorn|saur|quake|nami)$/;

const quote = (s: string) => `"${s.slice(0, 40)}"`;

/**
 * Counted, hype and meme-suffix names, phrased as feedback for the corrective retry. Proper
 * nouns (`notable`) skip the glued-word, hype and number-word checks (Megatron, Big Ben, Seven Seas),
 * but never the multiplier words.
 */
export function namePatternViolations(name: string, opts: { notable?: boolean } = {}): string[] {
  const toks = name.toLowerCase().replace(/['’]/g, "").split(/[^a-z0-9]+/).filter(Boolean);
  if (toks.length === 0 || established(toks.join(""))) return [];
  // Words covered by an established term inside the name ("Giant Panda Cub"). A lone count or
  // hype word ("Twin", "Titanic") is established only as the whole name, never as a prefix.
  const covered = toks.map(() => false);
  for (let i = 0; i < toks.length; i++) {
    for (let j = i + 1; j <= Math.min(toks.length, i + 4); j++) {
      if (j === i + 1 && [COUNT_LEAD, COUNT_OF, COUNT_TAIL, HYPE_WORD, SMALL_COUNT, NUMBER_WORD].some((re) => re.test(toks[i]!))) continue;
      if (established(toks.slice(i, j).join(""))) covered.fill(true, i, j);
    }
  }
  const free = (i: number) => !covered[i];
  const last = toks.length - 1;
  const notable = opts.notable === true;
  const problems: string[] = [];

  const counted =
    toks.some((t, i) => free(i) && (MULTIPLIER.test(t) || N_FOLD.test(t) || COUNT_GLUED.test(t))) ||
    (toks.length === 1 && /^(pair|duo|trio)$/.test(toks[0]!) && free(0)) ||
    (toks.length > 1 && free(0) && COUNT_LEAD.test(toks[0]!)) ||
    (toks.length > 2 && free(0) && COUNT_OF.test(toks[0]!) && toks[1] === "of") ||
    (toks.length > 1 && free(last) && COUNT_TAIL.test(toks[last]!)) ||
    (!notable && toks.length > 1 && free(0) && free(last) && SMALL_COUNT.test(toks[0]!) && /s$/.test(toks[last]!));
  if (counted) {
    problems.push(
      `${quote(name)} just counts or multiplies an ingredient (Double, Triple, Quadruple, Twin, Pair, Trio, N-fold, "Two Xs"); ` +
        "name the bigger or grouped real thing the copies make (Tree x2 = Forest, Star x3 = Galaxy, Flag x2 = Bunting)",
    );
  }
  if (!notable && toks.filter((t, i) => free(i) && NUMBER_WORD.test(t)).length >= 2) {
    problems.push(`${quote(name)} is arithmetic with number words, not a thing; name a real thing the ingredients make`);
  }
  if (!notable) {
    const hype = toks.find((t, i) => free(i) && ((i < last && HYPE_WORD.test(t)) || HYPE_GLUED.test(t)));
    if (hype) problems.push(`no hype or size prefixes (${quote(hype)}: Super, Mega, Ultra, Hyper, Giga, Giant, Big, Ultimate); name the bigger real thing itself`);
    const meme = toks.find((t, i) => free(i) && MEME_SUFFIX.test(t));
    if (meme) {
      problems.push(
        `${quote(meme)} bolts a trendy suffix onto a word (-ception, -pocalypse, -verse, -punk, -zilla, -nado, -opolis, -tron, -saur); name the real thing instead`,
      );
    }
  }
  return problems;
}

/**
 * Game-rule problems with a name, phrased as feedback for the corrective retry
 * (ported from the prompt-evaluation harness).
 */
export function ruleViolations(name: string, ingredientNames: string[], opts: { notable?: boolean } = {}): string[] {
  const problems: string[] = [];
  const n = squash(name);
  const ings = ingredientNames.map(squash);
  if (ings.includes(n)) problems.push("the name is one of the ingredients");
  if (ings.some((i) => n === `${i}s` || n === `${i}es` || i === `${n}s`)) problems.push("the name is just an ingredient pluralized");
  if (ings.some((i) => (SYNONYMS[i] ?? []).includes(n))) problems.push("the name is a synonym of an ingredient");
  if (STARTERS.has(n)) problems.push("the result may never be a starter element (Earth, Water, Air, Fire, Time)");
  problems.push(...namePatternViolations(name, opts));

  const ingWords = new Set(ingredientNames.flatMap((s) => s.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean)));
  const ingStems = new Set([...ingWords].map(stem));
  const nameWords = name.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
  const content = nameWords.filter((w) => !SMALL_WORDS.has(w));
  const distinct = [...new Set(ings)];
  const glued = distinct.length >= 2 && distinct.length <= 4 && permutations(distinct).some((p) => gluesTo(p, n));
  if (!established(n) && (glued || (content.length > 1 && content.every((w) => ingWords.has(w) || ingStems.has(stem(w)))))) {
    problems.push("the name just glues ingredient words together");
  }
  if (
    nameWords.length === 1 &&
    ingredientNames.some((s) => s.split(/\s+/).length >= 4 && s.toLowerCase().split(/[^a-z0-9]+/).includes(n))
  ) {
    problems.push("the name is a word copied out of an ingredient");
  }
  return problems;
}

/**
 * Validate a raw model answer against the game rules: name quality (checkName; notable
 * names may have 4 words), the ingredient-echo rules, and results that other recipes
 * already produce from a subset of these ingredients (`avoid`). Private reasoning fields
 * (link, famous_candidate, famous_fit) are dropped here.
 * `reason` is phrased as feedback for the model's corrective retry.
 */
export function validateProposal(raw: unknown, ingredientNames: string[], avoid: AvoidResult[] = []): ProposalCheck {
  const o = raw as Record<string, unknown> | null;
  if (typeof o !== "object" || o === null || typeof o.name !== "string") {
    return { ok: false, reason: "the answer was not a JSON object with a string `name`" };
  }
  const notable = o.notable === true;
  if (notable && o.famous_fit === "forbidden") {
    return { ok: false, reason: "a forbidden candidate can never be notable" };
  }
  const check = checkName(o.name, { notable });
  if (!check.ok) {
    return { ok: false, reason: `the name "${o.name.slice(0, 60)}" is not allowed (${check.reason})` };
  }
  const fold = foldKey(check.key);
  if (ingredientNames.some((n) => foldKey(nameKey(n)) === fold)) {
    return { ok: false, reason: `"${o.name}" is one of the ingredients; the result must be something new` };
  }
  const problems = ruleViolations(o.name, ingredientNames, { notable });
  const collision = avoid.find((a) => foldKey(a.key) === fold);
  if (collision) problems.push(`${collision.because}; the result must need every ingredient`);
  if (problems.length) return { ok: false, reason: problems.join("; ") };
  if (o.famous_fit === "forbidden") console.info("[llm] forbidden famous candidate", String(o.famous_candidate).slice(0, 60));
  return {
    ok: true,
    proposal: {
      name: displayName(o.name, check.key),
      key: check.key,
      foldKey: fold,
      emoji: sanitizeEmoji(o.emoji),
      description: sanitizeDescription(o.description),
      notable,
      artHint: sanitizeDescription(o.icon),
    },
  };
}
