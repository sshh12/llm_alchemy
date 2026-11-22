// Pure daily-challenge selection and checking (used by scripts/generate-challenges.ts,
// scripts/check-challenges.ts, scripts/classify-recognizable.ts and scripts/purge-elements.ts).
import type { Tier } from "../../src/shared/api.ts";
import { addDays, utcDay } from "../../src/shared/dates.ts";
import { checkName } from "../../src/shared/names.ts";
import { bfsTiers, sortIds, type GraphRecipe } from "./graph.ts";
import { schoolSafety } from "./schoolSafety.ts";

export const TIERS: Tier[] = ["easy", "hard", "expert"];
/** BFS tier (generations over 2-ingredient recipes) each challenge tier draws from (legacy notebook). */
export const TIER_LEVEL: Record<Tier, number> = { easy: 2, hard: 4, expert: 6 };
/** A target is not reused (on any tier) within this many days when the pool allows. */
export const NO_REPEAT_DAYS = 120;
/**
 * A tier draws ONLY from recognizable targets when at least this many exist (repeats in a pool
 * of P < NO_REPEAT_DAYS come from the least-recently-used quarter, so they stay ≥ ~0.75·P ≈ 30
 * days apart). Below it the tier falls back to every eligible candidate, recognizable first.
 * Decided BEFORE the easy path rule, which then applies inside the chosen set: the filtered
 * easy pool (~26 in Nov 2026) is below 40, and deciding on it would flip easy into fallback
 * mode and let non-recognizable names in.
 */
export const MIN_RECOGNIZABLE_POOL = 40;
/**
 * Easy targets need at least this many shallow paths (see analyzeWorld `paths`). Weekday easy
 * completion in Nov 2026 was 17% on 1-path days vs 42% on 3+-path days (new players' day 0:
 * 12.5% vs 44%).
 */
export const MIN_EASY_PATHS = 3;
/**
 * The easy path rule is a hard filter while at least this many candidates pass it (repeats then
 * stay ≥ ~9 days apart); below that it degrades to a preference so the tier never runs dry, and
 * check-challenges reports the resulting "undiscoverable" days. Kept low on purpose: a repeat
 * every week or two hurts far less than a 1-path easy day.
 */
export const MIN_DISCOVERABLE_POOL = 12;
/**
 * Recorded in challenges.generator and part of the PRNG seed. v3: recognizable targets.
 * v4: easy needs ≥ MIN_EASY_PATHS shallow paths; no blocked art or school-unsafe names on any
 * tier; steps strictly increase easy < hard < expert; repeats also avoid stored FUTURE days.
 */
export const GENERATOR = "bfs-v4";

export type DayTargets = Record<Tier, string>;

export interface TierPool {
  /** Eligible element ids. */
  candidates: string[];
  /**
   * Ordered preference layers (subsets of `candidates`). Each day the bag of fresh candidates
   * narrows to the first layer it intersects (e.g. recognizable first in fallback mode).
   */
  preferred?: readonly ReadonlySet<string>[];
}

export interface PoolElement {
  id: string;
  name: string;
  isStarter: boolean;
  /** scripts/classify-recognizable.ts verdict; null/undefined = not classified yet. */
  recognizable?: boolean | null;
  /**
   * elements.depth (generations over recipes of ANY arity, so 3-4-ingredient shortcuts count).
   * undefined = not loaded: the easy path rule is then skipped (scripts/purge-elements.ts builds
   * its pools without depth). null = unreachable.
   */
  depth?: number | null;
  /** elements.image_status; a "blocked" (moderated) target would show a placeholder forever. */
  imageStatus?: string | null;
  /** elements.steps (min number of combinations), for tier ordering. */
  steps?: number | null;
}

export interface PoolStats {
  bfsTier: number;
  /** Non-starters at the BFS tier whose name passes checkName, minus the two exclusions below. */
  eligible: number;
  recognizable: number;
  notRecognizable: number;
  unclassified: number;
  /** Left out of `eligible`: school-unsafe names (scripts/lib/schoolSafety.ts). */
  unsafe: number;
  /** Left out of `eligible`: image_status = 'blocked'. */
  artBlocked: number;
  /** "recognizable" = candidates are the recognizable ones; "fallback" = all eligible, recognizable preferred. */
  mode: "recognizable" | "fallback";
  /** Easy: members of the mode's set with ≥ minEasyPaths shallow paths; null when the rule is off. */
  discoverable: number | null;
  /** "required" = hard filter; "preferred" = too few passed, soft first layer; "off" = not easy, or no depth loaded. */
  pathRule: "required" | "preferred" | "off";
}

/**
 * BFS tiers over the ACTIVE world: 2-ingredient recipes (self-pairs included) whose result and
 * ingredients are all active, from the starters. `witnesses` counts, per element, the recipes
 * that witness its tier (both ingredients from lower tiers). `eligibleAt(level)` = non-starters
 * at that BFS tier whose name passes checkName (protected legacy names that fail it are skipped),
 * sorted numerically: the raw candidate pool for a challenge tier.
 *
 * `paths` (only when depth is loaded: `hasDepth`) counts, per element, the active 2-ingredient
 * recipes producing it whose two ingredients both have elements.depth <= 1 (a starter or one
 * combine away) and are not the element itself: the ways a brand-new player can stumble onto
 * it. It predicts easy completion much better than `witnesses`, which only sees 2-ingredient
 * routes (Fossil: 1 witness, 5 paths, 44% completion).
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
  const hasDepth = elements.some((e) => e.depth !== undefined);
  const paths = new Map<string, number>();
  if (hasDepth) {
    const shallow = (id: string) => {
      const d = active.get(id)!.depth;
      return d != null && d <= 1;
    };
    for (const r of pairs) {
      if (r.ingredients.every((i) => i !== r.result && shallow(i))) paths.set(r.result, (paths.get(r.result) ?? 0) + 1);
    }
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
  return { active, tiers, witnesses, paths, hasDepth, tierSizes: new Map([...tierSizes].sort((a, b) => a[0] - b[0])), eligibleAt };
}

export interface PoolOptions {
  minRecognizable?: number;
  minEasyPaths?: number;
  minDiscoverable?: number;
}

/**
 * Candidate pools per tier: easy/hard/expert draw from BFS tier 2/4/6 (see analyzeWorld).
 * Every tier leaves out school-unsafe names and blocked art. When at least `minRecognizable`
 * eligible elements are classified recognizable, the pool is exactly those; otherwise it falls
 * back to every eligible element with the recognizable ones as the first preference layer
 * (unclassified counts as not recognizable).
 * Easy then keeps only targets with ≥ `minEasyPaths` shallow paths, inside the set chosen above
 * (see MIN_RECOGNIZABLE_POOL), as long as at least `minDiscoverable` pass; otherwise those
 * become the first preference layer instead.
 */
export function buildPools(
  elements: readonly PoolElement[],
  recipes: readonly GraphRecipe[],
  { minRecognizable = MIN_RECOGNIZABLE_POOL, minEasyPaths = MIN_EASY_PATHS, minDiscoverable = MIN_DISCOVERABLE_POOL }: PoolOptions = {},
) {
  const { active, witnesses, paths, hasDepth, tierSizes, eligibleAt } = analyzeWorld(elements, recipes);
  const pools = {} as Record<Tier, TierPool>;
  const stats = {} as Record<Tier, PoolStats>;
  const nonEmpty = (layers: string[][]) => layers.filter((l) => l.length > 0).map((l) => new Set(l));
  for (const tier of TIERS) {
    const raw = eligibleAt(TIER_LEVEL[tier]);
    const unsafe = new Set(raw.filter((id) => !schoolSafety(active.get(id)!.name).ok));
    const safe = raw.filter((id) => !unsafe.has(id));
    const eligible = safe.filter((id) => active.get(id)!.imageStatus !== "blocked");
    const verdict = (id: string) => active.get(id)!.recognizable;
    const yes = eligible.filter((id) => verdict(id) === true);
    const notRecognizable = eligible.filter((id) => verdict(id) === false).length;
    const strict = yes.length >= minRecognizable;
    const base = strict ? yes : eligible;

    const pathRuleOn = tier === "easy" && hasDepth;
    const discoverable = (id: string) => !pathRuleOn || (paths.get(id) ?? 0) >= minEasyPaths;
    const found = base.filter(discoverable);
    const pathRule: PoolStats["pathRule"] = !pathRuleOn ? "off" : found.length >= minDiscoverable ? "required" : "preferred";
    const soft = pathRule === "preferred";
    const yesFound = yes.filter(discoverable);
    // With the rule off, found = base and yesFound = yes: the v3 shapes (strict: no layers;
    // fallback: candidates = all eligible, recognizable first).
    pools[tier] = strict
      ? { candidates: soft ? base : found, preferred: nonEmpty(soft ? [found] : []) }
      : { candidates: soft ? base : found, preferred: nonEmpty(soft ? [yesFound, yes, found] : [yesFound]) };
    stats[tier] = {
      bfsTier: TIER_LEVEL[tier],
      eligible: eligible.length,
      recognizable: yes.length,
      notRecognizable,
      unclassified: eligible.length - yes.length - notRecognizable,
      unsafe: unsafe.size,
      artBlocked: safe.length - eligible.length,
      mode: strict ? "recognizable" : "fallback",
      discoverable: pathRuleOn ? found.length : null,
      pathRule,
    };
  }
  return { pools, stats, tierSizes, witnesses, paths };
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

export interface PickOptions {
  /**
   * Current elements.steps per id. When given, each day's tiers are strictly ordered by steps
   * (hard > easy, expert > hard): a tier draws only from candidates above the previous tier's
   * pick while any exist (otherwise unconstrained; check-challenges then reports "tier-order").
   * Lower bounds only: there is deliberately no upper cap on expert steps.
   */
  steps?: ReadonlyMap<string, number | null | undefined>;
}

/**
 * Choose targets for each day in `days` (ascending, contiguous). Days present in `fixed`
 * (already stored) keep their targets and only update the recency state, so the result is a
 * deterministic function of (pools, fixed rows, history). `history` = earlier days (e.g. the
 * legacy challenges right before the cutover) that count toward the no-repeat window.
 *
 * Per day and tier, with an RNG seeded by `${GENERATOR}:${day}:${tier}`:
 *  1. open = candidates not already chosen for this day; with `steps`, narrowed to those with
 *     more steps than the previous tier's pick (when any qualify).
 *  2. bag = open candidates whose nearest use on any tier, earlier OR later (stored days in
 *     `fixed` after this one, which matters when single days are re-picked), is at least
 *     NO_REPEAT_DAYS away.
 *  3. If the bag is empty (pool smaller than the window), bag = the quarter of `open` farthest
 *     from any use, so repeats are spaced as far apart as the pool allows.
 *  4. Narrow the bag to the first `preferred` layer it intersects (if any), then draw uniformly.
 */
export function pickChallenges(
  days: readonly string[],
  pools: Record<Tier, TierPool>,
  fixed: ReadonlyMap<string, DayTargets>,
  history: readonly { day: string; targets: DayTargets }[] = [],
  { steps }: PickOptions = {},
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
  // Stored days per target, ascending: the look-ahead half of the distance.
  const storedUses = new Map<string, number[]>();
  for (const [day, t] of fixed) {
    for (const tier of TIERS) {
      const list = storedUses.get(t[tier]) ?? [];
      list.push(dayNumber(day));
      storedUses.set(t[tier], list);
    }
  }
  for (const list of storedUses.values()) list.sort((a, b) => a - b);
  const nextUse = (id: string, n: number) => storedUses.get(id)?.find((d) => d > n) ?? Infinity;

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
    let floor: number | null | undefined; // steps of the previous tier's pick
    for (const tier of TIERS) {
      const rng = mulberry32(hash32(`${GENERATOR}:${day}:${tier}`));
      const { candidates, preferred } = pools[tier];
      let open = candidates.filter((c) => !today.has(c));
      if (steps && floor != null) {
        const min = floor;
        const above = open.filter((c) => (steps.get(c) ?? Infinity) > min);
        if (above.length > 0) open = above;
      }
      const distance = (c: string) => Math.min(n - (lastUsed.get(c) ?? -Infinity), nextUse(c, n) - n);
      let bag = open.filter((c) => distance(c) >= NO_REPEAT_DAYS);
      if (bag.length === 0) {
        // Stable order: farthest from any use first, ties by id, so the choice is deterministic.
        const byDistance = [...open].sort((a, b) => distance(b) - distance(a) || (a < b ? -1 : 1));
        bag = byDistance.slice(0, Math.max(1, Math.ceil(byDistance.length / 4)));
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
      floor = steps?.get(pick);
    }
    use(day, chosen);
    out.set(day, chosen);
  }
  return out;
}

// ---------------------------------------------------------------- checking stored days

/**
 * At `now`: the days that are "today" somewhere on Earth (UTC-12 .. UTC+14), and the last day
 * that must not be re-picked any more. `frozenThrough` = lastLive + 1 because tomorrow's easy
 * target is shown as a teaser while the last live day is today anywhere (bootstrap `tomorrow`).
 * So a day D freezes at D-2 10:00 UTC (repickDeadline), when D-1 starts in UTC+14.
 */
export function liveWindow(now: Date): { firstLive: string; lastLive: string; frozenThrough: string } {
  const firstLive = utcDay(new Date(now.getTime() - 12 * 3_600_000));
  const lastLive = utcDay(new Date(now.getTime() + 14 * 3_600_000));
  return { firstLive, lastLive, frozenThrough: addDays(lastLive, 1) };
}

/** The first instant at which `day` is frozen (liveWindow(t).frozenThrough >= day). */
export function repickDeadline(day: string): Date {
  return new Date(`${addDays(day, -2)}T10:00:00Z`);
}

/** Split days into those a re-pick may still touch at `now` (strictly after frozenThrough) and the frozen rest. */
export function splitRepickable(days: readonly string[], now: Date): { fixable: string[]; frozen: string[] } {
  const { frozenThrough } = liveWindow(now);
  return { fixable: days.filter((d) => d > frozenThrough), frozen: days.filter((d) => d <= frozenThrough) };
}

export type Problem =
  | "inactive"
  | "unreachable"
  | "tier-drift"
  | "not-recognizable"
  | "undiscoverable"
  | "art-blocked"
  | "unsafe"
  | "tier-order";

/** Problems that make a day worth re-picking (check-challenges --fix); the others are warnings. */
export const BROKEN_PROBLEMS: ReadonlySet<Problem> = new Set<Problem>(["inactive", "unreachable", "undiscoverable", "art-blocked", "unsafe", "tier-order"]);

export interface StoredDay {
  day: string;
  source: string;
  targets: DayTargets;
}

export interface Issue {
  day: string;
  tier: Tier;
  id: string;
  problem: Problem;
  detail: string;
}

/**
 * Everything wrong with stored days in the current world (analyzeWorld over elements loaded
 * with depth, steps and imageStatus): unsolvable targets, the v4 pool rules (easy shallow paths,
 * blocked art, school safety) and tier ordering on current steps. An inactive target gets no
 * further checks.
 */
export function checkDays(
  rows: readonly StoredDay[],
  world: Pick<ReturnType<typeof analyzeWorld>, "active" | "tiers" | "paths" | "hasDepth">,
  { minEasyPaths = MIN_EASY_PATHS }: { minEasyPaths?: number } = {},
): Issue[] {
  const { active, tiers, paths, hasDepth } = world;
  const issues: Issue[] = [];
  for (const r of rows) {
    for (const tier of TIERS) {
      const id = r.targets[tier];
      const add = (problem: Problem, detail: string) => issues.push({ day: r.day, tier, id, problem, detail });
      const e = active.get(id);
      if (!e) {
        add("inactive", "not an active element");
        continue;
      }
      const t = tiers.get(id);
      if (t === undefined) add("unreachable", "no path from the starters over active 2-ingredient recipes");
      else if (t !== TIER_LEVEL[tier]) add("tier-drift", `BFS tier ${t}, intended ${TIER_LEVEL[tier]}`);
      if (r.source === "generated" && e.recognizable !== true) add("not-recognizable", `recognizable=${e.recognizable}`);
      const p = paths.get(id) ?? 0;
      if (tier === "easy" && hasDepth && p < minEasyPaths) add("undiscoverable", `${p} shallow path(s), need ${minEasyPaths}`);
      if (e.imageStatus === "blocked") add("art-blocked", "image_status blocked");
      const safety = schoolSafety(e.name);
      if (!safety.ok) add("unsafe", `${safety.category}: "${safety.match}"`);
    }
    for (const [lower, upper] of [["easy", "hard"], ["hard", "expert"]] as const) {
      const lo = active.get(r.targets[lower])?.steps;
      const hi = active.get(r.targets[upper])?.steps;
      if (lo != null && hi != null && hi <= lo) {
        issues.push({ day: r.day, tier: upper, id: r.targets[upper], problem: "tier-order", detail: `${upper} ${hi} step(s) <= ${lower} ${lo}` });
      }
    }
  }
  return issues;
}
