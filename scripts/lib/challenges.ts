// Pure daily-challenge selection (used by scripts/generate-challenges.ts and
// scripts/classify-recognizable.ts).
import type { Tier } from "../../src/shared/api.ts";
import { addDays } from "../../src/shared/dates.ts";
import { checkName } from "../../src/shared/names.ts";
import { bfsTiers, sortIds, type GraphRecipe } from "./graph.ts";

export const TIERS: Tier[] = ["easy", "hard", "expert"];
/** BFS tier (generations over 2-ingredient recipes) each challenge tier draws from (legacy notebook). */
export const TIER_LEVEL: Record<Tier, number> = { easy: 2, hard: 4, expert: 6 };
/** A target is not reused (on any tier) within this many days when the pool allows. */
export const NO_REPEAT_DAYS = 120;
/**
 * A tier draws ONLY from recognizable targets when at least this many exist (repeats in a pool
 * of P < NO_REPEAT_DAYS come from the least-recently-used quarter, so they stay ≥ ~0.75·P ≈ 30
 * days apart). Below it the tier falls back to every eligible candidate, recognizable first.
 */
export const MIN_RECOGNIZABLE_POOL = 40;
/** Recorded in challenges.generator and part of the PRNG seed. v3: recognizable targets. */
export const GENERATOR = "bfs-v3";

export type DayTargets = Record<Tier, string>;

export interface TierPool {
  /** Eligible element ids. */
  candidates: string[];
  /**
   * Ordered preference layers (subsets of `candidates`). Each day the bag of fresh candidates
   * narrows to the first layer it intersects (easy: recognizable and well-connected first).
   */
  preferred?: readonly ReadonlySet<string>[];
}

export interface PoolElement {
  id: string;
  name: string;
  isStarter: boolean;
  /** scripts/classify-recognizable.ts verdict; null/undefined = not classified yet. */
  recognizable?: boolean | null;
}

export interface PoolStats {
  bfsTier: number;
  /** Non-starters at the BFS tier whose name passes checkName. */
  eligible: number;
  recognizable: number;
  notRecognizable: number;
  unclassified: number;
  /** "recognizable" = candidates are the recognizable ones; "fallback" = all eligible, recognizable preferred. */
  mode: "recognizable" | "fallback";
}

/**
 * BFS tiers over the ACTIVE world: 2-ingredient recipes (self-pairs included) whose result and
 * ingredients are all active, from the starters. `witnesses` counts, per element, the recipes
 * that witness its tier (both ingredients from lower tiers). `eligibleAt(level)` = non-starters
 * at that BFS tier whose name passes checkName (protected legacy names that fail it are skipped),
 * sorted numerically: the raw candidate pool for a challenge tier.
 */
export function analyzeWorld(elements: readonly PoolElement[], recipes: readonly GraphRecipe[]) {
  const active = new Map(elements.map((e) => [e.id, e]));
  const pairs = recipes.filter((r) => r.ingredients.length === 2 && active.has(r.result) && r.ingredients.every((i) => active.has(i)));
  const starters = elements.filter((e) => e.isStarter).map((e) => e.id);
  const tiers = bfsTiers(starters, pairs);
  const witnesses = new Map<string, number>();
  for (const r of pairs) {
    const t = tiers.get(r.result);
    if (t !== undefined && r.ingredients.every((i) => (tiers.get(i) ?? Infinity) < t)) witnesses.set(r.result, (witnesses.get(r.result) ?? 0) + 1);
  }
  const tierSizes = new Map<number, number>();
  for (const t of tiers.values()) tierSizes.set(t, (tierSizes.get(t) ?? 0) + 1);
  const eligibleAt = (level: number) =>
    sortIds(
      [...tiers]
        .filter(([id, t]) => {
          if (t !== level) return false;
          const e = active.get(id)!;
          return !e.isStarter && checkName(e.name).ok;
        })
        .map(([id]) => id),
    );
  return { active, tiers, witnesses, tierSizes: new Map([...tierSizes].sort((a, b) => a[0] - b[0])), eligibleAt };
}

/**
 * Candidate pools per tier: easy/hard/expert draw from BFS tier 2/4/6 (see analyzeWorld).
 * When at least `minRecognizable` eligible elements are classified recognizable, the pool is
 * exactly those; otherwise it falls back to every eligible element with the recognizable ones
 * as the first preference layer (unclassified counts as not recognizable).
 * Easy also prefers well-connected targets: ≥2 witnessing recipes, so new players have more than
 * one way to stumble onto it.
 */
export function buildPools(
  elements: readonly PoolElement[],
  recipes: readonly GraphRecipe[],
  { minRecognizable = MIN_RECOGNIZABLE_POOL }: { minRecognizable?: number } = {},
) {
  const { active, witnesses, tierSizes, eligibleAt } = analyzeWorld(elements, recipes);
  const pools = {} as Record<Tier, TierPool>;
  const stats = {} as Record<Tier, PoolStats>;
  const nonEmpty = (layers: string[][]) => layers.filter((l) => l.length > 0).map((l) => new Set(l));
  for (const tier of TIERS) {
    const eligible = eligibleAt(TIER_LEVEL[tier]);
    const verdict = (id: string) => active.get(id)!.recognizable;
    const yes = eligible.filter((id) => verdict(id) === true);
    const notRecognizable = eligible.filter((id) => verdict(id) === false).length;
    const wellConnected = (id: string) => tier === "easy" && (witnesses.get(id) ?? 0) >= 2;
    const strict = yes.length >= minRecognizable;
    pools[tier] = strict
      ? { candidates: yes, preferred: nonEmpty([yes.filter(wellConnected)]) }
      : { candidates: eligible, preferred: nonEmpty([yes.filter(wellConnected), yes, eligible.filter(wellConnected)]) };
    stats[tier] = {
      bfsTier: TIER_LEVEL[tier],
      eligible: eligible.length,
      recognizable: yes.length,
      notRecognizable,
      unclassified: eligible.length - yes.length - notRecognizable,
      mode: strict ? "recognizable" : "fallback",
    };
  }
  return { pools, stats, tierSizes, witnesses };
}


/** 32-bit FNV-1a. */
export function hash32(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** mulberry32: small, fast, deterministic PRNG returning floats in [0, 1). */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const dayNumber = (day: string) => Math.round(Date.parse(`${day}T00:00:00Z`) / 86_400_000);

export function dayRange(from: string, count: number): string[] {
  return Array.from({ length: count }, (_, i) => addDays(from, i));
}

/**
 * Choose targets for each day in `days` (ascending, contiguous). Days present in `fixed`
 * (already stored) keep their targets and only update the recency state, so the result is a
 * deterministic function of (pools, fixed rows, history). `history` = earlier days (e.g. the
 * legacy challenges right before the cutover) that count toward the no-repeat window.
 *
 * Per day and tier, with an RNG seeded by `${GENERATOR}:${day}:${tier}`:
 *  1. bag = candidates not used on any tier in the last NO_REPEAT_DAYS days and not already
 *     chosen for this day.
 *  2. If the bag is empty (pool smaller than the window), bag = the least-recently-used quarter
 *     of the pool, so repeats are spaced as far apart as the pool allows.
 *  3. Narrow the bag to the first `preferred` layer it intersects (if any), then draw uniformly.
 */
export function pickChallenges(
  days: readonly string[],
  pools: Record<Tier, TierPool>,
  fixed: ReadonlyMap<string, DayTargets>,
  history: readonly { day: string; targets: DayTargets }[] = [],
): Map<string, DayTargets> {
  for (const tier of TIERS) {
    if (pools[tier].candidates.length === 0) throw new Error(`empty ${tier} pool`);
  }
  const lastUsed = new Map<string, number>();
  const use = (day: string, t: DayTargets) => {
    const n = dayNumber(day);
    for (const tier of TIERS) lastUsed.set(t[tier], Math.max(n, lastUsed.get(t[tier]) ?? -Infinity));
  };
  for (const h of [...history].sort((a, b) => (a.day < b.day ? -1 : 1))) use(h.day, h.targets);

  const out = new Map<string, DayTargets>();
  for (const day of days) {
    const stored = fixed.get(day);
    if (stored) {
      use(day, stored);
      out.set(day, stored);
      continue;
    }
    const n = dayNumber(day);
    const today = new Set<string>();
    const chosen = {} as DayTargets;
    for (const tier of TIERS) {
      const rng = mulberry32(hash32(`${GENERATOR}:${day}:${tier}`));
      const { candidates, preferred } = pools[tier];
      const open = candidates.filter((c) => !today.has(c));
      let bag = open.filter((c) => n - (lastUsed.get(c) ?? -Infinity) >= NO_REPEAT_DAYS);
      if (bag.length === 0) {
        // Stable order: oldest use first, ties by id, so the choice is deterministic.
        const byAge = [...open].sort((a, b) => (lastUsed.get(a) ?? -Infinity) - (lastUsed.get(b) ?? -Infinity) || (a < b ? -1 : 1));
        bag = byAge.slice(0, Math.max(1, Math.ceil(byAge.length / 4)));
      }
      for (const layer of preferred ?? []) {
        const pref = bag.filter((c) => layer.has(c));
        if (pref.length > 0) {
          bag = pref;
          break;
        }
      }
      const pick = bag[Math.floor(rng() * bag.length)]!;
      chosen[tier] = pick;
      today.add(pick);
    }
    use(day, chosen);
    out.set(day, chosen);
  }
  return out;
}
