// Deterministic toy scorer for custom library sorts, shared by the server's AI_MODE=mock
// backend (server/ai/mock.ts: local dev, e2e) and the browser dev fake (src/app/dev/fakeApi.ts),
// so both agree on every score. Pure: no network, no node imports.
//
// A spec word (crudely stemmed: "spookiest" → "spooky", "hottest" → "hot", "animals" → "animal")
// expands through a tiny lexicon, and an element matches when one of its name words is in that
// set: e.g. "weather" ranks Storm, Rain, Cloud and Lightning high. Everything else gets a stable
// hash-derived score below the match range.
import type { SortScore, SortSpec } from "./api.ts";
import { fnv1a } from "./hash.ts";
import { specKey } from "./sortSpec.ts";

const LEXICON: Record<string, string[]> = {
  weather: ["storm", "rain", "cloud", "lightning", "snow", "wind", "mist", "fog", "hail", "thunder", "weather", "rainbow"],
  space: ["rocket", "mars", "galaxy", "planet", "moon", "space", "station", "colony", "star", "comet", "nebula"],
  hot: ["fire", "lava", "plasma", "steam", "geyser", "inferno", "sun", "volcano"],
  spooky: ["ghost", "zombie", "vampire", "grave", "skeleton", "shadow"],
  kitchen: ["apple", "bread", "pottery", "salt", "egg", "flour", "sugar"],
  food: ["apple", "bread", "egg", "flour", "sugar", "honey"],
  animal: ["owl", "wolf", "serpent", "dragon", "dog", "cat", "fish", "bird"],
  metal: ["metal", "sword", "robot", "iron", "copper"],
};

const words = (text: string): string[] => (text.toLowerCase().match(/\p{L}+/gu) ?? []).filter((w) => w.length >= 3);

export function stem(w: string): string {
  if (w.endsWith("iest")) return `${w.slice(0, -4)}y`;
  if (w.endsWith("est") && w.length > 5) {
    const base = w.slice(0, -3);
    const last = base.at(-1) ?? "";
    return base.length > 2 && last === base.at(-2) && !/[aeiou]/.test(last) ? base.slice(0, -1) : base;
  }
  if (w.endsWith("s") && w.length > 3) return w.slice(0, -1);
  return w;
}

/** Stems an element name word must hit. Lexicon words are stemmed too, so "Mars" (→ "mar") matches. */
function hits(text: string): Set<string> {
  const out = new Set<string>();
  for (const w of words(text)) {
    const s = stem(w);
    out.add(s);
    for (const x of LEXICON[s] ?? []) out.add(stem(x));
  }
  return out;
}

const matches = (name: string, set: ReadonlySet<string>) => words(name).some((w) => set.has(stem(w)));

/** One score per item, in input order; each depends only on the spec and that item. */
export function mockSortScores(spec: SortSpec, items: readonly { id: string; name: string }[]): SortScore[] {
  const key = specKey(spec);
  if (spec.kind === "rank") {
    const set = hits(spec.prompt);
    return items.map(({ id, name }) => {
      const h = fnv1a(`${key}|${id}`);
      return { s: matches(name, set) ? 850 + (h % 151) : h % 500 };
    });
  }
  const sets = spec.groups.map(hits);
  const k = spec.groups.length;
  return items.map(({ id, name }) => {
    const h = fnv1a(`${key}|${id}`);
    const j = sets.findIndex((set) => matches(name, set));
    return j >= 0 ? { s: 900 + (h % 101), g: j, n: 900 } : { s: 200 + (h % 300), g: h % k, n: h % 400 };
  });
}
