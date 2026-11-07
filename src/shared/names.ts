// Element-name normalization and quality rules, shared by the legacy backfill
// (deciding which legacy elements are active) and the live combine path
// (validating LLM output). Keep these pure and dependency-free.

export const MAX_NAME_CHARS = 32;
export const MAX_WORDS = 3;
export const MAX_WORDS_NOTABLE = 4;
export const MAX_TOKEN_CHARS = 20;

/** Words that legitimately repeat a 4+ letter unit. */
const REPETITION_ALLOWLIST = new Set([
  "couscous",
  "mahi mahi",
  "mahimahi",
  "bora bora",
  "baden baden",
  "tom tom",
  "can can",
  "cha cha",
  "chop chop",
  "walla walla",
  "pago pago",
]);

/**
 * Strip diacritics, unify quotes/dashes, drop characters outside [A-Za-z0-9 '-],
 * trim, and collapse whitespace. Preserves case.
 */
export function cleanName(raw: string): string {
  return raw
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[‘’ʼ`´]/g, "'")
    .replace(/[‐-―−]/g, "-")
    .replace(/[_/]+/g, " ")
    .replace(/[^A-Za-z0-9 '-]+/g, "")
    .replace(/\s+/g, " ")
    .replace(/\s*-\s*/g, "-")
    .replace(/-{2,}/g, "-")
    .replace(/'{2,}/g, "'")
    .trim()
    .replace(/^[-' ]+|[- ]+$/g, "");
}

/** Unique identity of an element: lowercase cleaned name. */
export function nameKey(raw: string): string {
  return cleanName(raw).toLowerCase();
}

/** Looser key used to reuse near-identical names ("time-travel" == "time travel"). */
export function foldKey(key: string): string {
  return key.toLowerCase().replace(/-/g, " ").replace(/'/g, "").replace(/\s+/g, " ").trim();
}

const SMALL_WORDS = new Set(["a", "an", "and", "as", "at", "by", "de", "da", "del", "for", "in", "of", "on", "or", "the", "to", "van", "von", "with"]);

/** Title-case a lowercase key for display ("time-traveling submarine" -> "Time-Traveling Submarine"). */
export function titleCase(key: string): string {
  const words = key.split(" ");
  return words
    .map((w, i) => {
      if (i > 0 && SMALL_WORDS.has(w)) return w;
      return w
        .split("-")
        .map((part) => (part.length ? part[0]!.toUpperCase() + part.slice(1) : part))
        .join("-");
    })
    .join(" ");
}

export type NameCheck = { ok: true; key: string } | { ok: false; reason: string };

/**
 * Quality gate for element names. `raw` is the original string (legacy row or LLM output).
 * Rejects concatenation spam, list answers, repetition, and overly long names.
 */
export function checkName(raw: string, opts: { notable?: boolean } = {}): NameCheck {
  if (/\s{2,}/.test(raw.trim())) return { ok: false, reason: "list-like (double space)" };
  const key = nameKey(raw);
  if (key.length === 0) return { ok: false, reason: "empty" };
  if (key.length > MAX_NAME_CHARS) return { ok: false, reason: "too long" };
  if (!/^[a-z0-9]([a-z0-9' -]*[a-z0-9'])?$/.test(key)) return { ok: false, reason: "charset" };
  if (/(--|- | -|' |'')/.test(key)) return { ok: false, reason: "punctuation" };
  if (!/[a-z]/.test(key)) return { ok: false, reason: "no letters" };
  const words = key.split(" ");
  const maxWords = opts.notable ? MAX_WORDS_NOTABLE : MAX_WORDS;
  if (words.length > maxWords) return { ok: false, reason: "too many words" };
  const tokens = key.split(/[ -]/);
  if (tokens.some((t) => t.length > MAX_TOKEN_CHARS)) return { ok: false, reason: "token too long" };
  if (!REPETITION_ALLOWLIST.has(key) && (/(.{2,})\1\1/.test(key) || /([a-z]{4,})\1/.test(key))) {
    return { ok: false, reason: "repetition" };
  }
  if (new Set(words).size < words.length && words.length > 1 && !REPETITION_ALLOWLIST.has(key)) {
    return { ok: false, reason: "repeated word" };
  }
  return { ok: true, key };
}
