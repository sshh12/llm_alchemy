// Daily-challenge generator "pred-v6" (pure; used by scripts/generate-challenges.ts,
// scripts/check-challenges.ts and scripts/purge-elements.ts).
//
// Each tier is picked by PREDICTED COMPLETION (scripts/lib/challengeModel.ts: a frozen logistic
// model of reach and steps), inside fun and safety constraints:
//   C1  active, not a starter, checkName ok, not the onboarding demo result (Steam), has an emoji
//   C2  solvable over active 2-ingredient recipes (analyzeWorld BFS; the tier value is unused)
//   C3  recognizable === true (no fallback)
//   C4  art not blocked; pool members (every tier) also need art ready, so no target's art is
//       generated live in front of a class
//   C5  schoolSafety (name) and EMOJI_DENY (emoji), not in CHALLENGE_DENY, classifier teacher
//       flag not true
//   C5b path safety: the shortest route avoiding C5-failing intermediates is at most steps + 1
//       (Cartridge needs Bullet or Ammunition; Excalibur needs Sword)
//   C6  steps inside the tier's range for the day type (BANDS)
//   C7  easy: not in EASY_DENY (EASY_SOFT_DENY too, while the easy pool stays >= MIN_POOL without it)
//   C8  no spelling-twin trap (a twin at least as widely made); per tier (C8b) also none made by
//       >= 25% as many players (or >= 5% of players) for easy, >= 50% for hard/expert
//   C9  hard/expert: no synonym trap (a kid synonym made 2x as widely; needs classifier tags)
//   C10 in season; on named holidays no hazard/disease emoji
//   C11 120-day no-repeat across tiers (LRU quarter fallback), no emoji / name word / synonym
//       group shared with days within ±6 (dropped word first, emoji last, only if the bag empties)
//   C12 hard/expert: no near-name trap (a name containing the target, "Acid Rain" for "Acid", made
//       by >= 3x as many players and >= 1%), and an aha floor (>= 2 near-optimal recipes, or a
//       name or emoji link to an ingredient)
// Pools per day type are the candidates whose school-basis p is inside the band (widened down to a
// floor when too small), disjoint in tier order. Each day: easy, then hard (steps >= easy + 1),
// then expert (steps >= hard + 2 on weekdays, else + 1; school-basis p below the tier below; reach
// <= the tier below), then the experiment arm slice (thirds by frozen p cut points, THIRD_CUTS),
// then a stable weighted draw (Efraimidis-Spirakis on a per-element hash). Adding or removing a
// candidate never moves another day's pick unless the pick itself becomes ineligible, or the bag
// is in its LRU fallback (pools smaller than the 120-day horizon: easy, Monday hard), whose
// quarter size depends on the pool size; changed picks then propagate through the repeat and
// variety rules. Every planned day carries meta (features, predictions, arms, provenance) for the
// learning loop.
import type { Tier } from "../../src/shared/api.ts";
import { addDays, utcDay } from "../../src/shared/dates.ts";
import { checkName, foldKey, nameKey } from "../../src/shared/names.ts";
import { DEMO_RECIPE } from "../../src/shared/starters.ts";
import {
  computeAha,
  directLinks,
  inSeason,
  isAbstract,
  isTwinTrap,
  nameWords,
  NearNameIndex,
  nearNameTrap,
  seasonalRule,
  synonymTrap,
  topTwin,
  TwinIndex,
  type AhaFeatures,
} from "./challengeFeatures.ts";
import {
  armFor,
  BAND_FLOOR,
  BANDS,
  COEF_EXPECT,
  dayType,
  EASY_CAPABLE_P,
  EXPLORE_BAND,
  logit,
  MIN_POOL,
  MODEL_VERSION,
  namedHoliday,
  predict,
  predictLogit,
  COEF_SELECT,
  REACH7_OFFSET,
  sigmoid,
  SUPPORT_REACH,
  THIRD_CUTS,
  thirdOf,
  u01,
  WIDEN_STEP,
  type Band,
  type DayType,
  type Third,
} from "./challengeModel.ts";
import { bfsTiers, knuthFixpoint, sortIds, stepsOf, type GraphRecipe } from "./graph.ts";
import { reachOf, type Reach, type ReachMode } from "./reach.ts";
import { emojiKey, emojiSafety, isChallengeDenied, schoolSafety } from "./schoolSafety.ts";

export { hash32 } from "./challengeModel.ts";

export const TIERS: Tier[] = ["easy", "hard", "expert"];
/** Recorded in challenges.generator and in every draw's hash key. */
export const GENERATOR = "pred-v6";
/** A target is not reused (on any tier) within this many days, past or stored future, when the pool allows. */
export const NO_REPEAT_DAYS = 120;
/** No emoji, name word or synonym group is shared with a day within this many days. */
export const VARIETY_DAYS = 6;
/** Weekday expert steps >= hard + this (falls back to + 1); 1 on off days. */
export const WEEKDAY_EXPERT_GAP = 2;
/** Lottery weights (hard/expert): exp(AHA_SLOPE · min(aha, AHA_CAP)) × (abstract ? ABSTRACT_WEIGHT : 1) × APPEAL_WEIGHT. */
export const AHA_SLOPE = 0.5;
export const AHA_CAP = 4;
export const ABSTRACT_WEIGHT = 0.6;
export const APPEAL_WEIGHT: Readonly<Record<"hard" | "expert", readonly [number, number, number]>> = { hard: [0.5, 1, 2], expert: [0.25, 1, 3] };
/** Easy targets that lose to their steps-expected completion in legacy data (R3), invisible to reach. */
export const EASY_DENY_NAMES = ["History", "Swamp"] as const;
const EASY_DENY = new Set(EASY_DENY_NAMES.map((n) => foldKey(nameKey(n))));
/**
 * R3 easy losers like History and Swamp (steps-expected ratio 0.48 and 0.55), denied per day type
 * only while the easy pool still reaches MIN_POOL.easy without them (after widening); otherwise
 * kept, so a small pool does not repeat even faster. Applies by itself once more easy names are
 * classified.
 */
export const EASY_SOFT_DENY_NAMES = ["Mountain", "Vapor"] as const;
const EASY_SOFT_DENY = new Set(EASY_SOFT_DENY_NAMES.map((n) => foldKey(nameKey(n))));
/** C8b: a twin with reach >= share x the candidate's drops it (easy also at >= EASY_TWIN_ABS absolute). */
export const TWIN_SHARE: Readonly<Record<"easy" | "upper", number>> = { easy: 0.25, upper: 0.5 };
export const EASY_TWIN_ABS = 0.05;
/** C5b: the shortest route avoiding C5-failing elements may be at most this many steps longer. */
export const SAFE_PATH_SLACK = 1;
/** C12 aha floor (hard/expert/explore pools): nearOpt >= this, or a name or emoji link. */
export const AHA_FLOOR_NEAR_OPT = 2;
/** C10: hazard and disease emoji kept off named holidays (namedHoliday). */
export const HOLIDAY_GLOOM_EMOJI: ReadonlySet<string> = new Set(["🦠", "☢️", "☣️", "☠️", "🚨", "🛢️"].map(emojiKey));
/** Steps range of the candidate universe (the classifier's selection too). */
export const MAX_CANDIDATE_STEPS = 14;

export type DayTargets = Record<Tier, string>;

/** Legacy BFS tier per challenge tier (bfs-v1..v5); still used by scripts/classify-recognizable.ts --tiers. */
export const TIER_LEVEL: Record<Tier, number> = { easy: 2, hard: 4, expert: 6 };

/** Legacy pool shape (bfs-v5), kept for scripts/lib/purge.ts brokenFutureDays. */
export interface TierPool {
  candidates: string[];
  preferred?: readonly ReadonlySet<string>[];
}

/** elements.challenge_tags (classifier, migration 0010), or --tags-in. */
export interface ChallengeTags {
  v?: string | null;
  /** "Would an 8-12-year-old brag about making this?" 0-2. */
  appeal?: number | null;
  /** A teacher might object to it being projected in class. */
  teacher?: boolean | null;
  /** Up to 2 other names a kid would use for the same thing. */
  synonyms?: string[] | null;
  at?: string | null;
}

export interface PoolElement {
  id: string;
  name: string;
  isStarter: boolean;
  /** scripts/classify-recognizable.ts verdict; null/undefined = not classified yet. */
  recognizable?: boolean | null;
  /** elements.depth; undefined = not loaded. */
  depth?: number | null;
  /** elements.image_status. */
  imageStatus?: string | null;
  /** Current (fresh) steps; undefined = not loaded, null = unknown. */
  steps?: number | null;
  emoji?: string | null;
  notable?: boolean;
  tags?: ChallengeTags | null;
}

/** Numeric-string id order (shorter first, then lexicographic), the tie-break everywhere. */
export const cmpId = (a: string, b: string) => a.length - b.length || (a < b ? -1 : a > b ? 1 : 0);

const dayNumber = (day: string) => Math.round(Date.parse(`${day}T00:00:00Z`) / 86_400_000);

export function dayRange(from: string, count: number): string[] {
  return Array.from({ length: count }, (_, i) => addDays(from, i));
}

/**
 * BFS tiers over the ACTIVE world: 2-ingredient recipes (self-pairs included) whose result and
 * ingredients are all active, from the starters. pred-v6 only uses it for solvability (C2: has a
 * tier); `eligibleAt(level)` (non-starters at that tier whose name passes checkName) feeds
 * scripts/classify-recognizable.ts --tiers.
 */
export function analyzeWorld(elements: readonly PoolElement[], recipes: readonly GraphRecipe[]) {
  const active = new Map(elements.map((e) => [e.id, e]));
  const pairs = recipes.filter((r) => r.ingredients.length === 2 && active.has(r.result) && r.ingredients.every((i) => active.has(i)));
  const starters = elements.filter((e) => e.isStarter).map((e) => e.id);
  const tiers = bfsTiers(starters, pairs);
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
  return { active, pairs, tiers, tierSizes: new Map([...tierSizes].sort((a, b) => a[0] - b[0])), eligibleAt };
}

// ---------------------------------------------------------------- context and features

export interface WorldInput {
  /** ACTIVE elements, `steps` = current fresh steps (scripts/lib/world.ts withFreshSteps). */
  elements: readonly PoolElement[];
  /** Active 2-ingredient recipes (more are ignored). */
  recipes: readonly GraphRecipe[];
  /**
   * Active recipes of every arity (the graph `steps` was computed on), for C5b's safe steps.
   * Default: `recipes`.
   */
  allRecipes?: readonly GraphRecipe[];
  reach: Reach;
}

/**
 * What every intermediate of a C5b route must pass: the categorized safety lists (schoolSafety on
 * the name, EMOJI_DENY on the emoji). CHALLENGE_DENY and the teacher flag are judgments about a
 * name as the day's headline (Child, Jedi, Marriage), not about making it along the way.
 */
export const routeSafe = (e: Pick<PoolElement, "name" | "emoji">): boolean => schoolSafety(e.name).ok && emojiSafety(e.emoji).ok;

/**
 * C5b: steps from the starters over the active recipes (`all`), and over the recipes whose
 * ingredients and result are all routeSafe (`safe`; Knuth fixpoint, the same metric as
 * elements.steps). Comparing the two on one graph keeps stale stored steps out of the rule.
 */
export function pathStepsOf(elements: readonly PoolElement[], recipes: readonly GraphRecipe[]): { all: Map<string, number>; safe: Map<string, number> } {
  const active = new Set(elements.map((e) => e.id));
  const live = recipes.filter((r) => active.has(r.result) && r.ingredients.every((i) => active.has(i)));
  const safeIds = new Set(elements.filter((e) => e.isStarter || routeSafe(e)).map((e) => e.id));
  const starters = elements.filter((e) => e.isStarter).map((e) => e.id);
  return {
    all: knuthFixpoint(starters, live, stepsOf).value,
    safe: knuthFixpoint(
      starters,
      live.filter((r) => safeIds.has(r.result) && r.ingredients.every((i) => safeIds.has(i))),
      stepsOf,
    ).value,
  };
}

export interface ReachInfo {
  mode: ReachMode;
  asOf: string;
  cohortN: number;
  cohortN7: number;
  r7Offset?: number;
}

export interface Ctx {
  byId: ReadonlyMap<string, PoolElement>;
  /** C2: reachable from the starters over active 2-ingredient recipes. */
  solvable(id: string): boolean;
  /** Selection reach (r1 measure, or the bridged reach7 when REACH7_OFFSET is set); starters 1. */
  reach(id: string): number;
  reach7(id: string): number;
  /** Raw share of the cohort owning it (no window correction): the fresh-completion offset. */
  ownedShare(id: string): number;
  /** C5b: steps over every active recipe, and over routeSafe elements only (null = no route). */
  pathSteps(id: string): { all: number | null; safe: number | null };
  twins: TwinIndex;
  nearNames: NearNameIndex;
  aha: ReadonlyMap<string, AhaFeatures>;
  link(a: string, b: string): boolean;
  reachInfo: ReachInfo;
}

export function makeContext(w: WorldInput): Ctx {
  const { active, pairs, tiers } = analyzeWorld(w.elements, w.recipes);
  const starter = (id: string) => active.get(id)?.isStarter === true;
  const r7 = (id: string) => (starter(id) ? 1 : reachOf(w.reach.reach7, id));
  const reach =
    REACH7_OFFSET === null
      ? (id: string) => (starter(id) ? 1 : reachOf(w.reach.reach, id))
      : (id: string) => Math.min(1, Math.exp(REACH7_OFFSET!) * r7(id));
  const steps = new Map(w.elements.map((e) => [e.id, e.steps ?? null]));
  const paths = pathStepsOf(w.elements, w.allRecipes ?? w.recipes);
  return {
    byId: active,
    solvable: (id) => tiers.has(id),
    reach,
    reach7: r7,
    ownedShare: (id) => (w.reach.cohortN > 0 ? (w.reach.owners.get(id) ?? 0) / w.reach.cohortN : 0),
    pathSteps: (id) => ({ all: paths.all.get(id) ?? null, safe: paths.safe.get(id) ?? null }),
    twins: new TwinIndex(w.elements),
    nearNames: new NearNameIndex(w.elements, reach),
    aha: computeAha(w.elements, pairs, steps),
    link: directLinks(pairs),
    reachInfo: {
      mode: REACH7_OFFSET === null ? "r1" : "r7",
      asOf: w.reach.asOf,
      cohortN: w.reach.cohortN,
      cohortN7: w.reach.cohortN7,
      ...(REACH7_OFFSET === null ? {} : { r7Offset: REACH7_OFFSET }),
    },
  };
}

/** Everything the pools, picker, meta and checks need about one element. */
export interface Features {
  id: string;
  name: string;
  emoji: string | null;
  steps: number | null;
  depth: number | null;
  reach: number;
  reach7: number;
  art: string;
  notable: boolean;
  words: ReadonlySet<string>;
  nearOpt: number;
  nameLink: boolean;
  emojiLink: boolean;
  aha: number;
  abstract: boolean;
  appeal: 0 | 1 | 2 | null;
  seasonal: boolean;
  /** C7. */
  easyOk: boolean;
  /** C7 soft deny (EASY_SOFT_DENY_NAMES). */
  easySoftDenied: boolean;
  /** C9 (hard/expert): the synonym element that traps it, if any. */
  synonymTrap: string | null;
  /** C8b: the most widely made spelling twin, if any. */
  twin: { id: string; reach: number } | null;
  /** C12 (hard/expert): the containing name that traps it, if any. */
  nearNameTrap: string | null;
  /** C12 aha floor: >= AHA_FLOOR_NEAR_OPT near-optimal recipes, or a name or emoji link. */
  ahaOk: boolean;
  /** C5b: steps over route-safe elements only (null = no safe route). */
  safeSteps: number | null;
  /** C10: a hazard or disease emoji (kept off named holidays). */
  gloomy: boolean;
  /** School-basis (COEF_SELECT) logit and p per tier. */
  lg: Record<Tier, number>;
  p: Record<Tier, number>;
}

const appealOf = (t: ChallengeTags | null | undefined): 0 | 1 | 2 | null => {
  const a = t?.appeal;
  return a === 0 || a === 1 || a === 2 ? a : null;
};

export function featuresOf(ctx: Ctx, id: string): Features | null {
  const e = ctx.byId.get(id);
  if (!e) return null;
  const reach = ctx.reach(id);
  const steps = e.steps ?? null;
  const aha = ctx.aha.get(id) ?? { nearOpt: 0, nameLink: false, emojiLink: false, aha: 0 };
  const lg = {} as Record<Tier, number>;
  const p = {} as Record<Tier, number>;
  for (const t of TIERS) {
    lg[t] = predictLogit(COEF_SELECT, t, reach, steps ?? Number.POSITIVE_INFINITY);
    p[t] = sigmoid(lg[t]);
  }
  return {
    id,
    name: e.name,
    emoji: e.emoji ?? null,
    steps,
    depth: e.depth ?? null,
    reach,
    reach7: ctx.reach7(id),
    art: e.imageStatus ?? "none",
    notable: e.notable === true,
    words: nameWords(e.name),
    ...aha,
    abstract: isAbstract(e.name),
    appeal: appealOf(e.tags),
    seasonal: seasonalRule(e.name) !== null,
    easyOk: !EASY_DENY.has(foldKey(nameKey(e.name))),
    easySoftDenied: EASY_SOFT_DENY.has(foldKey(nameKey(e.name))),
    synonymTrap: synonymTrap(id, e.tags?.synonyms, ctx.twins, ctx.reach),
    twin: topTwin(e, ctx.twins, ctx.reach),
    nearNameTrap: nearNameTrap(id, e.name, ctx.nearNames, ctx.reach),
    ahaOk: aha.nearOpt >= AHA_FLOOR_NEAR_OPT || aha.nameLink || aha.emojiLink,
    safeSteps: ctx.pathSteps(id).safe,
    gloomy: e.emoji != null && HOLIDAY_GLOOM_EMOJI.has(emojiKey(e.emoji)),
    lg,
    p,
  };
}

/** C8b: the per-tier twin rule (null = ok, else why). */
export function twinNear(c: Pick<Features, "reach" | "twin">, tier: Tier): string | null {
  if (!c.twin) return null;
  const share = c.reach > 0 ? c.twin.reach / c.reach : Number.POSITIVE_INFINITY;
  if (tier === "easy" ? share >= TWIN_SHARE.easy || c.twin.reach >= EASY_TWIN_ABS : share >= TWIN_SHARE.upper) {
    return `twin reach ${fmtPct(c.twin.reach)} = ${(100 * share).toFixed(0)}% of ${fmtPct(c.reach)}`;
  }
  return null;
}

// ---------------------------------------------------------------- hard constraints

export type HardFailure =
  | "inactive"
  | "starter"
  | "bad-name"
  | "demo"
  | "unreachable"
  | "not-recognizable"
  | "art-blocked"
  | "unsafe"
  | "unsafe-path"
  | "challenge-deny"
  | "twin-trap"
  | "no-emoji"
  | "no-steps";

/** C1, C2, C4, C5, C5b, C8: what --apply-plan re-validates, and what a holdout target must pass. */
export const APPLY_CHECKS: ReadonlySet<HardFailure> = new Set<HardFailure>([
  "inactive",
  "starter",
  "bad-name",
  "demo",
  "unreachable",
  "art-blocked",
  "unsafe",
  "unsafe-path",
  "challenge-deny",
  "twin-trap",
]);

const DEMO_KEY = foldKey(nameKey(DEMO_RECIPE.result));

/** Tier-independent constraint failures of `id` (first failure per constraint). An inactive id gets only "inactive". */
export function hardFailures(ctx: Ctx, id: string): { code: HardFailure; detail: string }[] {
  const e = ctx.byId.get(id);
  if (!e) return [{ code: "inactive", detail: "not an active element" }];
  const out: { code: HardFailure; detail: string }[] = [];
  if (e.isStarter) out.push({ code: "starter", detail: "starter" });
  if (!checkName(e.name).ok) out.push({ code: "bad-name", detail: "fails checkName" });
  if (foldKey(nameKey(e.name)) === DEMO_KEY) out.push({ code: "demo", detail: "the onboarding demo result" });
  if (!ctx.solvable(id)) out.push({ code: "unreachable", detail: "no path from the starters over active 2-ingredient recipes" });
  if (e.recognizable !== true) out.push({ code: "not-recognizable", detail: `recognizable=${e.recognizable ?? null}` });
  if (e.imageStatus === "blocked") out.push({ code: "art-blocked", detail: "image_status blocked" });
  const safety = schoolSafety(e.name);
  const emoji = emojiSafety(e.emoji);
  if (!safety.ok) out.push({ code: "unsafe", detail: `${safety.category}: "${safety.match}"` });
  else if (!emoji.ok) out.push({ code: "unsafe", detail: `${emoji.category}: emoji ${emoji.match}` });
  if (isChallengeDenied(e.name)) out.push({ code: "challenge-deny", detail: "in CHALLENGE_DENY" });
  else if (e.tags?.teacher === true) out.push({ code: "challenge-deny", detail: "classifier teacher flag" });
  // C5b: only meaningful for a safe target (an unsafe one already fails above).
  if (safety.ok && emoji.ok && !e.isStarter) {
    const { all, safe } = ctx.pathSteps(id);
    if (all !== null && (safe === null || safe > all + SAFE_PATH_SLACK)) {
      out.push({ code: "unsafe-path", detail: safe === null ? `every route goes through a denied element (${all} step(s))` : `${safe} step(s) avoiding denied elements vs ${all}` });
    }
  }
  const twin = isTwinTrap(e, ctx.twins, ctx.reach);
  if (twin) out.push({ code: "twin-trap", detail: `twin "${ctx.byId.get(twin)?.name ?? twin}" reach ${fmtPct(ctx.reach(twin))} >= ${fmtPct(ctx.reach(id))}` });
  if (!e.emoji) out.push({ code: "no-emoji", detail: "no emoji (the tile would show the fallback)" });
  if (e.steps == null) out.push({ code: "no-steps", detail: "steps unknown" });
  return out;
}

const fmtPct = (x: number) => `${(100 * x).toFixed(2)}%`;

export interface CandidateDrops {
  /** Elements in the candidate universe (active, non-starter, solvable, steps 1-14, recognizable, art not blocked, name ok, has an emoji). */
  universe: number;
  unsafe: number;
  /** C5b: safe name, but every short route goes through a denied element. */
  unsafePath: number;
  challengeDeny: number;
  twinTrap: number;
  /** Not-yet-classified elements with steps 1-14 (would enter after a classifier run). */
  unclassified: number;
  notRecognizable: number;
}

/**
 * Candidates: active elements passing C1-C5 and C8 with steps 1..MAX_CANDIDATE_STEPS, plus their
 * features. `review` lists, for the human read, recognizable in-range names left out by the
 * teacher flag and candidates with a COMPOUND_STEMS word (scripts/lib/schoolSafety.ts).
 */
export function buildCandidates(ctx: Ctx): { cands: Map<string, Features>; drops: CandidateDrops } {
  const cands = new Map<string, Features>();
  const drops: CandidateDrops = { universe: 0, unsafe: 0, unsafePath: 0, challengeDeny: 0, twinTrap: 0, unclassified: 0, notRecognizable: 0 };
  for (const id of [...ctx.byId.keys()].sort(cmpId)) {
    const e = ctx.byId.get(id)!;
    if (e.steps == null || e.steps < 1 || e.steps > MAX_CANDIDATE_STEPS) continue;
    const fails = new Set(hardFailures(ctx, id).map((f) => f.code));
    if (fails.has("starter") || fails.has("bad-name") || fails.has("demo") || fails.has("unreachable") || fails.has("art-blocked") || fails.has("no-emoji")) continue;
    if (fails.has("not-recognizable")) {
      if (e.recognizable == null) drops.unclassified++;
      else drops.notRecognizable++;
      continue;
    }
    drops.universe++;
    if (fails.has("unsafe")) drops.unsafe++;
    else if (fails.has("unsafe-path")) drops.unsafePath++;
    else if (fails.has("challenge-deny")) drops.challengeDeny++;
    else if (fails.has("twin-trap")) drops.twinTrap++;
    else cands.set(id, featuresOf(ctx, id)!);
  }
  return { cands, drops };
}

// ---------------------------------------------------------------- pools

export interface BandPool {
  kind: Tier | "explore";
  /** Member ids, sorted with cmpId. */
  ids: string[];
  band: Band;
  /** Effective lower bound after widening (school basis). */
  lo: number;
  hi: number;
  widened: number;
  atFloor: boolean;
  /** Candidates inside the steps range before the p band (after disjointness). */
  base: number;
  /** Arm third per member from the frozen THIRD_CUTS on the school-basis p (empty when the pool has no thirds arm). */
  third: ReadonlyMap<string, Third>;
}

/** Upper-tier candidates the per-tier rules drop before the bands (each counted once, in this order). */
export interface UpperDrops {
  /** C9. */
  synonym: number;
  /** C8b at the hard/expert share. */
  twinNear: number;
  /** C12 near-name trap. */
  nearName: number;
  /** C12 aha floor. */
  ahaFloor: number;
  /** C4: art not ready. */
  artNotReady: number;
}

export interface DayPools {
  easy: BandPool;
  hard: BandPool;
  expert: BandPool;
  /** Weekday expert exploration pool; null on off days or when it cannot reach MIN_POOL.explore. */
  explore: BandPool | null;
  /**
   * Off-day expert appeal floor: applied, vacuous (no candidate has classifier tags yet, so it
   * removes nothing), dropped (it would leave < MIN_POOL), or n/a.
   */
  appealFloor: "applied" | "vacuous" | "dropped" | "n/a";
  /** C7 soft deny (EASY_SOFT_DENY_NAMES): applied, dropped (the easy pool would stay < MIN_POOL.easy), or n/a (none in range). */
  easySoftDeny: "applied" | "dropped" | "n/a";
  /** Hard/expert candidates dropped by the synonym trap (C9). */
  synonymDrops: number;
  upperDrops: UpperDrops;
  /** Easy candidates dropped by C8b at the easy share. */
  easyTwinDrops: number;
}

export type Pools = Record<DayType, DayPools>;

const DAY_TYPES: DayType[] = ["school", "mon", "off"];

function bandPool(
  kind: Tier | "explore",
  tier: Tier,
  base: readonly Features[],
  band: Band,
  min: number,
  floor: number,
  cuts: readonly [number, number] | null,
): BandPool {
  let lo = band.lo;
  let widened = 0;
  let members: Features[];
  for (;;) {
    members = base.filter((c) => c.p[tier] >= lo && c.p[tier] <= band.hi);
    if (members.length >= min || lo <= floor) break;
    lo = Math.max(floor, sigmoid(logit(lo) - WIDEN_STEP));
    widened++;
  }
  const third = new Map<string, Third>(cuts ? members.map((c) => [c.id, thirdOf(c.p[tier], cuts)]) : []);
  return { kind, ids: members.map((c) => c.id).sort(cmpId), band, lo, hi: band.hi, widened, atFloor: lo <= floor && members.length < min, base: base.length, third };
}

const inSteps = (c: Features, [a, b]: readonly [number, number]) => c.steps != null && c.steps >= a && c.steps <= b;

/** The first per-tier rule an upper-tier (hard/expert/explore) candidate fails, or null. */
export function upperFailure(c: Features): keyof UpperDrops | null {
  if (c.synonymTrap !== null) return "synonym";
  if (twinNear(c, "hard") !== null) return "twinNear";
  if (c.nearNameTrap !== null) return "nearName";
  if (!c.ahaOk) return "ahaFloor";
  if (c.art !== "ready") return "artNotReady";
  return null;
}

/** Whether an easy candidate passes the easy-only rules (C4 art ready, C7, C8b at the easy share). */
export const easyEligible = (c: Features): boolean => c.art === "ready" && c.easyOk && twinNear(c, "easy") === null;

/**
 * Pools per day type (§4.2): easy, hard, expert in tier order, each disjoint from the tiers before
 * it (easy-capable elements never enter hard/expert/explore), widened down to their floors, plus
 * the weekday explore pool. Throws when a tier is empty at its floor (never falls back to
 * unclassified names).
 */
export function buildPools(cands: ReadonlyMap<string, Features>): { pools: Pools; warnings: string[] } {
  const all = [...cands.values()];
  const warnings: string[] = [];
  const easyCapable = new Set(all.filter((c) => c.steps != null && c.steps <= 3 && c.art === "ready" && c.p.easy >= EASY_CAPABLE_P).map((c) => c.id));
  const upperDrops: UpperDrops = { synonym: 0, twinNear: 0, nearName: 0, ahaFloor: 0, artNotReady: 0 };
  const upper: Features[] = [];
  for (const c of all) {
    if (easyCapable.has(c.id)) continue;
    const f = upperFailure(c);
    if (f) upperDrops[f]++;
    else upper.push(c);
  }
  const pools = {} as Pools;
  for (const dt of DAY_TYPES) {
    const bands = BANDS[dt];
    const floors = BAND_FLOOR[dt];
    const cuts = THIRD_CUTS[dt];
    const easyRange = all.filter((c) => inSteps(c, bands.easy.steps));
    const easyTwinDrops = easyRange.filter((c) => c.art === "ready" && c.easyOk && twinNear(c, "easy") !== null).length;
    const easyBase = easyRange.filter(easyEligible);
    let easy = bandPool("easy", "easy", easyBase.filter((c) => !c.easySoftDenied), bands.easy, MIN_POOL.easy, floors.easy, null);
    let easySoftDeny: DayPools["easySoftDeny"] = "applied";
    if (!easyBase.some((c) => c.easySoftDenied)) easySoftDeny = "n/a";
    else if (easy.ids.length < MIN_POOL.easy) {
      easySoftDeny = "dropped";
      easy = bandPool("easy", "easy", easyBase, bands.easy, MIN_POOL.easy, floors.easy, null);
    }
    const hard = bandPool("hard", "hard", upper.filter((c) => inSteps(c, bands.hard.steps)), bands.hard, MIN_POOL.hard, floors.hard, cuts.hard);
    const inHard = new Set(hard.ids);
    let expertBase = upper.filter((c) => !inHard.has(c.id) && inSteps(c, bands.expert.steps));
    let appealFloor: DayPools["appealFloor"] = "n/a";
    if (dt === "off") {
      if (!expertBase.some((c) => c.appeal !== null)) appealFloor = "vacuous";
      else {
        const floored = expertBase.filter((c) => (c.appeal ?? 1) >= 1);
        const inBand = floored.filter((c) => c.p.expert >= floors.expert && c.p.expert <= bands.expert.hi).length;
        if (inBand >= MIN_POOL.expert) {
          appealFloor = "applied";
          expertBase = floored;
        } else {
          appealFloor = "dropped";
          warnings.push(`off: the expert appeal floor would leave ${inBand} < ${MIN_POOL.expert} candidates at the floor; dropped for this run`);
        }
      }
    }
    const expert = bandPool("expert", "expert", expertBase, bands.expert, MIN_POOL.expert, floors.expert, cuts.expert);
    let explore: BandPool | null = null;
    if (dt !== "off") {
      const ex = bandPool("explore", "expert", upper.filter((c) => !inHard.has(c.id) && inSteps(c, EXPLORE_BAND.steps)), EXPLORE_BAND, 0, EXPLORE_BAND.lo, null);
      if (ex.ids.length >= MIN_POOL.explore) explore = ex;
      else warnings.push(`${dt}: the explore pool has ${ex.ids.length} < ${MIN_POOL.explore} candidates; the explore arm is skipped this run`);
    }
    for (const [t, p] of [["easy", easy], ["hard", hard], ["expert", expert]] as const) {
      if (p.ids.length === 0) throw new Error(`${dt} ${t} pool is empty at its floor (${p.lo.toFixed(3)}); classify more names (npm run db:classify)`);
      if (p.atFloor) warnings.push(`${dt} ${t}: ${p.ids.length} < ${MIN_POOL[t]} candidates even at the floor ${p.lo.toFixed(3)}`);
      else if (p.widened > 0) warnings.push(`${dt} ${t}: widened ${p.widened} step(s) to lo ${p.lo.toFixed(3)} to reach ${MIN_POOL[t]} candidates`);
    }
    if (easySoftDeny === "dropped") warnings.push(`${dt} easy: EASY_SOFT_DENY (${EASY_SOFT_DENY_NAMES.join(", ")}) kept: without them the pool stays below ${MIN_POOL.easy}`);
    for (const [t, p] of [["hard", hard], ["expert", expert]] as const) {
      if (!cuts[t] || !p.ids.length) continue;
      const n = [0, 1, 2].map((k) => p.ids.filter((id) => p.third.get(id) === k).length);
      if (Math.min(...n) < p.ids.length / 6) warnings.push(`${dt} ${t}: THIRD_CUTS slices are unbalanced (${n.join(" / ")}); re-derive them with the bands`);
    }
    pools[dt] = { easy, hard, expert, explore, appealFloor, easySoftDeny, synonymDrops: upperDrops.synonym, upperDrops, easyTwinDrops };
  }
  return { pools, warnings };
}

// ---------------------------------------------------------------- planning

export interface TierMeta {
  id: string;
  /** School-basis COEF_SELECT p (bands, p-order). */
  p: number;
  /** Day-basis COEF_EXPECT p (expectations, O/E). */
  pExp: number;
  lo: number;
  hi: number;
  widened: number;
  pool: number;
  bag: number;
  reach: number;
  reach7: number;
  steps: number | null;
  depth: number | null;
  nearOpt: number;
  nameLink: boolean;
  emojiLink: boolean;
  aha: number;
  appeal: number | null;
  abstract: boolean;
  weight: number;
  art: string;
  notable: boolean;
  seasonal: boolean;
  /** Reach above the fitted p95 (hard 6.9%, expert 1.8%). */
  outOfSupport: boolean;
  ownedShareAtPick: number;
  fallback: string[];
}

export type HardArm = Third | "holdout";
export type ExpertArm = Third | "band" | "explore" | "holdout";

export interface DayMeta {
  v: 2;
  generator: string;
  model: string;
  configHash: string;
  gitSha: string;
  classifierVersion: string;
  pickedAt: string;
  planHash: string;
  /** Max recipe created_at seen. */
  worldAsOf: string;
  dayType: DayType;
  reach: ReachInfo;
  exp: {
    /** realized = at least one tier kept its pre-v6 target; tiers = which ones (hard/expert.realized say "holdout" too). */
    holdout: { assigned: boolean; realized: boolean; block: number | null; tiers?: { hard: boolean; expert: boolean } };
    hard: { assigned: HardArm; realized: HardArm | null; block: number };
    expert: { assigned: ExpertArm; realized: ExpertArm | null; block: number };
  };
  tiers: Record<Tier, TierMeta>;
  links: { easyInHard: boolean; hardInExpert: boolean };
  /** First entry = the pre-v6 row (kept forever), then the last 3 replacements. Written by --apply-plan. */
  replaced?: { generator: string | null; targets: DayTargets; reason: string; at: string }[];
}

export interface StoredRow {
  day: string;
  source: string;
  generator: string | null;
  targets: DayTargets;
  meta?: DayMeta | null;
}

export interface PlannedRow {
  day: string;
  targets: DayTargets;
  steps: Record<Tier, number | null>;
  meta: DayMeta;
}

export interface PlanProvenance {
  configHash: string;
  gitSha: string;
  classifierVersion: string;
  pickedAt: string;
  worldAsOf: string;
}

/** The targets a day had before pred-v6 (the holdout arm's targets): meta.replaced[0], else the row itself if it is not pred-v6. */
export function preV6Targets(row: StoredRow | undefined): DayTargets | null {
  if (!row) return null;
  const first = row.meta?.replaced?.find((r) => r.generator !== GENERATOR);
  if (first) return first.targets;
  return row.generator !== GENERATOR ? row.targets : null;
}

/** Day numbers each target is used on (stored rows outside the plan, plus picks so far), for the repeat rule. */
class Uses {
  private m = new Map<string, number[]>();
  add(id: string, n: number) {
    const a = this.m.get(id);
    if (!a) {
      this.m.set(id, [n]);
      return;
    }
    let i = a.length;
    while (i > 0 && a[i - 1]! > n) i--;
    a.splice(i, 0, n);
  }
  remove(id: string, n: number) {
    const a = this.m.get(id);
    const i = a?.indexOf(n) ?? -1;
    if (a && i >= 0) a.splice(i, 1);
  }
  /** Days to the nearest use other than day n itself (Infinity if none). */
  distance(id: string, n: number): number {
    const a = this.m.get(id);
    if (!a?.length) return Number.POSITIVE_INFINITY;
    let lo = 0;
    let hi = a.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (a[mid]! < n) lo = mid + 1;
      else hi = mid;
    }
    let hiIdx = lo;
    while (hiIdx < a.length && a[hiIdx] === n) hiIdx++;
    const before = lo > 0 ? n - a[lo - 1]! : Number.POSITIVE_INFINITY;
    const after = hiIdx < a.length ? a[hiIdx]! - n : Number.POSITIVE_INFINITY;
    return Math.min(before, after);
  }
}

const r5 = (x: number) => Number(x.toPrecision(5));
const r6 = (x: number) => Math.round(x * 1e6) / 1e6;

/** Lottery weight (§5 step 7). */
export function drawWeight(tier: Tier, c: Pick<Features, "aha" | "abstract" | "appeal">): number {
  if (tier === "easy") return 1;
  return Math.exp(AHA_SLOPE * Math.min(c.aha, AHA_CAP)) * (c.abstract ? ABSTRACT_WEIGHT : 1) * APPEAL_WEIGHT[tier][c.appeal ?? 1];
}

/** Efraimidis-Spirakis: argmin of -ln u / w, u from hash32(generator:day:tier:id); ties by id. */
export function stableDraw<T extends { id: string }>(day: string, tier: Tier, bag: readonly T[], weight: (c: T) => number): T {
  let best: T | null = null;
  let bestKey = Number.POSITIVE_INFINITY;
  for (const c of bag) {
    const key = -Math.log(u01(`${GENERATOR}:${day}:${tier}:${c.id}`)) / weight(c);
    if (best === null || key < bestKey || (key === bestKey && cmpId(c.id, best.id) < 0)) {
      best = c;
      bestKey = key;
    }
  }
  if (!best) throw new Error(`${day} ${tier}: empty bag`);
  return best;
}

export interface PlanResult {
  rows: PlannedRow[];
  /** Counts of "tier:fallback" over the plan. */
  fallbacks: Record<string, number>;
  warnings: string[];
}

/**
 * Pick every day in `days` (ascending; need not be contiguous). Stored rows on other days are
 * fixed neighbours: they count toward the 120-day repeat rule in both directions and the ±6-day
 * variety rule. A pure function of (ctx, cands, pools, stored rows, days, provenance). The explore
 * arm runs only on classified content (provenance.classifierVersion != "none"): before the
 * classifier, explore-assigned days take the band pool (fallback "explore-unclassified").
 */
export function planDays(
  ctx: Ctx,
  cands: ReadonlyMap<string, Features>,
  pools: Pools,
  { days, stored, provenance }: { days: readonly string[]; stored: readonly StoredRow[]; provenance: PlanProvenance },
): PlanResult {
  const planSet = new Set(days);
  if (planSet.size !== days.length) throw new Error("planDays: duplicate days");
  for (let i = 1; i < days.length; i++) if (days[i]! <= days[i - 1]!) throw new Error("planDays: days must be ascending");
  const storedByDay = new Map(stored.map((r) => [r.day, r]));
  const classified = provenance.classifierVersion !== "none";
  const uses = new Uses();
  // Variety features per day number: emojis and words of every target on that day.
  const variety = new Map<number, { emojis: Set<string>; words: Set<string> }>();
  const addVariety = (n: number, ids: readonly string[]) => {
    const v = variety.get(n) ?? { emojis: new Set<string>(), words: new Set<string>() };
    for (const id of ids) {
      const e = ctx.byId.get(id);
      if (!e) continue;
      if (e.emoji) v.emojis.add(e.emoji);
      for (const w of nameWords(e.name)) v.words.add(w);
    }
    variety.set(n, v);
  };
  for (const r of stored) {
    if (planSet.has(r.day)) continue;
    const n = dayNumber(r.day);
    for (const t of TIERS) uses.add(r.targets[t], n);
    addVariety(n, TIERS.map((t) => r.targets[t]));
  }

  // Holdout pre-pass, per tier: each valid pre-v6 hard/expert target becomes a fixed neighbour
  // before any pick. An invalid tier (unsafe, inactive, ...) takes a v6 pick on its own; the other
  // tier stays the holdout (analysis is by assigned arm, realized is logged per tier).
  const holdout = new Map<string, { hard: Features | null; expert: Features | null }>();
  const holdOk = (id: string) => !hardFailures(ctx, id).some((f) => APPLY_CHECKS.has(f.code) || f.code === "no-steps");
  for (const day of days) {
    if (!armFor(day).holdout.assigned) continue;
    const pre = preV6Targets(storedByDay.get(day));
    if (!pre) continue;
    const h = holdOk(pre.hard) ? featuresOf(ctx, pre.hard)! : null;
    let x = holdOk(pre.expert) && pre.expert !== pre.hard ? featuresOf(ctx, pre.expert)! : null;
    if (h && x && !(x.steps! > h.steps!)) x = null;
    if (!h && !x) continue;
    holdout.set(day, { hard: h, expert: x });
    const n = dayNumber(day);
    for (const f of [h, x]) if (f) uses.add(f.id, n);
    addVariety(n, [h, x].filter((f): f is Features => f !== null).map((f) => f.id));
  }

  const fallbacks: Record<string, number> = {};
  const warnings: string[] = [];
  const rows: PlannedRow[] = [];
  const bump = (k: string) => (fallbacks[k] = (fallbacks[k] ?? 0) + 1);
  for (const day of days) {
    const n = dayNumber(day);
    const dt = dayType(day);
    const off = dt === "off";
    const holiday = namedHoliday(day) !== null;
    const arms = armFor(day);
    const P = pools[dt];
    const nearEmojis = new Set<string>();
    const nearWords = new Set<string>();
    for (let k = n - VARIETY_DAYS; k <= n + VARIETY_DAYS; k++) {
      if (k === n) continue;
      const v = variety.get(k);
      if (!v) continue;
      for (const e of v.emojis) nearEmojis.add(e);
      for (const w of v.words) nearWords.add(w);
    }
    const chosen = {} as Record<Tier, Features>;
    const tierMeta = {} as Record<Tier, TierMeta>;
    const today = new Set<string>();
    let hardRealized: HardArm | null = null;
    let expertRealized: ExpertArm | null = null;
    // The holdout tiers still alive for this day (a tier drops out when its steps order fails).
    const hold = { ...(holdout.get(day) ?? { hard: null, expert: null }) };
    const held: Record<"hard" | "expert", boolean> = { hard: false, expert: false };
    const dropHold = (t: "hard" | "expert") => {
      if (!hold[t]) return;
      uses.remove(hold[t]!.id, n);
      hold[t] = null;
      bump(`${t}:holdout-invalid`);
    };

    const record = (tier: Tier, c: Features, pool: BandPool | null, bag: number, fb: string[], weight: number) => {
      chosen[tier] = c;
      today.add(c.id);
      for (const f of fb) bump(`${tier}:${f}`);
      const band = pool?.band ?? BANDS[dt][tier];
      tierMeta[tier] = {
        id: c.id,
        p: r5(c.p[tier]),
        pExp: r5(predict(COEF_EXPECT, tier, c.reach, c.steps ?? Number.POSITIVE_INFINITY, off)),
        lo: r5(pool?.lo ?? band.lo),
        hi: r5(pool?.hi ?? band.hi),
        widened: pool?.widened ?? 0,
        pool: pool?.ids.length ?? 0,
        bag,
        reach: r6(c.reach),
        reach7: r6(c.reach7),
        steps: c.steps,
        depth: c.depth,
        nearOpt: c.nearOpt,
        nameLink: c.nameLink,
        emojiLink: c.emojiLink,
        aha: r5(c.aha),
        appeal: c.appeal,
        abstract: c.abstract,
        weight: r5(weight),
        art: c.art,
        notable: c.notable,
        seasonal: c.seasonal,
        outOfSupport: c.reach > SUPPORT_REACH[tier],
        ownedShareAtPick: r6(ctx.ownedShare(c.id)),
        fallback: fb,
      };
    };

    for (const tier of TIERS) {
      const prevTier: Tier | null = tier === "easy" ? null : tier === "hard" ? "easy" : "hard";
      const prev = prevTier ? chosen[prevTier] : null;
      if (tier !== "easy") {
        const h = hold[tier];
        if (h && h.steps! > prev!.steps!) {
          record(tier, h, null, 0, ["holdout"], 1);
          held[tier] = true;
          if (tier === "hard") hardRealized = "holdout";
          else expertRealized = "holdout";
          continue;
        }
        dropHold(tier);
      }
      let pool: BandPool = P[tier];
      const fb: string[] = [];
      let exploreDay = false;
      // A holdout-assigned day's v6 expert (its pre-v6 expert was invalid) is a plain band pick.
      if (tier === "expert" && arms.expert.assigned === "explore" && !arms.holdout.assigned) {
        if (!classified) fb.push("explore-unclassified");
        else if (P.explore) {
          pool = P.explore;
          exploreDay = true;
        } else fb.push("explore-skipped");
      }
      // Ids reserved for this day's live holdout tiers never take another tier.
      const reserved = new Set([hold.hard?.id, hold.expert?.id].filter((id): id is string => id !== undefined));
      let open = pool.ids.map((id) => cands.get(id)!).filter((c) => !today.has(c.id) && !reserved.has(c.id) && inSeason(c.name, day, dt));
      if (open.length === 0) throw new Error(`${day} ${tier}: no in-season candidate left in the ${dt} ${pool.kind} pool`);
      if (holiday) {
        const cheerful = open.filter((c) => !c.gloomy);
        if (cheerful.length > 0) open = cheerful;
        else fb.push("holiday");
      }
      if (tier === "hard" && hold.expert) {
        // A v6 hard under a live holdout expert must stay below it in steps.
        const below = open.filter((c) => c.steps! < hold.expert!.steps!);
        if (below.length > 0) open = below;
        else dropHold("expert");
      }
      if (prev) {
        const gap = tier === "expert" && !off ? WEEKDAY_EXPERT_GAP : 1;
        let next = open.filter((c) => c.steps! >= prev.steps! + gap);
        if (next.length === 0 && gap > 1) {
          next = open.filter((c) => c.steps! > prev.steps!);
          fb.push("gap");
        }
        if (next.length > 0) open = next;
        else fb.push("tier-order");
        // p-order against a v6 tier below (a holdout tier below is exempt, like in checkDays).
        if (!(prevTier === "hard" && held.hard)) {
          const lower = open.filter((c) => c.p[tier] < prev.p[prevTier!]);
          if (lower.length > 0) open = lower;
          else fb.push("p-order");
        }
        const dom = open.filter((c) => c.reach <= prev.reach);
        if (dom.length > 0) open = dom;
        else fb.push("reach-order");
      }
      const dist = (c: Features) => uses.distance(c.id, n);
      let bag = open.filter((c) => dist(c) >= NO_REPEAT_DAYS);
      if (bag.length === 0) {
        const byDistance = [...open].sort((a, b) => {
          const da = dist(a);
          const db = dist(b);
          return da === db ? cmpId(a.id, b.id) : da > db ? -1 : 1;
        });
        bag = byDistance.slice(0, Math.max(1, Math.ceil(byDistance.length / 4)));
        fb.push("lru");
      }
      const noEmoji = bag.filter((c) => c.emoji === null || !nearEmojis.has(c.emoji));
      if (noEmoji.length > 0) bag = noEmoji;
      else fb.push("emoji");
      const noWord = bag.filter((c) => ![...c.words].some((w) => nearWords.has(w)));
      if (noWord.length > 0) bag = noWord;
      else fb.push("word");
      let realized: HardArm | ExpertArm | null = null;
      if (tier === "hard" || (tier === "expert" && off)) {
        const k = tier === "hard" ? arms.hard.third : (arms.expert.assigned as Third);
        const slice = bag.filter((c) => pool.third.get(c.id) === k);
        if (slice.length >= 3) {
          bag = slice;
          realized = k;
        } else fb.push("third");
      } else if (tier === "expert") realized = exploreDay ? "explore" : "band";
      const pick = stableDraw(day, tier, bag, (c) => drawWeight(tier, c));
      record(tier, pick, pool, bag.length, fb, drawWeight(tier, pick));
      if (tier === "hard") hardRealized = realized as HardArm | null;
      if (tier === "expert") expertRealized = realized as ExpertArm | null;
    }

    for (const t of TIERS) if (!(t !== "easy" && held[t])) uses.add(chosen[t].id, n);
    variety.delete(n); // drop the holdout pre-pass entry: this day's picks are final now
    addVariety(n, TIERS.map((t) => chosen[t].id));
    const holdoutAssigned = arms.holdout.assigned;
    const pre = holdout.get(day);
    if (holdoutAssigned && !pre) warnings.push(`${day}: holdout assigned but no valid pre-v6 hard/expert targets; v6 picks instead`);
    else if (holdoutAssigned) {
      for (const t of ["hard", "expert"] as const) if (!held[t]) warnings.push(`${day}: holdout ${t} not realized (${pre![t] ? "steps order" : "pre-v6 target invalid"}); v6 ${t} instead`);
    }
    rows.push({
      day,
      targets: { easy: chosen.easy.id, hard: chosen.hard.id, expert: chosen.expert.id },
      steps: { easy: chosen.easy.steps, hard: chosen.hard.steps, expert: chosen.expert.steps },
      meta: {
        v: 2,
        generator: GENERATOR,
        model: MODEL_VERSION,
        configHash: provenance.configHash,
        gitSha: provenance.gitSha,
        classifierVersion: provenance.classifierVersion,
        pickedAt: provenance.pickedAt,
        planHash: "",
        worldAsOf: provenance.worldAsOf,
        dayType: dt,
        reach: ctx.reachInfo,
        exp: {
          holdout: { assigned: holdoutAssigned, realized: held.hard || held.expert, block: arms.holdout.block, tiers: { ...held } },
          hard: { assigned: holdoutAssigned ? "holdout" : arms.hard.third, realized: hardRealized, block: arms.hard.block },
          expert: { assigned: holdoutAssigned ? "holdout" : arms.expert.assigned, realized: expertRealized, block: arms.expert.block },
        },
        tiers: tierMeta,
        links: { easyInHard: ctx.link(chosen.easy.id, chosen.hard.id), hardInExpert: ctx.link(chosen.hard.id, chosen.expert.id) },
      },
    });
  }
  const unclassified = rows.filter((r) => r.meta.tiers.expert.fallback.includes("explore-unclassified")).length;
  if (unclassified) warnings.push(`${unclassified} explore-assigned day(s) took the band pool: the explore arm waits for classifier tags (spec G1)`);
  return { rows, fallbacks, warnings };
}

// ---------------------------------------------------------------- the frozen window

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

// ---------------------------------------------------------------- checking stored days (§9.3)

export type Problem =
  | "inactive"
  | "unreachable"
  | "unsafe"
  | "unsafe-path"
  | "art-blocked"
  | "tier-order"
  | "challenge-deny"
  | "twin-trap"
  | "not-recognizable"
  | "out-of-season"
  | "p-order"
  | "p-low"
  | "p-high"
  | "p-drift"
  | "reach-order"
  | "gap"
  | "steps-range"
  | "art-not-ready"
  | "appeal-low"
  | "twin-near"
  | "near-name";

export type Severity = "broken" | "warning" | "report";

/** Problems that make a day worth re-picking (check-challenges --fix) on a pred-v6 row. */
export const BROKEN_PROBLEMS: ReadonlySet<Problem> = new Set<Problem>([
  "inactive",
  "unreachable",
  "unsafe",
  "unsafe-path",
  "art-blocked",
  "tier-order",
  "challenge-deny",
  "twin-trap",
  "not-recognizable",
  "out-of-season",
  "p-order",
]);
/** Broken on every row, including pre-v6 rows and holdout tiers. */
const ALWAYS_BROKEN: ReadonlySet<Problem> = new Set<Problem>(["inactive", "unreachable", "unsafe", "unsafe-path", "art-blocked", "challenge-deny", "twin-trap"]);
/** Problems a planner fallback can leave on a day (recorded in meta.tiers[t].fallback): a warning then, so --fix does not loop. */
const FALLBACK_PROBLEMS: ReadonlySet<Problem> = new Set<Problem>(["tier-order", "p-order"]);
/** Broken on pre-v6 rows too (as under bfs-v4), except on holdout tiers. */
const LEGACY_BROKEN: ReadonlySet<Problem> = new Set<Problem>([...ALWAYS_BROKEN, "tier-order"]);
export const REPORT_ONLY: ReadonlySet<Problem> = new Set<Problem>(["p-low", "p-high"]);
export const P_MARGIN = 0.5;
export const ART_READY_DAYS: Record<Tier, number> = { easy: 3, hard: 7, expert: 7 };

export interface Issue {
  day: string;
  tier: Tier;
  id: string;
  problem: Problem;
  severity: Severity;
  detail: string;
}

/**
 * Everything wrong with stored days under the pred-v6 rules, in the current world. pred-v6 rows
 * get every check; pre-v6 rows (bfs-v3/v4, frozen days) count only LEGACY_BROKEN as broken; holdout
 * tiers (meta.exp[tier].realized "holdout") only ALWAYS_BROKEN, and so do the order checks of a
 * pair with a holdout tier. A tier-order or p-order the planner recorded as its own fallback
 * (meta.tiers[t].fallback) is a warning: a re-pick would land on the same day again. An inactive
 * target gets no further checks. `today` (UTC) sets the art-not-ready horizon.
 */
export function checkDays(rows: readonly StoredRow[], ctx: Ctx, { today }: { today: string }): Issue[] {
  const issues: Issue[] = [];
  for (const r of rows) {
    const v6 = r.generator === GENERATOR;
    const exp = r.meta?.exp;
    const holdoutTier = (tier: Tier) =>
      v6 && tier !== "easy" && (exp?.[tier]?.realized === "holdout" || (exp?.holdout?.realized === true && !exp.holdout.tiers && exp?.[tier]?.realized == null));
    const dt = dayType(r.day);
    const exploreDay = exp?.expert?.realized === "explore";
    const severity = (tier: Tier, problem: Problem, pairedWithHoldout = false): Severity => {
      if (REPORT_ONLY.has(problem)) return "report";
      if (holdoutTier(tier) || pairedWithHoldout) return ALWAYS_BROKEN.has(problem) ? "broken" : "warning";
      if (!v6) return LEGACY_BROKEN.has(problem) ? "broken" : "warning";
      const m = r.meta?.tiers?.[tier];
      if (FALLBACK_PROBLEMS.has(problem) && m && m.id === r.targets[tier] && m.fallback?.includes(problem)) return "warning";
      return BROKEN_PROBLEMS.has(problem) ? "broken" : "warning";
    };
    const feats = {} as Record<Tier, Features | null>;
    for (const tier of TIERS) {
      const id = r.targets[tier];
      const add = (problem: Problem, detail: string) => issues.push({ day: r.day, tier, id, problem, severity: severity(tier, problem), detail });
      const f = featuresOf(ctx, id);
      feats[tier] = f;
      if (!f) {
        add("inactive", "not an active element");
        continue;
      }
      for (const h of hardFailures(ctx, id)) {
        if (h.code === "unreachable") add("unreachable", h.detail);
        else if (h.code === "unsafe") add("unsafe", h.detail);
        else if (h.code === "unsafe-path") add("unsafe-path", h.detail);
        else if (h.code === "art-blocked") add("art-blocked", h.detail);
        else if (h.code === "challenge-deny") add("challenge-deny", h.detail);
        else if (h.code === "twin-trap") add("twin-trap", h.detail);
        else if (h.code === "not-recognizable") add("not-recognizable", h.detail);
      }
      if (!inSeason(f.name, r.day, dt)) add("out-of-season", `seasonal name on ${r.day} (${dt})`);
      const band = tier === "expert" && exploreDay ? EXPLORE_BAND : BANDS[dt][tier];
      const m = r.meta?.tiers?.[tier];
      const lo = m && m.id === id ? m.lo : band.lo;
      const hi = m && m.id === id ? m.hi : band.hi;
      if (f.lg[tier] < logit(lo) - P_MARGIN) add("p-low", `p ${fmtPct(f.p[tier])} below ${fmtPct(lo)} by > ${P_MARGIN} logit`);
      if (hi < 1 && f.lg[tier] > logit(hi) + P_MARGIN) add("p-high", `p ${fmtPct(f.p[tier])} above ${fmtPct(hi)} by > ${P_MARGIN} logit`);
      if (m && m.id === id && m.p > 0 && m.p < 1 && Math.abs(f.lg[tier] - logit(m.p)) > P_MARGIN) {
        add("p-drift", `p ${fmtPct(f.p[tier])} now vs ${fmtPct(m.p)} at pick`);
      }
      if (f.steps != null && (f.steps < band.steps[0] || f.steps > band.steps[1])) add("steps-range", `${f.steps} step(s), range ${band.steps.join("-")}`);
      if (f.art !== "ready" && f.art !== "blocked" && r.day <= addDays(today, ART_READY_DAYS[tier])) add("art-not-ready", `image_status ${f.art}`);
      if (tier === "expert" && dt === "off" && f.appeal === 0) add("appeal-low", "off-day expert with appeal 0");
      const twin = twinNear(f, tier);
      if (twin) add("twin-near", `${twin} ("${ctx.byId.get(f.twin!.id)?.name ?? f.twin!.id}")`);
      if (tier !== "easy" && f.nearNameTrap) add("near-name", `"${ctx.byId.get(f.nearNameTrap)?.name ?? f.nearNameTrap}" reach ${fmtPct(ctx.reach(f.nearNameTrap))} vs ${fmtPct(f.reach)}`);
    }
    for (const [lower, upper] of [["easy", "hard"], ["hard", "expert"]] as const) {
      const a = feats[lower];
      const b = feats[upper];
      if (!a || !b) continue;
      const paired = holdoutTier(lower);
      const add = (problem: Problem, detail: string) => issues.push({ day: r.day, tier: upper, id: b.id, problem, severity: severity(upper, problem, paired), detail });
      if (a.steps != null && b.steps != null && b.steps <= a.steps) add("tier-order", `${upper} ${b.steps} step(s) <= ${lower} ${a.steps}`);
      if (!(b.p[upper] < a.p[lower])) add("p-order", `${upper} p ${fmtPct(b.p[upper])} >= ${lower} p ${fmtPct(a.p[lower])} (school basis)`);
      if (b.reach > a.reach) add("reach-order", `${upper} reach ${fmtPct(b.reach)} > ${lower} ${fmtPct(a.reach)}`);
      if (upper === "expert" && dt !== "off" && a.steps != null && b.steps != null && b.steps > a.steps && b.steps < a.steps + WEEKDAY_EXPERT_GAP) {
        add("gap", `weekday expert ${b.steps} step(s) < hard ${a.steps} + ${WEEKDAY_EXPERT_GAP}`);
      }
    }
  }
  return issues;
}

/** Days with at least one broken issue, ascending. */
export const brokenDays = (issues: readonly Issue[]): string[] => [...new Set(issues.filter((i) => i.severity === "broken").map((i) => i.day))].sort();
