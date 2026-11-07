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
const HYPE_PREFIX = /^(super|mega|ultra|hyper|giga|extra|giant|big|double)\b/i;
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

/**
 * Game-rule problems with a name, phrased as feedback for the corrective retry
 * (ported from the prompt-evaluation harness).
 */
export function ruleViolations(name: string, ingredientNames: string[]): string[] {
  const problems: string[] = [];
  const n = squash(name);
  const ings = ingredientNames.map(squash);
  if (ings.includes(n)) problems.push("the name is one of the ingredients");
  if (ings.some((i) => n === `${i}s` || n === `${i}es` || i === `${n}s`)) problems.push("the name is just an ingredient pluralized");
  if (ings.some((i) => (SYNONYMS[i] ?? []).includes(n))) problems.push("the name is a synonym of an ingredient");
  if (STARTERS.has(n)) problems.push("the result may never be a starter element (Earth, Water, Air, Fire, Time)");
  if (HYPE_PREFIX.test(name.trim())) problems.push("no hype or size prefixes");

  const ingWords = new Set(ingredientNames.flatMap((s) => s.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean)));
  const ingStems = new Set([...ingWords].map(stem));
  const nameWords = name.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
  const content = nameWords.filter((w) => !SMALL_WORDS.has(w));
  const distinct = [...new Set(ings)];
  const glued = distinct.length >= 2 && distinct.length <= 4 && permutations(distinct).some((p) => p.join("") === n);
  if (glued || (content.length > 1 && content.every((w) => ingWords.has(w) || ingStems.has(stem(w))))) {
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
  const problems = ruleViolations(o.name, ingredientNames);
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
