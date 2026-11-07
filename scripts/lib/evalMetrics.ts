// Pure metrics for the custom-sort eval (scripts/eval-sort.ts), ported from the local eval that
// chose rubric r2 (harness.mjs for rank, gp-eval.mjs for groups). No IO and no network:
// scripts/eval-sort.test.ts runs every function here on hand-computed fixtures.
//
// Orders and buckets are the client's own. clientOrder() runs orderLibrary from
// src/app/lib/librarySort.ts over a synthetic library: rank is s descending, then name; groups go
// by slot, then s, then fit, then name. The groups bucket comes from librarySort's groupOf
// (fit < SORT_FIT_THRESHOLD goes to Other), and popover words come from its levelLabel.
//
// rank (labels: high = clear members, low = clear non-members, tiers = chains ordered low → high)
//   auc          P(s_high > s_low) over every labeled pair, ties count 0.5.
//   p10          |top k ∩ high| / k in the client order, k = min(10, |high|). Unlabeled elements in
//                the top k count as misses, so this understates quality when many unlabeled ones fit.
//   low10        clear lows inside the top 10 (want 0).
//   tier         pairwise order accuracy inside each low → high chain (ties 0.5).
//   matchP/R/F1  the Matches chip (s ≥ SORT_MATCH_THRESHOLD): precision over labeled ids, recall of high.
//   matches      every element in Matches. weak = 1 when Matches is empty ("Nothing clearly matches").
//   junkMatches  legacy junk names (cat "junk") in Matches.
//   partial      tiles in Matches whose popover level word (levelLabel) reads below "Clear match".
//   rho, revAuc  negation only: Spearman against the positive twin (want ≈ −1), and the AUC the
//                client would get by just reversing the twin (1000 − s).
//   compAuc      compound only: AUC of the geometric mean of the component cases' scores.
// groups (expected = strict label, accept = soft labels where any listed bucket is right)
//   errors       labels whose final bucket is wrong. An unscored labeled element counts as wrong.
//   accAll       (labels − errors) / labels. accStrict / accSoft: per kind of label.
//   choiceAcc    strict labels with a real group: was that group chosen (ignores the fit)?
//   otherP/R/F1  Other as the positive class over strict labels (Other-on cases only).
//   fitAuc       P(fit of a real member > fit of a gold Other) (Other-on cases).
//   sinkS        same closest group: P(s of a real member > s of a gold Other). Weak fits sink.
//   firstPick    share of elements whose group was the first-listed option (rotation fnv1a(id) % k).
// both
//   tokPerEl     reported input tokens / elements asked (per repeat).
import { SORT_MATCH_THRESHOLD, type ElementDTO, type ElementId, type SortScore, type SortSpec } from "../../src/shared/api.ts";
import { fnv1a } from "../../src/shared/hash.ts";
import { normalizeSpec } from "../../src/shared/sortSpec.ts";
import { groupOf, levelLabel, orderLibrary, type Committed, type LibraryOrderInput } from "../../src/app/lib/librarySort.ts";

// ---------------------------------------------------------------- data

export type Split = "tune" | "holdout";
export const SPLITS: readonly Split[] = ["tune", "holdout"];

export interface EvalElement {
  id: ElementId;
  name: string;
  /** "junk" = a legacy junk name (Sparkleglop, Firefirefire); the rest are informational. */
  cat: string;
}

export interface RankCase {
  id: string;
  split: Split;
  category: string;
  prompt: string;
  high: string[];
  low: string[];
  tiers?: string[][];
  /** Negation: the positive twin case (rho, revAuc). */
  pair_with?: string;
  /** Compound: the component cases (compAuc). */
  components?: string[];
  /** Labeled after seeing results: reported, never gated or averaged. */
  informational?: boolean;
}

export interface GroupsCase {
  id: string;
  split: Split;
  category: string;
  other: boolean;
  groups: string[];
  expected: Record<string, string>;
  accept: Record<string, string[]>;
}

export interface EvalCases {
  version: number;
  model: string;
  elements: EvalElement[];
  rank: RankCase[];
  groups: GroupsCase[];
}

export type EvalCase = RankCase | GroupsCase;
export const isRankCase = (c: EvalCase): c is RankCase => "prompt" in c;
export const specOf = (c: EvalCase): SortSpec => (isRankCase(c) ? { kind: "rank", prompt: c.prompt } : { kind: "groups", groups: c.groups });

export type Family = "plain" | "negation" | "compound" | "union" | "probe";
export const FAMILIES: readonly Family[] = ["plain", "negation", "compound", "union", "probe"];

/** plain = quality/scale/membership/niche prompts; probe = informational. */
export function familyOf(c: RankCase): Family {
  if (c.informational) return "probe";
  if (c.category.startsWith("negation")) return "negation";
  if (c.category === "compound-union") return "union";
  if (c.category.startsWith("compound")) return "compound";
  return "plain";
}

/** Every problem with the label file (empty = fine). eval-sort.ts refuses to run on any. */
export function validateCases(d: EvalCases): string[] {
  const problems: string[] = [];
  const add = (p: string) => problems.push(p);
  if (d.version !== 1) add(`version ${String(d.version)} (expected 1)`);
  if (!Array.isArray(d.elements) || !Array.isArray(d.rank) || !Array.isArray(d.groups)) return [...problems, "elements, rank and groups must be arrays"];
  const names = new Set<string>();
  const ids = new Set<string>();
  for (const e of d.elements) {
    if (typeof e.id !== "string" || !/^[1-9]\d{0,18}$/.test(e.id)) add(`element ${JSON.stringify(e.name)}: id ${JSON.stringify(e.id)} is not an INT8 string`);
    if (typeof e.name !== "string" || !e.name.trim()) add(`element ${e.id}: empty name`);
    if (ids.has(e.id)) add(`duplicate element id ${e.id}`);
    if (names.has(e.name)) add(`duplicate element name ${JSON.stringify(e.name)}`);
    ids.add(e.id);
    names.add(e.name);
  }
  const known = (where: string, n: string) => {
    if (!names.has(n)) add(`${where}: unknown element ${JSON.stringify(n)}`);
  };
  const caseIds = new Set<string>();
  const rankIds = new Set(d.rank.map((c) => c.id));
  for (const c of [...d.rank, ...d.groups]) {
    if (caseIds.has(c.id)) add(`duplicate case id ${c.id}`);
    caseIds.add(c.id);
    if (c.split !== "tune" && c.split !== "holdout") add(`${c.id}: split ${JSON.stringify(c.split)}`);
    // The eval must ask exactly what production would after normalizing the player's text.
    const spec = specOf(c);
    const norm = normalizeSpec(spec);
    if (!norm.ok) add(`${c.id}: spec rejected by normalizeSpec (${norm.problem})`);
    else if (JSON.stringify(norm.spec) !== JSON.stringify(spec)) add(`${c.id}: spec is not normalized (${JSON.stringify(norm.spec)})`);
  }
  for (const c of d.rank) {
    const w = `rank ${c.id}`;
    if (!c.high.length || !c.low.length) add(`${w}: needs at least one high and one low label`);
    const seen = new Set<string>();
    for (const n of [...c.high, ...c.low]) {
      known(w, n);
      if (seen.has(n)) add(`${w}: ${JSON.stringify(n)} is labeled twice${c.high.includes(n) && c.low.includes(n) ? " (both high and low)" : ""}`);
      seen.add(n);
    }
    for (const chain of c.tiers ?? []) {
      if (chain.length < 2) add(`${w}: a tier chain needs at least 2 elements`);
      if (new Set(chain).size !== chain.length) add(`${w}: a tier chain repeats an element`);
      for (const n of chain) known(w, n);
    }
    for (const dep of [c.pair_with, ...(c.components ?? [])]) {
      if (dep !== undefined && !rankIds.has(dep)) add(`${w}: unknown rank dependency ${dep}`);
      if (dep === c.id) add(`${w}: depends on itself`);
    }
  }
  for (const c of d.groups) {
    const w = `groups ${c.id}`;
    const bucketOk = (g: string) => (g === "Other" ? c.other : c.groups.includes(g));
    for (const [n, g] of Object.entries(c.expected)) {
      known(w, n);
      if (!bucketOk(g)) add(`${w}: ${JSON.stringify(n)} → ${JSON.stringify(g)} is not a group${c.other ? " or Other" : " (Other is off)"}`);
      if (Object.hasOwn(c.accept, n)) add(`${w}: ${JSON.stringify(n)} has both a strict and a soft label`);
    }
    for (const [n, gs] of Object.entries(c.accept)) {
      known(w, n);
      if (!Array.isArray(gs) || gs.length === 0) add(`${w}: ${JSON.stringify(n)} has an empty soft label`);
      else {
        for (const g of gs) if (!bucketOk(g)) add(`${w}: ${JSON.stringify(n)} accepts ${JSON.stringify(g)}, not a group${c.other ? " or Other" : " (Other is off)"}`);
        if (new Set(gs).size !== gs.length) add(`${w}: ${JSON.stringify(n)} repeats a soft label`);
      }
    }
  }
  return problems;
}

/** Name and id lookups for one label file. */
export interface Library {
  items: { id: ElementId; name: string }[];
  byName: ReadonlyMap<string, EvalElement>;
  names: ReadonlyMap<ElementId, string>;
  junk: ReadonlySet<ElementId>;
}

export function libraryOf(elements: readonly EvalElement[]): Library {
  return {
    items: elements.map((e) => ({ id: e.id, name: e.name })),
    byName: new Map(elements.map((e) => [e.name, e])),
    names: new Map(elements.map((e) => [e.id, e.name])),
    junk: new Set(elements.filter((e) => e.cat === "junk").map((e) => e.id)),
  };
}

const idOf = (lib: Library, name: string): ElementId => {
  const e = lib.byName.get(name);
  if (!e) throw new Error(`unknown element ${JSON.stringify(name)}`);
  return e.id;
};

// ---------------------------------------------------------------- statistics

export type Metrics = Record<string, number | null>;

const finite = (xs: readonly (number | null | undefined)[]): number[] => xs.filter((x): x is number => typeof x === "number" && Number.isFinite(x));

/** Mean of the finite values; null when there are none. */
export function mean(xs: readonly (number | null | undefined)[]): number | null {
  const v = finite(xs);
  return v.length ? v.reduce((a, b) => a + b, 0) / v.length : null;
}

export function sum(xs: readonly (number | null | undefined)[]): number {
  return finite(xs).reduce((a, b) => a + b, 0);
}

export function minOf(xs: readonly (number | null | undefined)[]): number | null {
  const v = finite(xs);
  return v.length ? Math.min(...v) : null;
}

/** Nearest-rank quantile (q in 0..1); null for no values. */
export function quantile(xs: readonly number[], q: number): number | null {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.max(0, Math.ceil(q * s.length) - 1))]!;
}

const f1 = (p: number | null, r: number | null): number => (p && r ? (2 * p * r) / (p + r) : 0);

/** P(score[pos] > score[neg]) over every pair with both scored; ties 0.5; null without pairs. */
export function auc(score: ReadonlyMap<ElementId, number>, pos: readonly ElementId[], neg: readonly ElementId[]): number | null {
  let w = 0;
  let n = 0;
  for (const p of pos) {
    const a = score.get(p);
    if (a === undefined) continue;
    for (const q of neg) {
      const b = score.get(q);
      if (b === undefined) continue;
      n++;
      w += a > b ? 1 : a === b ? 0.5 : 0;
    }
  }
  return n ? w / n : null;
}

/** P(a > b) over all pairs of two plain lists; ties 0.5. */
export function pairAuc(pos: readonly number[], neg: readonly number[]): number | null {
  let w = 0;
  let n = 0;
  for (const a of pos) {
    for (const b of neg) {
      n++;
      w += a > b ? 1 : a === b ? 0.5 : 0;
    }
  }
  return n ? w / n : null;
}

/** 0-based average ranks (ties share the mean rank). */
export function avgRanks(xs: readonly number[]): number[] {
  const idx = xs.map((x, i) => [x, i] as const).sort((a, b) => a[0] - b[0]);
  const r = new Array<number>(xs.length);
  for (let i = 0; i < idx.length; ) {
    let j = i;
    while (j + 1 < idx.length && idx[j + 1]![0] === idx[i]![0]) j++;
    for (let k = i; k <= j; k++) r[idx[k]![1]] = (i + j) / 2;
    i = j + 1;
  }
  return r;
}

/** Spearman's rho with average ranks; null under 3 points or with a constant side. */
export function spearman(xs: readonly number[], ys: readonly number[]): number | null {
  if (xs.length < 3 || xs.length !== ys.length) return null;
  const a = avgRanks(xs);
  const b = avgRanks(ys);
  const ma = mean(a)!;
  const mb = mean(b)!;
  let num = 0;
  let da = 0;
  let db = 0;
  for (let i = 0; i < a.length; i++) {
    num += (a[i]! - ma) * (b[i]! - mb);
    da += (a[i]! - ma) ** 2;
    db += (b[i]! - mb) ** 2;
  }
  return da && db ? num / Math.sqrt(da * db) : null;
}

/** Pairwise order accuracy inside each chain (ordered low → high); ties 0.5; null without pairs. */
export function tierAcc(score: ReadonlyMap<ElementId, number>, tiers: readonly (readonly ElementId[])[]): number | null {
  let w = 0;
  let n = 0;
  for (const chain of tiers) {
    for (let i = 0; i < chain.length; i++) {
      for (let j = i + 1; j < chain.length; j++) {
        const lo = score.get(chain[i]!);
        const hi = score.get(chain[j]!);
        if (lo === undefined || hi === undefined) continue;
        n++;
        w += hi > lo ? 1 : hi === lo ? 0.5 : 0;
      }
    }
  }
  return n ? w / n : null;
}

/** |order[0..k) ∩ high| / k with k = min(10, |high|); null without high labels. */
export function precisionAtK(order: readonly ElementId[], high: readonly ElementId[], k = 10): number | null {
  if (!high.length) return null;
  const n = Math.min(k, high.length);
  const hs = new Set(high);
  return order.slice(0, n).filter((id) => hs.has(id)).length / n;
}

/** The Matches chip: precision and recall over the labels, plus how many elements it holds. */
export function matchBucket(
  score: ReadonlyMap<ElementId, number>,
  high: readonly ElementId[],
  low: readonly ElementId[],
  thr = SORT_MATCH_THRESHOLD,
): { P: number | null; R: number | null; F1: number; matches: number } {
  const inM = (id: ElementId) => (score.get(id) ?? -1) >= thr;
  const tp = high.filter(inM).length;
  const fp = low.filter(inM).length;
  const P = tp + fp ? tp / (tp + fp) : null;
  const R = high.length ? tp / high.length : null;
  let matches = 0;
  for (const s of score.values()) if (s >= thr) matches++;
  return { P, R, F1: f1(P, R), matches };
}

// ---------------------------------------------------------------- the client's order and buckets

const OWNED = { discoveredAt: "2026-01-01T00:00:00.000Z", first: false };

/** What the grid commits for these scores (librarySort's Committed). */
export function committedOf(spec: SortSpec, scores: ReadonlyMap<ElementId, SortScore>): Committed {
  const groups = spec.kind === "groups";
  const pick = (f: (sc: SortScore) => number | undefined) =>
    new Map([...scores].flatMap(([id, sc]): [ElementId, number][] => {
      const v = f(sc);
      return v === undefined ? [] : [[id, v]];
    }));
  return {
    key: "eval",
    kind: spec.kind,
    spec,
    scores: pick((sc) => sc.s),
    groups: groups ? pick((sc) => sc.g) : null,
    fit: groups ? pick((sc) => sc.n) : null,
  };
}

/**
 * The scored ids in the grid's order (orderLibrary with sort "custom", nothing pending, no pins,
 * filter or search, not reversed). Rank: s descending, then name. Groups: by group slot (Other
 * after the real groups when `other`), then s, then fit, then name.
 */
export function clientOrder(
  spec: SortSpec,
  scores: ReadonlyMap<ElementId, SortScore>,
  names: ReadonlyMap<ElementId, string>,
  other = true,
): ElementId[] {
  const owned: LibraryOrderInput["owned"] = {};
  const elements: LibraryOrderInput["elements"] = {};
  for (const id of scores.keys()) {
    const name = names.get(id);
    if (name === undefined) throw new Error(`no name for scored id ${id}`);
    owned[id] = OWNED;
    elements[id] = { id, name, emoji: null, img: null, art: "missing", description: null, notable: false, depth: null, rarity: "common", starter: false } satisfies ElementDTO;
  }
  const custom = { committed: committedOf(spec, scores), pending: new Set<ElementId>(), reverse: false, other, bucket: null, prevSort: "az" as const };
  return orderLibrary({ owned, elements, pins: new Set(), filter: "all", sort: "custom", query: "", now: 0, custom }).ids;
}

const RANK_SPEC: SortSpec = { kind: "rank", prompt: "eval" };
/** clientOrder for a plain rank score map. */
export const rankOrder = (score: ReadonlyMap<ElementId, number>, names: ReadonlyMap<ElementId, string>): ElementId[] =>
  clientOrder(RANK_SPEC, new Map([...score].map(([id, s]) => [id, { s }])), names);

const MATCH_WORDS = new Set(["Clear match", "Perfect match"]);

/** Index of the option listed first for `id` (questionsFor rotates the k groups by fnv1a(id) % k). */
export const firstListed = (id: ElementId, k: number): number => fnv1a(id) % k;

// ---------------------------------------------------------------- per case

export interface CaseDetail {
  top: string[];
  bottom?: string[];
  /** Clear lows in Matches or the top 20; clear highs outside Matches. */
  lowsHigh?: string[];
  highsLow?: string[];
  unlabeledTop?: string[];
  /** groups: elements per final bucket, and every wrong label. */
  counts?: Record<string, number>;
  wrong?: string[];
}

/**
 * One rank case. `deps` holds the scores of the case's pair_with / components cases (same
 * repeat); a missing dependency leaves rho / compAuc out.
 */
export function rankCaseMetrics(
  c: RankCase,
  score: ReadonlyMap<ElementId, number>,
  lib: Library,
  deps: ReadonlyMap<string, ReadonlyMap<ElementId, number>> = new Map(),
  thr = SORT_MATCH_THRESHOLD,
): { m: Metrics; detail: CaseDetail } {
  const ids = (ns: readonly string[]) => ns.map((n) => idOf(lib, n));
  const high = ids(c.high);
  const low = ids(c.low);
  const tiers = (c.tiers ?? []).map(ids);
  const order = rankOrder(score, lib.names);
  const lowSet = new Set(low);
  const mb = matchBucket(score, high, low, thr);
  const junk = [...score].filter(([id]) => lib.junk.has(id)).map(([, s]) => s);
  const m: Metrics = {
    scored: score.size,
    auc: auc(score, high, low),
    p10: precisionAtK(order, high),
    low10: order.slice(0, 10).filter((id) => lowSet.has(id)).length,
    tier: tierAcc(score, tiers),
    matchP: mb.P,
    matchR: mb.R,
    matchF1: mb.F1,
    matches: mb.matches,
    weak: mb.matches === 0 ? 1 : 0,
    distinct: new Set(score.values()).size,
    junkMax: junk.length ? Math.max(...junk) : null,
    junkMatches: junk.filter((s) => s >= thr).length,
    partial: [...score.values()].filter((s) => s >= thr && !MATCH_WORDS.has(levelLabel(s))).length,
  };
  const pair = c.pair_with !== undefined ? deps.get(c.pair_with) : undefined;
  if (pair) {
    const both = [...score.keys()].filter((id) => pair.has(id));
    m.rho = spearman(both.map((id) => score.get(id)!), both.map((id) => pair.get(id)!));
    const rev = new Map(both.map((id) => [id, 1000 - pair.get(id)!]));
    m.revAuc = auc(rev, high, low);
    m.revP10 = precisionAtK(rankOrder(rev, lib.names), high);
    m.revTier = tierAcc(rev, tiers);
  }
  const parts = (c.components ?? []).map((d) => deps.get(d));
  if (parts.length && parts.every((p) => p !== undefined)) {
    const ps = parts as ReadonlyMap<ElementId, number>[];
    const both = [...score.keys()].filter((id) => ps.every((p) => p.has(id)));
    // Geometric mean: an element must do well on every part (the "and" in "spooky and small").
    const comp = new Map(both.map((id) => [id, Math.round(Math.exp(mean(ps.map((p) => Math.log(Math.max(1, p.get(id)!))))!))]));
    m.compAuc = auc(comp, high, low);
    m.compP10 = precisionAtK(rankOrder(comp, lib.names), high);
    m.compTier = tierAcc(comp, tiers);
  }
  const fmt = (id: ElementId) => `${lib.names.get(id)} ${score.get(id)}`;
  const highSet = new Set(high);
  const pos = new Map(order.map((id, i) => [id, i]));
  return {
    m,
    detail: {
      top: order.slice(0, 10).map(fmt),
      bottom: order.slice(-5).map(fmt),
      lowsHigh: low.filter((id) => score.has(id) && (score.get(id)! >= thr || pos.get(id)! < 20)).map(fmt),
      highsLow: high.filter((id) => score.has(id) && score.get(id)! < thr).map(fmt),
      unlabeledTop: order.slice(0, 10).filter((id) => !highSet.has(id) && !lowSet.has(id)).map(fmt),
    },
  };
}

/** One groups case over the parsed scores (parseChunk's {s, g, n}). */
export function groupsCaseMetrics(c: GroupsCase, res: ReadonlyMap<ElementId, SortScore>, lib: Library): { m: Metrics; detail: CaseDetail } {
  const spec = specOf(c);
  const k = c.groups.length;
  const gi = (g: string) => (g === "Other" ? -1 : c.groups.indexOf(g));
  const committed = committedOf(spec, res);
  /** The final bucket: a group index, -1 = Other, -2 = unscored or unusable (never right). */
  const bucket = (id: ElementId) => (res.has(id) ? (groupOf(committed, id, c.other) ?? -2) : -2);
  const strictAll = Object.entries(c.expected).map(([n, g]) => [idOf(lib, n), gi(g)] as const);
  const softAll = Object.entries(c.accept).map(([n, gs]) => [idOf(lib, n), new Set(gs.map(gi))] as const);
  const strict = strictAll.filter(([id]) => res.has(id));
  const soft = softAll.filter(([id]) => res.has(id));
  const hit = ([id, g]: readonly [ElementId, number]) => (bucket(id) === g ? 1 : 0);
  const softHit = ([id, set]: readonly [ElementId, ReadonlySet<number>]) => (set.has(bucket(id)) ? 1 : 0);
  const labels = strictAll.length + softAll.length;
  const correct = sum(strict.map(hit)) + sum(soft.map(softHit));
  const m: Metrics = {
    scored: res.size,
    labels,
    labeled: strict.length + soft.length,
    correct,
    errors: labels - correct,
    accAll: labels ? correct / labels : null,
    accStrict: mean(strict.map(hit)),
    accSoft: mean(soft.map(softHit)),
  };
  const real = strict.filter(([, g]) => g >= 0);
  m.choiceAcc = mean(real.map(([id, g]) => (res.get(id)!.g === g ? 1 : 0)));
  const softReal = soft.filter(([, set]) => [...set].some((g) => g >= 0));
  m.choiceSoft = mean(softReal.map(([id, set]) => (set.has(res.get(id)!.g ?? -2) ? 1 : 0)));
  m.otherRate = c.other ? mean([...res.keys()].map((id) => (bucket(id) === -1 ? 1 : 0))) : null;
  if (c.other) {
    const pos = strict.filter(([, g]) => g === -1);
    const neg = strict.filter(([, g]) => g >= 0);
    const tp = pos.filter(([id]) => bucket(id) === -1).length;
    const fp = neg.filter(([id]) => bucket(id) === -1).length;
    m.otherP = tp + fp ? tp / (tp + fp) : null;
    m.otherR = pos.length ? tp / pos.length : null;
    m.otherF1 = f1(m.otherP, m.otherR);
    const fit = (id: ElementId) => res.get(id)!.n ?? 0;
    m.fitAuc = pairAuc(neg.map(([id]) => fit(id)), pos.map(([id]) => fit(id)));
    // With Other switched off, gold Others land in some group: do they sort below its real members?
    const sinkBy = (key: (r: SortScore) => number) => {
      let w = 0;
      let n = 0;
      for (const [mid, g] of neg) {
        const rm = res.get(mid)!;
        if (rm.g !== g) continue;
        for (const [oid] of pos) {
          const ro = res.get(oid)!;
          if (ro.g !== g) continue;
          n++;
          const a = key(rm);
          const b = key(ro);
          w += a > b ? 1 : a === b ? 0.5 : 0;
        }
      }
      return n ? w / n : null;
    };
    m.sinkS = sinkBy((r) => r.s);
    m.sinkSN = sinkBy((r) => (r.s * (r.n ?? 1000)) / 1000);
  }
  m.firstPick = mean([...res].map(([id, r]) => (r.g === firstListed(id, k) ? 1 : 0)));
  const label = (g: number) => (g === -1 ? "Other" : g === -2 ? "(unscored)" : c.groups[g]!);
  const counts: Record<string, number> = {};
  for (const id of res.keys()) counts[label(bucket(id))] = (counts[label(bucket(id))] ?? 0) + 1;
  const show = (id: ElementId) => {
    const r = res.get(id);
    return r
      ? `${lib.names.get(id)} → ${label(bucket(id))} (${label(r.g ?? -2)} s=${r.s}${r.n !== undefined ? ` n=${r.n}` : ""})`
      : `${lib.names.get(id)} → (unscored)`;
  };
  const wrong = [
    ...strictAll.filter((x) => !hit(x)).map(([id, g]) => `${show(id)} want ${label(g)}`),
    ...softAll.filter((x) => !softHit(x)).map(([id, set]) => `${show(id)} want ${[...set].map(label).join("|")}`),
  ];
  const order = clientOrder(spec, res, lib.names, c.other);
  return { m, detail: { counts, top: order.slice(0, 10).map(show), wrong } };
}

/** Per-key mean over repeats (null when no repeat has a value). */
export function averageMetrics(reps: readonly Metrics[]): Metrics {
  const keys = [...new Set(reps.flatMap((m) => Object.keys(m)))];
  return Object.fromEntries(keys.map((key) => [key, mean(reps.map((m) => m[key]))]));
}

/**
 * Repeat stability against repeat 0. rank: |Δs| (points of 1000) mean / p95 / max and elements
 * crossing the Matches threshold per repeat; groups: share of elements whose chosen group or
 * final bucket changes.
 */
export function rankStability(reps: readonly ReadonlyMap<ElementId, number>[], thr = SORT_MATCH_THRESHOLD): Metrics {
  const [r0, ...rest] = reps;
  if (!r0 || !rest.length) return {};
  const diffs: number[] = [];
  const cross: number[] = [];
  for (const r of rest) {
    let crossed = 0;
    for (const [id, s] of r) {
      const s0 = r0.get(id);
      if (s0 === undefined) continue;
      diffs.push(Math.abs(s - s0));
      if (s >= thr !== s0 >= thr) crossed++;
    }
    cross.push(crossed);
  }
  return { instMean: mean(diffs), instP95: quantile(diffs, 0.95), instMax: diffs.length ? Math.max(...diffs) : null, instCross: mean(cross) };
}

export function groupsStability(c: GroupsCase, reps: readonly ReadonlyMap<ElementId, SortScore>[]): Metrics {
  const [r0, ...rest] = reps;
  if (!r0 || !rest.length) return {};
  const spec = specOf(c);
  const c0 = committedOf(spec, r0);
  const choice: number[] = [];
  const bucket: number[] = [];
  for (const r of rest) {
    const cr = committedOf(spec, r);
    for (const [id, sc] of r) {
      const sc0 = r0.get(id);
      if (!sc0) continue;
      choice.push(sc.g !== sc0.g ? 1 : 0);
      bucket.push(groupOf(cr, id, c.other) !== groupOf(c0, id, c.other) ? 1 : 0);
    }
  }
  return { choiceFlip: mean(choice), bucketFlip: mean(bucket) };
}

// ---------------------------------------------------------------- summaries and gates

/** One case of a run, as eval-sort.ts reports it and as --json / the baseline file stores it. */
export interface CaseResult {
  id: string;
  split: Split;
  kind: "rank" | "groups";
  category: string;
  /** rank only. */
  family?: Family;
  informational?: boolean;
  /** groups only: number of groups, Other on/off. */
  k?: number;
  other?: boolean;
  status: "ok" | "missing";
  /** Mean over repeats, plus cost (tokens, requests, unparsed, tokPerEl) and stability. */
  metrics?: Metrics;
  detail?: CaseDetail;
}

export type Summary = Record<string, number | null>;
export interface SplitSummary {
  /** Non-informational rank cases. */
  rank: Summary;
  /** Rank cases by family (probe = informational). */
  families: Partial<Record<Family, Summary>>;
  groups: Summary;
  missing: string[];
}

const pick = (cs: readonly CaseResult[], key: string) => cs.map((c) => c.metrics?.[key] ?? null);

/** Aggregates over the ok cases of one split (gated rank numbers skip informational cases). */
export function summarize(cases: readonly CaseResult[], split: Split): SplitSummary {
  const inSplit = cases.filter((c) => c.split === split);
  const ok = inSplit.filter((c) => c.status === "ok" && c.metrics);
  const rankAll = ok.filter((c) => c.kind === "rank");
  const rank = rankAll.filter((c) => !c.informational);
  const grp = ok.filter((c) => c.kind === "groups");
  const rankSummary = (cs: readonly CaseResult[]): Summary => ({
    cases: cs.length,
    auc: mean(pick(cs, "auc")),
    minAuc: minOf(pick(cs, "auc")),
    p10: mean(pick(cs, "p10")),
    tier: mean(pick(cs, "tier")),
    low10: sum(pick(cs, "low10")),
    matchP: mean(pick(cs, "matchP")),
    matchR: mean(pick(cs, "matchR")),
    matchF1: mean(pick(cs, "matchF1")),
    matches: mean(pick(cs, "matches")),
    weak: sum(pick(cs, "weak")),
    junkMatches: sum(pick(cs, "junkMatches")),
    partial: sum(pick(cs, "partial")),
    rho: mean(pick(cs, "rho")),
    revAuc: mean(pick(cs, "revAuc")),
    compAuc: mean(pick(cs, "compAuc")),
    tokPerEl: mean(pick(cs, "tokPerEl")),
    unparsed: sum(pick(cs, "unparsed")),
    tokens: sum(pick(cs, "tokens")),
    instMean: mean(pick(cs, "instMean")),
    instP95: mean(pick(cs, "instP95")),
    instMax: cs.length && pick(cs, "instMax").some((x) => x !== null) ? Math.max(...finite(pick(cs, "instMax"))) : null,
    instCross: mean(pick(cs, "instCross")),
  });
  const families: Partial<Record<Family, Summary>> = {};
  for (const f of FAMILIES) {
    const cs = rankAll.filter((c) => c.family === f);
    if (cs.length) families[f] = rankSummary(cs);
  }
  const on = grp.filter((c) => c.other);
  const off = grp.filter((c) => !c.other);
  const groups: Summary = {
    cases: grp.length,
    labels: sum(pick(grp, "labels")),
    errors: sum(pick(grp, "errors")),
    accAll: mean(pick(grp, "accAll")),
    accOn: mean(pick(on, "accAll")),
    accOff: mean(pick(off, "accAll")),
    choiceAcc: mean(pick(grp, "choiceAcc")),
    choiceSoft: mean(pick(grp, "choiceSoft")),
    otherP: mean(pick(on, "otherP")),
    otherR: mean(pick(on, "otherR")),
    otherF1: mean(pick(on, "otherF1")),
    fitAuc: mean(pick(on, "fitAuc")),
    sinkS: mean(pick(on, "sinkS")),
    sinkSN: mean(pick(on, "sinkSN")),
    firstPick: mean(pick(grp, "firstPick")),
    tokPerEl: mean(pick(grp, "tokPerEl")),
    tokPerElSmall: mean(pick(grp.filter((c) => (c.k ?? 0) <= 4), "tokPerEl")),
    tokPerEl8: mean(pick(grp.filter((c) => c.k === 8), "tokPerEl")),
    unparsed: sum(pick(grp, "unparsed")),
    tokens: sum(pick(grp, "tokens")),
    choiceFlip: mean(pick(grp, "choiceFlip")),
    bucketFlip: mean(pick(grp, "bucketFlip")),
  };
  return { rank: rankSummary(rank), families, groups, missing: inSplit.filter((c) => c.status !== "ok").map((c) => c.id) };
}

/** Holdout gates for --compare (RECOMMENDATION §5): a run fails when any one is crossed. */
export const GATES = {
  /** Any non-informational rank case loses more than this much AUC. */
  aucDrop: 0.02,
  /** Mean P@10 (non-informational rank cases) drops more than this. */
  p10Drop: 0.05,
  /** Mean Matches-F1 drops more than this. */
  matchF1Drop: 0.03,
  /** Groups label errors (strict + soft, summed) rise by more than this. */
  errorsRise: 3,
  /** Tokens per element (rank, and groups) rise by more than this fraction. */
  tokensRise: 0.1,
} as const;

export interface GateRow {
  gate: string;
  baseline: number | null;
  run: number | null;
  /** Human limit, e.g. "drop ≤ 0.05". */
  limit: string;
  /** null = informational row (never fails). */
  ok: boolean | null;
  note?: string;
}

const EPS = 1e-9;

/**
 * Compare a run with a baseline on one split (holdout for the gates), over the cases both have
 * (so a --cases run compares like with like). Selected cases missing from the run fail.
 */
export function compareRuns(run: readonly CaseResult[], base: readonly CaseResult[], split: Split = "holdout"): { rows: GateRow[]; failed: boolean; common: number } {
  const okBase = new Map(base.filter((c) => c.split === split && c.status === "ok" && c.metrics).map((c) => [c.id, c]));
  const inRun = run.filter((c) => c.split === split && okBase.has(c.id));
  const missing = inRun.filter((c) => c.status !== "ok" || !c.metrics).map((c) => c.id);
  const common = inRun.filter((c) => c.status === "ok" && c.metrics);
  const commonBase = common.map((c) => okBase.get(c.id)!);
  const R = summarize(common, split);
  const B = summarize(commonBase, split);
  const rows: GateRow[] = [];
  rows.push({ gate: "selected cases missing from the run", baseline: 0, run: missing.length, limit: "0", ok: missing.length === 0, note: missing.join(", ") || undefined });

  const rankPairs = common
    .filter((c) => c.kind === "rank" && !c.informational)
    .map((c) => ({ id: c.id, run: c.metrics!.auc ?? null, base: okBase.get(c.id)!.metrics!.auc ?? null }))
    .filter((p): p is { id: string; run: number; base: number } => p.run !== null && p.base !== null);
  const worst = rankPairs.reduce<{ id: string; run: number; base: number } | null>((w, p) => (!w || p.base - p.run > w.base - w.run ? p : w), null);
  const losers = rankPairs.filter((p) => p.base - p.run > GATES.aucDrop + EPS);
  rows.push({
    gate: "rank AUC, worst case",
    baseline: worst?.base ?? null,
    run: worst?.run ?? null,
    limit: `drop ≤ ${GATES.aucDrop} per case`,
    ok: rankPairs.length ? losers.length === 0 : null,
    note: losers.length ? losers.map((p) => `${p.id} ${p.base.toFixed(3)} → ${p.run.toFixed(3)}`).join(", ") : worst ? worst.id : undefined,
  });
  const drop = (gate: string, b: number | null | undefined, r: number | null | undefined, limit: number) =>
    rows.push({ gate, baseline: b ?? null, run: r ?? null, limit: `drop ≤ ${limit}`, ok: b == null || r == null ? null : b - r <= limit + EPS });
  drop("rank mean P@10", B.rank.p10, R.rank.p10, GATES.p10Drop);
  drop("rank mean Matches F1", B.rank.matchF1, R.rank.matchF1, GATES.matchF1Drop);
  const be = B.groups.errors ?? null;
  const re = R.groups.errors ?? null;
  rows.push({
    gate: "groups label errors",
    baseline: be,
    run: re,
    limit: `rise ≤ ${GATES.errorsRise}`,
    ok: !B.groups.cases || be === null || re === null ? null : re - be <= GATES.errorsRise,
  });
  const tok = (gate: string, b: number | null | undefined, r: number | null | undefined) =>
    rows.push({ gate, baseline: b ?? null, run: r ?? null, limit: `rise ≤ ${GATES.tokensRise * 100}%`, ok: b == null || r == null ? null : r <= b * (1 + GATES.tokensRise) + EPS });
  tok("rank tokens / element", B.rank.tokPerEl, R.rank.tokPerEl);
  tok("groups tokens / element", B.groups.tokPerEl, R.groups.tokPerEl);
  // Informational (never fail): the numbers a reviewer looks at next.
  const info = (gate: string, b: number | null | undefined, r: number | null | undefined) => rows.push({ gate, baseline: b ?? null, run: r ?? null, limit: "—", ok: null });
  info("rank mean AUC", B.rank.auc, R.rank.auc);
  info("rank P@10, plain prompts", B.families.plain?.p10, R.families.plain?.p10);
  info("rank tiers", B.rank.tier, R.rank.tier);
  info("rank Matches recall", B.rank.matchR, R.rank.matchR);
  info("groups Other F1", B.groups.otherF1, R.groups.otherF1);
  info("groups weak fits sink (sink s)", B.groups.sinkS, R.groups.sinkS);
  const gated = rows.filter((r) => r.ok !== null);
  const failed = common.length === 0 || missing.length > 0 || gated.some((r) => r.ok === false);
  return { rows, failed, common: common.length };
}
