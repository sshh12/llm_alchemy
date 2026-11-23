// Name and graph features for daily-challenge targets (generator "pred-v6"; pure, no I/O):
// variety words and synonym groups, spelling-twin keys, the "aha" weight, abstract names, the
// seasonal map, synonym traps, near-name traps and direct ingredient links. See
// scripts/lib/challenges.ts.
import type { GraphRecipe } from "./graph.ts";
import type { DayType } from "./challengeModel.ts";

// ---------------------------------------------------------------- variety words

const WORD = /[a-z0-9]+/g;
const STOP = new Set(["the", "and", "for", "with"]);

/**
 * Near-synonym groups (§3 C11): two members within ±6 days count as a shared word, so a class
 * does not get Fog on Monday and Mist on Wednesday.
 */
export const SYNONYM_GROUPS: readonly (readonly string[])[] = [
  ["Fog", "Haze", "Mist", "Smog", "Vapor", "Steam"],
  ["Marsh", "Swamp", "Swampland", "Wetland", "Bog"],
  ["Soil", "Dirt", "Mud", "Clay", "Sand"],
  ["Rock", "Stone"],
  ["Sea", "Ocean"],
  ["Quake", "Earthquake"],
  ["Meteor", "Meteorite"],
];
const GROUP_OF = new Map<string, number>(SYNONYM_GROUPS.flatMap((g, i) => g.map((n) => [n.toLowerCase(), i] as const)));

/**
 * Variety words of a name: lowercase alphanumeric words of 3+ letters minus stop words, with a
 * trailing "s" dropped from words longer than 3 ("Volcanoes" ~ "volcanoe", "Rocks" ~ "rock"),
 * plus a `syn:<group>` token when the whole name is in a synonym group.
 */
export function nameWords(name: string): Set<string> {
  const out = new Set<string>();
  for (const t of name.toLowerCase().match(WORD) ?? []) {
    if (t.length < 3 || STOP.has(t)) continue;
    out.add(t.length > 3 && t.endsWith("s") ? t.slice(0, -1) : t);
  }
  const g = GROUP_OF.get(name.trim().toLowerCase());
  if (g !== undefined) out.add(`syn:${g}`);
  return out;
}

// ---------------------------------------------------------------- spelling twins (§3 C8)

/** Lowercase alphanumerics only. */
export const compactName = (name: string) => name.toLowerCase().replace(/[^a-z0-9]/g, "");

/** Singular fold: ies -> y; s/x/z/sh/ch + es -> stem; trailing s (not ss) dropped. */
export function singular(k: string): string {
  if (k.endsWith("ies") && k.length > 4) return `${k.slice(0, -3)}y`;
  if (k.endsWith("es") && k.length > 4 && ("sxz".includes(k[k.length - 3]!) || ["sh", "ch"].includes(k.slice(-4, -2)))) return k.slice(0, -2);
  if (k.endsWith("s") && k.length > 3 && !k.endsWith("ss")) return k.slice(0, -1);
  return k;
}

/** "Black Hole", "Blackhole" and "Black Holes" share one key. */
export const twinKey = (name: string) => singular(compactName(name));

/** Edit distance <= 1 (one substitution, insertion or deletion). */
export function editDistance1(a: string, b: string): boolean {
  if (a === b) return true;
  if (Math.abs(a.length - b.length) > 1) return false;
  if (a.length === b.length) {
    let diff = 0;
    for (let i = 0; i < a.length; i++) if (a[i] !== b[i] && ++diff > 1) return false;
    return diff === 1;
  }
  const [s, l] = a.length < b.length ? [a, b] : [b, a];
  for (let i = 0; i < l.length; i++) if (l.slice(0, i) + l.slice(i + 1) === s) return true;
  return false;
}

/** Twin keys this long or longer also match at edit distance 1 when the emoji is the same. */
export const TWIN_ED1_MIN = 6;

export interface TwinElement {
  id: string;
  name: string;
  emoji?: string | null;
}

const deletions = (k: string) => Array.from({ length: k.length }, (_, i) => k.slice(0, i) + k.slice(i + 1));

/** Index over ACTIVE elements: same twin key, or ED1 with the same emoji at >= TWIN_ED1_MIN characters. */
export class TwinIndex {
  private byKey = new Map<string, string[]>();
  private byDel = new Map<string, Set<string>>();
  private key = new Map<string, string>();
  private emoji = new Map<string, string | null>();

  constructor(elements: Iterable<TwinElement>) {
    for (const e of elements) {
      const k = twinKey(e.name);
      this.key.set(e.id, k);
      this.emoji.set(e.id, e.emoji ?? null);
      const list = this.byKey.get(k);
      if (list) list.push(e.id);
      else this.byKey.set(k, [e.id]);
      if (k.length >= TWIN_ED1_MIN - 1) {
        for (const d of [k, ...deletions(k)]) {
          const s = this.byDel.get(d);
          if (s) s.add(e.id);
          else this.byDel.set(d, new Set([e.id]));
        }
      }
    }
  }

  keyOf(id: string): string | undefined {
    return this.key.get(id);
  }

  /** Ids sharing exactly this twin key. */
  withKey(k: string): readonly string[] {
    return this.byKey.get(k) ?? [];
  }

  /** The twins of `id` (excluding itself). */
  twinsOf(id: string, name: string, emoji?: string | null): string[] {
    const k = this.key.get(id) ?? twinKey(name);
    const out = new Set((this.byKey.get(k) ?? []).filter((x) => x !== id));
    if (k.length >= TWIN_ED1_MIN) {
      const near = new Set<string>();
      for (const d of [k, ...deletions(k)]) for (const x of this.byDel.get(d) ?? []) near.add(x);
      const em = emoji ?? null;
      for (const x of near) {
        if (x === id || out.has(x)) continue;
        const kx = this.key.get(x)!;
        if (kx !== k && em !== null && this.emoji.get(x) === em && editDistance1(k, kx)) out.add(x);
      }
    }
    return [...out];
  }
}

/** C8: some twin of `id` is at least as widely made as `id` itself (players would make the twin instead). */
export function isTwinTrap(e: TwinElement, index: TwinIndex, reach: (id: string) => number): string | null {
  const own = reach(e.id);
  for (const x of index.twinsOf(e.id, e.name, e.emoji)) if (reach(x) >= own) return x;
  return null;
}

/**
 * The most widely made twin of `e`, for the per-tier twin rule in buildPools (C8b): a kid holding
 * "Ashes" gets nothing for an "Ash" target, because the server matches the target by exact id.
 * Ties by id.
 */
export function topTwin(e: TwinElement, index: TwinIndex, reach: (id: string) => number): { id: string; reach: number } | null {
  let best: { id: string; reach: number } | null = null;
  for (const x of index.twinsOf(e.id, e.name, e.emoji)) {
    const r = reach(x);
    if (!best || r > best.reach || (r === best.reach && x < best.id)) best = { id: x, reach: r };
  }
  return best;
}

// ---------------------------------------------------------------- near-name traps (C12)

/** Words of a name for phrase containment: lowercase alphanumeric words, each singular-folded. */
export const phraseWords = (name: string): string[] => (name.toLowerCase().match(WORD) ?? []).map(singular);

/**
 * For every proper contiguous sub-phrase of an active element's name ("Acid" and "Rain" in "Acid
 * Rain"), the most widely made element containing it. A generic target whose compound is made far
 * more often ("Acid" vs "Acid Rain", "Machine" vs "Time Machine") is rare because the recipe model
 * prefers the compound name, not because it is deep, so the challenge becomes an exact-word hunt;
 * reach alone cannot tell the two apart.
 */
export class NearNameIndex {
  private best = new Map<string, { id: string; reach: number }>();

  constructor(elements: Iterable<TwinElement>, reach: (id: string) => number) {
    for (const e of elements) {
      const w = phraseWords(e.name);
      if (w.length < 2) continue;
      const r = reach(e.id);
      const seen = new Set<string>();
      for (let i = 0; i < w.length; i++) {
        for (let j = i + 1; j <= w.length; j++) {
          if (j - i === w.length) continue; // the whole name is not a sub-phrase of itself
          const k = w.slice(i, j).join(" ");
          if (seen.has(k)) continue;
          seen.add(k);
          const cur = this.best.get(k);
          if (!cur || r > cur.reach || (r === cur.reach && e.id < cur.id)) this.best.set(k, { id: e.id, reach: r });
        }
      }
    }
  }

  /** The most widely made other element whose name contains `name` as a whole-word phrase. */
  containing(id: string, name: string): { id: string; reach: number } | null {
    const hit = this.best.get(phraseWords(name).join(" "));
    return hit && hit.id !== id ? hit : null;
  }
}

/** C12 (hard/expert): a containing name made by >= NEAR_NAME_RATIO x as many players, and by >= NEAR_NAME_MIN_REACH. */
export const NEAR_NAME_RATIO = 3;
export const NEAR_NAME_MIN_REACH = 0.01;

/** C12: the containing element that traps `id`, if any. */
export function nearNameTrap(id: string, name: string, index: NearNameIndex, reach: (id: string) => number): string | null {
  const hit = index.containing(id, name);
  if (!hit) return null;
  return hit.reach >= NEAR_NAME_MIN_REACH && hit.reach >= NEAR_NAME_RATIO * reach(id) ? hit.id : null;
}

/** C9 (hard/expert, needs classifier tags): a kid synonym (matched by twin key) has >= 2x the reach. */
export function synonymTrap(id: string, synonyms: readonly string[] | null | undefined, index: TwinIndex, reach: (id: string) => number): string | null {
  if (!synonyms?.length) return null;
  const own = reach(id);
  for (const s of synonyms) for (const x of index.withKey(twinKey(s))) if (x !== id && reach(x) >= 2 * own) return x;
  return null;
}

// ---------------------------------------------------------------- abstract names

const ABSTRACT_SUFFIX = /(ness|ity|ism|ment|hood|dom|ology|ance|ence|tion|sion)$/;
const ABSTRACT_OK = new Set(["station", "potion", "lotion", "television", "explosion", "mansion", "nation", "city", "ocean", "fence", "kingdom", "freedom"]);

/** Last word ends in an abstract-noun suffix, is 6+ letters and not on the allow list (lottery weight x0.6). */
export function isAbstract(name: string): boolean {
  const last = name.trim().split(/\s+/).at(-1)?.toLowerCase() ?? "";
  return last.length >= 6 && ABSTRACT_SUFFIX.test(last) && !ABSTRACT_OK.has(last);
}

// ---------------------------------------------------------------- aha (R2)

export interface AhaFeatures {
  /** Near-optimal active 2-ingredient recipes: 1 + sum(steps of distinct ingredients) <= steps + 1. */
  nearOpt: number;
  /** Some near-optimal recipe has an ingredient sharing a variety word with the target. */
  nameLink: boolean;
  /** Some near-optimal recipe has an ingredient with the target's emoji. */
  emojiLink: boolean;
  /** ln(1 + nearOpt) + 0.7·nameLink + 0.7·emojiLink. */
  aha: number;
}

export interface AhaElement {
  id: string;
  name: string;
  emoji?: string | null;
}

/**
 * aha per element over `pairs` (active 2-ingredient recipes whose result and ingredients are all
 * active), using `steps` (current steps per id). The only feature with leakage-free out-of-time
 * validation (hard lift 2.3-2.8x); used as a lottery weight, not a model term.
 */
export function computeAha(elements: readonly AhaElement[], pairs: readonly GraphRecipe[], steps: ReadonlyMap<string, number | null | undefined>): Map<string, AhaFeatures> {
  const byId = new Map(elements.map((e) => [e.id, e]));
  const words = new Map<string, Set<string>>();
  const wordsOf = (id: string) => {
    let w = words.get(id);
    if (!w) words.set(id, (w = nameWords(byId.get(id)?.name ?? "")));
    return w;
  };
  const near = new Map<string, number>();
  const nlink = new Set<string>();
  const elink = new Set<string>();
  for (const r of pairs) {
    const res = r.result;
    if (r.ingredients.includes(res)) continue;
    const sr = steps.get(res);
    if (sr == null) continue;
    const ings = [...new Set(r.ingredients)];
    let cost = 1;
    let ok = true;
    for (const i of ings) {
      const s = steps.get(i);
      if (s == null) {
        ok = false;
        break;
      }
      cost += s;
    }
    if (!ok || cost > sr + 1) continue;
    near.set(res, (near.get(res) ?? 0) + 1);
    const e = byId.get(res);
    if (!e) continue;
    const tw = wordsOf(res);
    for (const i of ings) {
      const ie = byId.get(i);
      if (!ie) continue;
      for (const w of wordsOf(i)) {
        if (!w.startsWith("syn:") && tw.has(w)) {
          nlink.add(res);
          break;
        }
      }
      if (ie.emoji && ie.emoji === e.emoji) elink.add(res);
    }
  }
  const out = new Map<string, AhaFeatures>();
  for (const e of elements) {
    const n = near.get(e.id) ?? 0;
    const nameLink = nlink.has(e.id);
    const emojiLink = elink.has(e.id);
    out.set(e.id, { nearOpt: n, nameLink, emojiLink, aha: Math.log(1 + n) + 0.7 * Number(nameLink) + 0.7 * Number(emojiLink) });
  }
  return out;
}

/** Direct links: `a` is an ingredient of some active 2-ingredient recipe for `b` (meta.links). */
export function directLinks(pairs: readonly GraphRecipe[]): (a: string, b: string) => boolean {
  const set = new Set<string>();
  for (const r of pairs) for (const i of r.ingredients) if (i !== r.result) set.add(`${i}>${r.result}`);
  return (a, b) => set.has(`${a}>${b}`);
}

// ---------------------------------------------------------------- seasons (§3.1)

export interface SeasonalRule {
  re: RegExp;
  /** Allowed months (1-12); "halloween" = Oct 24-31 on off days only. */
  allowed: readonly number[] | "halloween";
}

// Spec words with three guards: "sled*" would catch Sledgehammer, "frost*" Frosting (cake) and
// "surf*" Surface. There is no bare "fall" (Waterfall).
export const SEASONAL: readonly SeasonalRule[] = [
  { re: /\b(snow\w*|blizzard\w*|sleet|frost(?!ing)\w*|icicles?|ice storms?|igloos?|winter\w*|sled(?:s|ding)?|ski|skis|skiing|hot cocoa|hot chocolate|mitten\w*)\b/i, allowed: [11, 12, 1, 2, 3] },
  {
    re: /\b(heat ?waves?|sandcastles?|lifeguards?|sunburns?|beach balls?|sunscreens?|summer\w*|popsicles?|surf(?:s|er|ers|ing|board|boards)?|water ?slides?)\b/i,
    allowed: [5, 6, 7, 8, 9],
  },
  { re: /\b(harvest festivals?|cornucopias?|thanksgiving|autumn\w*)\b/i, allowed: [9, 10, 11] },
  { re: /\b(cherry blossoms?)\b/i, allowed: [3, 4, 5] },
  { re: /\b(christmas\w*|santa|reindeer|mistletoe|gingerbread\w*)\b/i, allowed: [12] },
  { re: /\b(valentine\w*)\b/i, allowed: [2] },
  { re: /\b(halloween|jack-?o-?lanterns?|trick or treat)\b/i, allowed: "halloween" },
];

export const seasonalRule = (name: string): SeasonalRule | null => SEASONAL.find((r) => r.re.test(name)) ?? null;

/** C10: a seasonal name only in its months (Halloween: Oct 24-31 off days). Non-seasonal names always. */
export function inSeason(name: string, day: string, type: DayType): boolean {
  const rule = seasonalRule(name);
  if (!rule) return true;
  const month = Number(day.slice(5, 7));
  if (rule.allowed === "halloween") return month === 10 && Number(day.slice(8, 10)) >= 24 && type === "off";
  return rule.allowed.includes(month);
}
