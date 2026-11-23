// Daily-challenge difficulty model and calendar (generator "pred-v6"; pure, no I/O).
//
// Each tier's target is picked by PREDICTED COMPLETION: the share of the day's combining players
// expected to make it, from a frozen two-input logistic model of reach (scripts/lib/reach.ts:
// the share of recent players who made the element on their own) and steps (elements.steps, the
// minimum number of combinations):
//
//   logit p = a + b·ln R + c·ln S (+ w on off days, for expectations only)
//
// Two bases:
//   - school basis (off = false, COEF_SELECT): every band, comparison, tertile and check.
//   - day basis (off = dayType(day) === "off", COEF_EXPECT): the logged expectation (meta pExp)
//     and observed/expected reports.
// COEF_SELECT changes only by a reviewed PR after a readout (and then MODEL_VERSION is bumped and
// the bands re-derived); COEF_EXPECT takes intercept-only refits and never moves pools.
import type { Tier } from "../../src/shared/api.ts";
import { addDays } from "../../src/shared/dates.ts";

export const MODEL_VERSION = "r1-fresh-2026-11-23";

export interface Coef {
  a: number;
  b: number;
  c: number;
  /** Off-day (weekend/holiday) term, expectation basis only. */
  w: number;
}

/** R1 joint fit (v2 + legacy days), lreach + lsteps_now (fresh steps, matching deployment). FROZEN. */
export const COEF_SELECT: Readonly<Record<Tier, Readonly<Coef>>> = {
  easy: { a: 0.298, b: 0.85, c: -0.02, w: 0.351 },
  hard: { a: -0.834, b: 0.399, c: -0.342, w: 0.718 },
  expert: { a: -1.4, b: 0.184, c: -0.711, w: 1.551 },
};

/** Intercept-only refits land here (monthly, by PR); used for meta.pExp and O/E only. */
export const COEF_EXPECT: Readonly<Record<Tier, Readonly<Coef>>> = COEF_SELECT;

export const REACH_FLOOR = 4e-4;
export const STEPS_CLIP = [1, 40] as const;

/**
 * Fixed-tenure reach bridge (spec §2.3, P1): when set, selection uses R = exp(alpha) · reach7.
 * null = selection uses the r1 measure (the one COEF_SELECT was fitted on).
 */
export const REACH7_OFFSET: number | null = null;

export const sigmoid = (x: number) => 1 / (1 + Math.exp(-x));
export const logit = (p: number) => Math.log(p / (1 - p));

export function predictLogit(coef: Readonly<Record<Tier, Readonly<Coef>>>, tier: Tier, reach: number, steps: number, off = false): number {
  const { a, b, c, w } = coef[tier];
  const r = Math.min(1, Math.max(REACH_FLOOR, Number.isFinite(reach) ? reach : 0));
  const s = Math.min(STEPS_CLIP[1], Math.max(STEPS_CLIP[0], Number.isFinite(steps) ? steps : STEPS_CLIP[1]));
  return a + b * Math.log(r) + c * Math.log(s) + (off ? w : 0);
}

export const predict = (coef: Readonly<Record<Tier, Readonly<Coef>>>, tier: Tier, reach: number, steps: number, off = false) =>
  sigmoid(predictLogit(coef, tier, reach, steps, off));

/** School-basis selection probability (the one every band and check uses). */
export const pSelect = (tier: Tier, reach: number, steps: number) => predict(COEF_SELECT, tier, reach, steps, false);

// ---------------------------------------------------------------- calendar

export type DayType = "school" | "mon" | "off";

const dow = (day: string) => new Date(`${day}T00:00:00Z`).getUTCDay(); // 0 = Sunday
const iso = (y: number, m: number, d: number) => `${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;

/** The n-th `weekday` (0 = Sunday) of month m (1-12) in year y. */
function nthWeekday(y: number, m: number, weekday: number, n: number): string {
  const first = iso(y, m, 1);
  return addDays(first, ((weekday - dow(first) + 7) % 7) + 7 * (n - 1));
}

function lastWeekday(y: number, m: number, weekday: number): string {
  const last = addDays(iso(m === 12 ? y + 1 : y, m === 12 ? 1 : m + 1, 1), -1);
  return addDays(last, -((dow(last) - weekday + 7) % 7));
}

const holidayCache = new Map<number, ReadonlySet<string>>();
function usHolidays(y: number): ReadonlySet<string> {
  let h = holidayCache.get(y);
  if (!h) {
    const thanksgiving = nthWeekday(y, 11, 4, 4);
    h = new Set([
      iso(y, 1, 1),
      nthWeekday(y, 1, 1, 3), // MLK Day
      nthWeekday(y, 2, 1, 3), // Presidents' Day
      lastWeekday(y, 5, 1), // Memorial Day
      nthWeekday(y, 9, 1, 1), // Labor Day
      addDays(thanksgiving, -1),
      thanksgiving,
      addDays(thanksgiving, 1),
    ]);
    holidayCache.set(y, h);
  }
  return h;
}

/**
 * US-classroom day type: "off" = weekends, New Year's Day, MLK, Presidents', Memorial and Labor
 * Day, Thanksgiving Wednesday-Friday, Dec 23-Jan 1, Jun 21-Aug 14; otherwise Monday is "mon"
 * (the friendliest bands: a class's first day back) and Tuesday-Friday "school".
 */
export function dayType(day: string): DayType {
  const wd = dow(day);
  if (wd === 0 || wd === 6) return "off";
  const y = Number(day.slice(0, 4));
  const md = day.slice(5);
  if (usHolidays(y).has(day)) return "off";
  if (md >= "12-23" || md <= "01-01") return "off";
  if (md >= "06-21" && md <= "08-14") return "off";
  return wd === 1 ? "mon" : "school";
}

/** Named family holidays (no gloomy hazard/disease targets on them): Thanksgiving, Dec 24-25, Jan 1, Jul 4. */
export function namedHoliday(day: string): string | null {
  const md = day.slice(5);
  if (md === "12-24" || md === "12-25") return "christmas";
  if (md === "01-01") return "new-year";
  if (md === "07-04") return "july-4";
  if (day === nthWeekday(Number(day.slice(0, 4)), 11, 4, 4)) return "thanksgiving";
  return null;
}

// ---------------------------------------------------------------- bands

export interface Band {
  /** School-basis predicted completion range (lo widens down to the floor; hi never moves). */
  lo: number;
  hi: number;
  /** Inclusive current-steps range. */
  steps: readonly [number, number];
}

export const BANDS: Readonly<Record<DayType, Readonly<Record<Tier, Band>>>> = {
  school: {
    easy: { lo: 0.3, hi: 1, steps: [1, 3] },
    hard: { lo: 0.07, hi: 0.15, steps: [2, 6] },
    expert: { lo: 0.03, hi: 0.06, steps: [5, 12] },
  },
  mon: {
    easy: { lo: 0.3, hi: 1, steps: [1, 3] },
    hard: { lo: 0.09, hi: 0.15, steps: [2, 6] },
    expert: { lo: 0.035, hi: 0.06, steps: [5, 12] },
  },
  off: {
    easy: { lo: 0.22, hi: 1, steps: [1, 3] },
    hard: { lo: 0.04, hi: 0.1, steps: [3, 7] },
    expert: { lo: 0.015, hi: 0.03, steps: [6, 14] },
  },
};

/** Expert exploration arm (school/mon only, §6.3): bigger numbers at a lower predicted p. */
export const EXPLORE_BAND: Band = { lo: 0.02, hi: 0.06, steps: [7, 10] };

/** A band below its minimum pool widens lo by WIDEN_STEP logit at a time down to its floor. */
export const MIN_POOL: Readonly<Record<Tier | "explore", number>> = { easy: 24, hard: 60, expert: 60, explore: 60 };
export const BAND_FLOOR: Readonly<Record<DayType, Readonly<Record<Tier, number>>>> = {
  school: { easy: 0.27, hard: 0.03, expert: 0.015 },
  mon: { easy: 0.27, hard: 0.03, expert: 0.015 },
  off: { easy: 0.18, hard: 0.02, expert: 0.008 },
};
export const WIDEN_STEP = 0.1;
/** Easy-capable (removed from hard, expert and explore): steps 1-3, art ready, p_easy >= this. */
export const EASY_CAPABLE_P = 0.22;
/** Reach above the fitted p95 per tier (meta outOfSupport). */
export const SUPPORT_REACH: Readonly<Record<Tier, number>> = { easy: 1, hard: 0.069, expert: 0.018 };

/**
 * Frozen school-basis p cut points of the arm thirds (§6.2 hard thirds on every day type, §6.4
 * off-day expert thirds): third = p < cuts[0] ? 0 : p < cuts[1] ? 1 : 2. They are the rank
 * tertiles of the pools on the 2026-11-23 snapshot. Fixed cuts mean a candidate's third moves only
 * when its own p does, so adding or removing another candidate never re-slices a day's bag (rank
 * tertiles recomputed per run did: removing one never-picked hard name changed 29 of 365 days).
 * Re-derive them with the bands (MODEL_VERSION bump).
 */
export const THIRD_CUTS: Readonly<Record<DayType, { hard: readonly [number, number]; expert: readonly [number, number] | null }>> = {
  school: { hard: [0.0786, 0.0967], expert: null },
  mon: { hard: [0.0973, 0.1077], expert: null },
  off: { hard: [0.0522, 0.0673], expert: [0.0192, 0.0233] },
};

/** The arm third of school-basis `p` under `cuts`. */
export const thirdOf = (p: number, cuts: readonly [number, number]): Third => (p < cuts[0] ? 0 : p < cuts[1] ? 1 : 2);

// ---------------------------------------------------------------- experiments (§6)

/** Blocks are counted from this day within each day class (weekdays = school + mon, off). */
export const EXP_EPOCH = "2026-11-30";
export const HOLDOUT_WINDOW = { from: "2026-11-30", to: "2027-02-05", block: 6 } as const;
export const EXPLORE_WINDOW = { from: "2026-11-30", to: "2027-04-30", block: 4 } as const;
export const THIRDS_BLOCK = 3;
const SALT = "pred-v6";

export type DayClass = "wk" | "off";
export const dayClass = (day: string): DayClass => (dayType(day) === "off" ? "off" : "wk");

/** 32-bit FNV-1a (also the challenge picker's hash). */
export function hash32(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/**
 * murmur3's 32-bit finalizer. FNV-1a alone mixes the LAST characters of a key poorly (a change in
 * the final id digit moves mostly the top byte, linearly), so draws keyed by `...:${id}` were
 * correlated across ids: a 10x-weight element won 77% of days instead of 17%. Mixing fixes that.
 */
export function mix32(h: number): number {
  h ^= h >>> 16;
  h = Math.imul(h, 0x85ebca6b);
  h ^= h >>> 13;
  h = Math.imul(h, 0xc2b2ae35);
  h ^= h >>> 16;
  return h >>> 0;
}

/** Uniform (0, 1) from a string key: (mix32(hash32(key)) + 0.5) / 2^32. */
export const u01 = (key: string) => (mix32(hash32(key)) + 0.5) / 4294967296;

// Signed index of `day` among the days of its class counted from EXP_EPOCH (epoch's class day = 0).
const classCounts = { wk: [0], off: [0] }; // counts[c][i] = # class-c days in [EPOCH, EPOCH + i)
function classIndex(day: string): number {
  const c = dayClass(day);
  const offset = Math.round((Date.parse(`${day}T00:00:00Z`) - Date.parse(`${EXP_EPOCH}T00:00:00Z`)) / 86_400_000);
  if (offset >= 0) {
    for (const k of ["wk", "off"] as const) {
      const arr = classCounts[k];
      while (arr.length <= offset) {
        const d = addDays(EXP_EPOCH, arr.length - 1);
        arr.push(arr.at(-1)! + (dayClass(d) === k ? 1 : 0));
      }
    }
    return classCounts[c][offset]!;
  }
  let n = 0;
  for (let d = day; d < EXP_EPOCH; d = addDays(d, 1)) if (dayClass(d) === c) n++;
  return -n;
}

/** Permuted-block assignment: position of `index` in its block of `k`, mapped through a hash permutation. */
export function blockArm(index: number, k: number, salt: string): { arm: number; block: number } {
  const block = Math.floor(index / k);
  const pos = index - block * k;
  const perm = Array.from({ length: k }, (_, i) => i).sort((x, y) => u01(`${SALT}:${salt}:${block}:${x}`) - u01(`${SALT}:${salt}:${block}:${y}`) || x - y);
  return { arm: perm[pos]!, block };
}

export type Third = 0 | 1 | 2;

export interface DayArms {
  dayType: DayType;
  holdout: { assigned: boolean; block: number | null };
  /** Hard band third (rank tertile of the day type's hard pool; 0 = lowest predicted p). */
  hard: { third: Third; block: number };
  /** Expert: weekdays "band" or "explore"; off days a third. */
  expert: { assigned: "band" | "explore" | Third; block: number };
}

/** Experiment arms of `day`: a pure function of the date (§6). */
export function armFor(day: string): DayArms {
  const type = dayType(day);
  const cls = dayClass(day);
  const idx = classIndex(day);
  const hard = blockArm(idx, THIRDS_BLOCK, `hard-${cls}`);
  let holdout: DayArms["holdout"] = { assigned: false, block: null };
  let expert: DayArms["expert"];
  if (cls === "off") {
    const x = blockArm(idx, THIRDS_BLOCK, "expert-off");
    expert = { assigned: x.arm as Third, block: x.block };
  } else {
    const inExplore = day >= EXPLORE_WINDOW.from && day <= EXPLORE_WINDOW.to;
    const x = blockArm(idx, EXPLORE_WINDOW.block, "expert-explore");
    expert = { assigned: inExplore && x.arm === 0 ? "explore" : "band", block: x.block };
    if (day >= HOLDOUT_WINDOW.from && day <= HOLDOUT_WINDOW.to) {
      const h = blockArm(idx, HOLDOUT_WINDOW.block, "holdout");
      holdout = { assigned: h.arm === 0, block: h.block };
    }
  }
  return { dayType: type, holdout, hard: { third: hard.arm as Third, block: hard.block }, expert };
}

/** Everything that defines the picks (hashed into meta.configHash). */
export const MODEL_CONFIG = {
  MODEL_VERSION,
  COEF_SELECT,
  COEF_EXPECT,
  REACH_FLOOR,
  STEPS_CLIP,
  REACH7_OFFSET,
  BANDS,
  EXPLORE_BAND,
  MIN_POOL,
  BAND_FLOOR,
  WIDEN_STEP,
  EASY_CAPABLE_P,
  THIRD_CUTS,
  EXP_EPOCH,
  HOLDOUT_WINDOW,
  EXPLORE_WINDOW,
  THIRDS_BLOCK,
} as const;
