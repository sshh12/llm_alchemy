// Pure recipe-graph algorithms shared by the backfill, the challenge generator and the e2e seed.
// Element ids are decimal INT8 strings; they are interned to dense ints internally for speed.
import type { Rarity } from "../../src/shared/api.ts";
import { RARITY_ORDER } from "../../src/shared/rarity.ts";

export interface GraphRecipe {
  /** Ingredient multiset (duplicates allowed). */
  ingredients: readonly string[];
  result: string;
}

export interface Metric {
  /** Final value per reachable element (starters are 0). */
  value: Map<string, number>;
  /** Index into the input recipes of the recipe that achieved `value` (absent for starters). */
  via: Map<string, number>;
}

/** Numeric ascending sort of INT8 id strings (lexicographic order is wrong for mixed lengths). */
export function sortIds(ids: readonly string[]): string[] {
  return [...ids].sort((a, b) => {
    const x = BigInt(a);
    const y = BigInt(b);
    return x < y ? -1 : x > y ? 1 : 0;
  });
}

/**
 * Knuth's generalization of Dijkstra for superior functions (the "grammar problem"):
 * value(starter) = 0, value(e) = min over recipes r producing e of combine(values of r's
 * DISTINCT ingredients). Correct because combine(xs) > max(xs) for both metrics below, so
 * elements are finalized in nondecreasing value order. O((E + R·k) log E).
 */
export function knuthFixpoint(
  starters: readonly string[],
  recipes: readonly GraphRecipe[],
  combine: (ingredientValues: number[]) => number,
): Metric {
  const index = new Map<string, number>();
  const ids: string[] = [];
  const intern = (id: string) => {
    let i = index.get(id);
    if (i === undefined) {
      i = ids.length;
      index.set(id, i);
      ids.push(id);
    }
    return i;
  };
  const distinct = recipes.map((r) => [...new Set(r.ingredients.map(intern))]);
  const results = recipes.map((r) => intern(r.result));
  for (const s of starters) intern(s);

  const n = ids.length;
  const uses: number[][] = Array.from({ length: n }, () => []);
  distinct.forEach((ings, ri) => ings.forEach((e) => uses[e]!.push(ri)));
  const remaining = Int32Array.from(distinct, (ings) => ings.length);
  const best = new Float64Array(n).fill(Infinity);
  const via = new Int32Array(n).fill(-1);
  const done = new Uint8Array(n);
  const heap = new MinHeap();

  for (const s of starters) {
    const i = index.get(s)!;
    best[i] = 0;
    heap.push(0, i);
  }
  while (heap.size > 0) {
    const [v, e] = heap.pop();
    if (done[e] || v > best[e]!) continue;
    done[e] = 1;
    for (const ri of uses[e]!) {
      if (--remaining[ri]! !== 0) continue;
      const res = results[ri]!;
      if (done[res]) continue;
      const val = combine(distinct[ri]!.map((x) => best[x]!));
      if (val < best[res]!) {
        best[res] = val;
        via[res] = ri;
        heap.push(val, res);
      }
    }
  }

  const value = new Map<string, number>();
  const viaMap = new Map<string, number>();
  for (let i = 0; i < n; i++) {
    if (!done[i]) continue;
    value.set(ids[i]!, best[i]!);
    if (via[i]! >= 0) viaMap.set(ids[i]!, via[i]!);
  }
  return { value, via: viaMap };
}

/** Generations from the starters: 1 + max ingredient depth. */
export const depthOf = (vals: number[]) => 1 + Math.max(...vals);
/** Minimum number of combinations: 1 + sum over distinct ingredients. */
export const stepsOf = (vals: number[]) => 1 + vals.reduce((a, b) => a + b, 0);

export function computeDepthSteps(starters: readonly string[], recipes: readonly GraphRecipe[]) {
  return { depth: knuthFixpoint(starters, recipes, depthOf), steps: knuthFixpoint(starters, recipes, stepsOf) };
}

/**
 * The legacy notebook's BFS tiers: t0 = starters, t(k+1) = results of 2-ingredient recipes
 * (self-pairs included) whose ingredients are both in t0..tk, minus everything seen so far.
 * That is exactly depth restricted to arity-2 recipes.
 */
export function bfsTiers(starters: readonly string[], recipes: readonly GraphRecipe[]): Map<string, number> {
  return knuthFixpoint(
    starters,
    recipes.filter((r) => r.ingredients.length === 2),
    depthOf,
  ).value;
}

/**
 * Walk the `via` recipes back from `targets` and return every element and recipe index on
 * those derivation trees (the recipes that keep the targets reachable).
 */
export function derivationClosure(targets: Iterable<string>, recipes: readonly GraphRecipe[], metric: Metric) {
  const elements = new Set<string>();
  const recipeIdx = new Set<number>();
  const stack = [...targets].filter((t) => metric.value.has(t));
  while (stack.length) {
    const e = stack.pop()!;
    if (elements.has(e)) continue;
    elements.add(e);
    const ri = metric.via.get(e);
    if (ri === undefined) continue;
    recipeIdx.add(ri);
    for (const ing of recipes[ri]!.ingredients) if (!elements.has(ing)) stack.push(ing);
  }
  return { elements, recipes: recipeIdx };
}

export function histogram(values: Iterable<number>): Map<number, number> {
  const h = new Map<number, number>();
  for (const v of values) h.set(v, (h.get(v) ?? 0) + 1);
  return new Map([...h.entries()].sort((a, b) => a[0] - b[0]));
}

/** Target share of reachable elements per rarity (common..legendary). */
export const RARITY_TARGET_SHARE: Record<Rarity, number> = {
  common: 0.4,
  uncommon: 0.3,
  rare: 0.18,
  epic: 0.09,
  legendary: 0.03,
};

/**
 * Pick monotonic integer depth thresholds so the share of elements per rarity is as close as
 * possible to RARITY_TARGET_SHARE. Each boundary minimizes |cdf - target cdf| independently,
 * subject to staying strictly above the previous one.
 */
export function suggestRarityThresholds(depthHistogram: Map<number, number>): {
  thresholds: Record<Rarity, number>;
  share: Record<Rarity, number>;
} {
  const total = [...depthHistogram.values()].reduce((a, b) => a + b, 0);
  const maxDepth = Math.max(0, ...depthHistogram.keys());
  const below = (t: number) => {
    let c = 0;
    for (const [d, k] of depthHistogram) if (d < t) c += k;
    return total ? c / total : 0;
  };
  const thresholds = { common: 0 } as Record<Rarity, number>;
  let cumTarget = 0;
  let prev = 0;
  for (let i = 1; i < RARITY_ORDER.length; i++) {
    cumTarget += RARITY_TARGET_SHARE[RARITY_ORDER[i - 1]!];
    let bestT = prev + 1;
    let bestErr = Infinity;
    // Leave room for the remaining tiers to stay strictly increasing.
    const maxT = Math.max(prev + 1, maxDepth + 1 - (RARITY_ORDER.length - 1 - i));
    for (let t = prev + 1; t <= maxT; t++) {
      const err = Math.abs(below(t) - cumTarget);
      if (err < bestErr) {
        bestErr = err;
        bestT = t;
      }
    }
    thresholds[RARITY_ORDER[i]!] = bestT;
    prev = bestT;
  }
  const share = {} as Record<Rarity, number>;
  RARITY_ORDER.forEach((r, i) => {
    const next = RARITY_ORDER[i + 1];
    share[r] = (next ? below(thresholds[next]) : 1) - below(thresholds[r]);
  });
  return { thresholds, share };
}

/** Binary min-heap of (priority, item) pairs. */
class MinHeap {
  private pri: number[] = [];
  private item: number[] = [];
  get size() {
    return this.pri.length;
  }
  push(p: number, x: number) {
    const { pri, item } = this;
    let i = pri.length;
    pri.push(p);
    item.push(x);
    while (i > 0) {
      const parent = (i - 1) >> 1;
      if (pri[parent]! <= p) break;
      pri[i] = pri[parent]!;
      item[i] = item[parent]!;
      i = parent;
    }
    pri[i] = p;
    item[i] = x;
  }
  pop(): [number, number] {
    const { pri, item } = this;
    const top: [number, number] = [pri[0]!, item[0]!];
    const lastP = pri.pop()!;
    const lastX = item.pop()!;
    if (pri.length > 0) {
      let i = 0;
      const n = pri.length;
      for (;;) {
        const l = 2 * i + 1;
        if (l >= n) break;
        const r = l + 1;
        const c = r < n && pri[r]! < pri[l]! ? r : l;
        if (pri[c]! >= lastP) break;
        pri[i] = pri[c]!;
        item[i] = item[c]!;
        i = c;
      }
      pri[i] = lastP;
      item[i] = lastX;
    }
    return top;
  }
}
