// Weekly database snapshot. Aggregates only: no player id, public id or IP hash is ever output
// (the IP hash is used inside SQL to size same-network groups, and nowhere else).
//
// - Cohorts: real new players by local first day (day0) with activation, D1/D7 and the
//   school-calendar metrics: NSD (return on the next school day, on the HOLIDAYS calendar), any
//   return in D1-D7, 2+ / 3+ return days in D1-D7 and week-2 active (day0+7..+13). Split by
//   landing page, referrer, UTM source and platform (bets A, C, D), start weekday, referrer class,
//   same-network group size, day-0 combines and cohort week; D1/NSD by day-0 challenge completion
//   (bet B); activation standardized to the 11-09..11-20 referrer x group mix (bet A).
// - Legacy returners (bet E), crawler and throwaway counts, the probable re-creation pool.
// - Budgets (current windows, 30-day daily history, phantom image charges), the server's daily
//   stat:* counters (denials by rule, fizzles, art lanes, PoW, boot abandons) and art coverage.
// - Wave-2 segments (player_days timing, iPad, standalone, element reports, experiment arms),
//   each skipped with a note until its columns exist.
// Definitions and decision rules: .analytics/ANALYTICS.md.
//
//   npm run analytics:snapshot [-- --schema=alchemy] [--out=.analytics/2026-11-16]
//
// Read-only: every query runs on one session with default_transaction_read_only = on.
// Player metrics exclude crawlers (acq_ua_class = 'bot'), throwaway players left through a
// transfer code (switched_away_at), and internal players: ANALYTICS_INTERNAL_PLAYERS in .env, a
// comma-separated list of players.public_id values (yours, from Settings or GA user_id).
import "../lib/env.ts";
import fs from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import type pg from "pg";
import { isMain, printTable, runMain } from "../lib/cli.ts";
import { createPool, resolveSchema } from "../lib/db.ts";
import { REPO_ROOT } from "../lib/env.ts";

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

/** First local day player_days is keyed by local day (migration 0007); earlier rows are UTC. */
export const LOCAL_DAYS_FROM = "2026-11-09";
/** Bet baselines: the referrer x group mix activation is standardized to (weekday cohorts). */
export const MIX_FROM = "2026-11-09";
export const MIX_TO = "2026-11-20";
/**
 * First day0 whose players carry randomized experiment arms (the wave-2 deploy; set it to the
 * day after the deploy so no player created before it counts). null = no experiment is live and
 * the section is skipped.
 */
export const EXPERIMENTS_FROM: string | null = "2026-11-24"; // wave-2 deploy 2026-11-23 + 1 day
/** Arm = parity of one hex digit of players.public_id (0-based index into the 36-char string). */
export const EXPERIMENTS = [
  { name: "firstRun", index: 35 },
  { name: "idleCard", index: 34 },
  { name: "goals", index: 33 },
] as const;
/** Return-day offsets fetched per player: covers NSD across the winter break (12-18 → 01-04 = 17). */
export const RETURN_HORIZON = 21;

/** Evaluation windows by day0 (ANALYTICS.md "Key dates"). Decide nothing on "excluded" or "no reads". */
export const EVAL_WINDOWS: readonly (readonly [label: string, from: string, to: string])[] = [
  ["before 11-09..11-20", "2026-11-09", "2026-11-20"],
  ["excluded 11-21..11-29", "2026-11-21", "2026-11-29"],
  ["after 11-30..12-18", "2026-11-30", "2026-12-18"],
  ["no reads 12-19..01-04", "2026-12-19", "2027-01-04"],
  ["january from 01-05", "2027-01-05", "2027-01-31"],
];

// ------------------------------------------------------------------ school calendar

export const addDays = (day: string, n: number): string => new Date(Date.parse(`${day}T00:00:00Z`) + n * DAY).toISOString().slice(0, 10);
export const dayDiff = (a: string, b: string): number => Math.round((Date.parse(`${a}T00:00:00Z`) - Date.parse(`${b}T00:00:00Z`)) / DAY);
const weekday = (day: string): number => new Date(`${day}T00:00:00Z`).getUTCDay();
const daysBetween = (from: string, to: string): string[] => Array.from({ length: dayDiff(to, from) + 1 }, (_, i) => addDays(from, i));

export type Closure = "full" | "partial";
/**
 * US school closures, the audience's calendar. "full": most districts are closed, so it is not a
 * school day. "partial": many districts close; it still counts as a school day but is flagged.
 * Extend it before each new term (spring break varies by district: flag those weeks partial).
 */
const HOLIDAY_RANGES: readonly (readonly [from: string, to: string, kind: Closure])[] = [
  ["2026-11-11", "2026-11-11", "partial"], // Veterans Day (2025: ~15% under its week)
  ["2026-11-23", "2026-11-25", "partial"], // Thanksgiving week: many districts close all week
  ["2026-11-26", "2026-11-27", "full"], // Thanksgiving
  ["2026-12-21", "2027-01-01", "full"], // winter break
];
export const HOLIDAYS: ReadonlyMap<string, Closure> = new Map(
  HOLIDAY_RANGES.flatMap(([from, to, kind]) => daysBetween(from, to).map((d) => [d, kind] as const)),
);

export const isSchoolDay = (day: string): boolean => weekday(day) >= 1 && weekday(day) <= 5 && HOLIDAYS.get(day) !== "full";

/** The first school day after `day` (Mon-Thu → next day, Fri/Sat/Sun → Monday, skipping full closures). */
export function nextSchoolDay(day: string): string {
  let d = addDays(day, 1);
  while (!isSchoolDay(d)) d = addDays(d, 1);
  return d;
}

export type StartClass = "mon-thu" | "fri" | "weekend" | "holiday";
export function startClass(day: string): StartClass {
  const w = weekday(day);
  if (w === 0 || w === 6) return "weekend";
  if (HOLIDAYS.get(day) === "full") return "holiday";
  return w === 5 ? "fri" : "mon-thu";
}
export const isSchoolStart = (c: StartClass): boolean => c === "mon-thu" || c === "fri";
/** Monday of the week containing `day`. */
export const weekOf = (day: string): string => addDays(day, -((weekday(day) + 6) % 7));

const worse = (a: Closure | null, b: Closure | null | undefined): Closure | null => (a === "full" || b === "full" ? "full" : a ?? b ?? null);

/** Worst closure between a start day and its NSD day (inclusive): a closure there distorts NSD. */
export function nsdClosure(day: string): Closure | null {
  let worst: Closure | null = null;
  for (let d = addDays(day, 1), end = nextSchoolDay(day); d <= end; d = addDays(d, 1)) worst = worse(worst, HOLIDAYS.get(d));
  return worst;
}

/** Worst closure touching a cohort week: its own days or the NSD gaps its cohorts are judged on. */
export function weekClosure(monday: string): Closure | null {
  let worst: Closure | null = null;
  for (const d of daysBetween(monday, addDays(monday, 6))) worst = worse(worse(worst, HOLIDAYS.get(d)), nsdClosure(d));
  return worst;
}

// ------------------------------------------------------------------ segments

export const refClass = (referrer: string | null): "google" | "direct" | "other" =>
  referrer === null ? "direct" : referrer.includes("google.") ? "google" : "other";
export const clusterBucket = (size: number): "solo" | "2-4" | "5-14" | "15+" => (size <= 1 ? "solo" : size < 5 ? "2-4" : size < 15 ? "5-14" : "15+");
export const combinesBucket = (n: number): string => (n <= 0 ? "0" : n < 10 ? "1-9" : n < 50 ? "10-49" : n < 200 ? "50-199" : "200+");
export const activeMinutesBucket = (secs: number): string => {
  const m = secs / 60;
  return m < 1 ? "<1 min" : m < 5 ? "1-4 min" : m < 10 ? "5-9 min" : m < 30 ? "10-29 min" : "30+ min";
};
export const sessionsBucket = (n: number): string => (n <= 1 ? "1" : n === 2 ? "2" : "3+");
/** iPadOS reports itself as a Mac; the touch hint (wave 2) tells them apart. */
export const deviceClass = (platform: string | null, touch: boolean | null | undefined): string =>
  platform === "mac" ? (touch ? "ipad" : "mac") : (platform ?? "(unknown)");
/** Contract C6: an odd hex digit is the treatment arm. */
export function armOf(hexDigit: string): "control" | "treatment" {
  const v = parseInt(hexDigit, 16);
  if (!/^[0-9a-f]$/i.test(hexDigit) || Number.isNaN(v)) throw new Error(`Not a hex digit: ${JSON.stringify(hexDigit)}`);
  return v % 2 === 1 ? "treatment" : "control";
}

// ------------------------------------------------------------------ per-player outcomes

/** One real new player, as fetched (no identifiers). */
export interface CohortPlayer {
  day0: string;
  landing: string | null;
  referrer: string | null;
  utmSource: string | null;
  platform: string | null;
  /** New players created on the same network (IP hash) with the same day0, this one included. */
  csize: number;
  activated: boolean;
  challengeD0: boolean;
  combines0: number;
  /** Offsets (days after day0, 1..RETURN_HORIZON) with any activity. */
  ret: number[];
  touch?: boolean | null;
  standalone?: boolean | null;
  /** Day-0 player_days timing (wave 2); null when that row predates the columns. */
  activeSecs0?: number | null;
  sessions0?: number | null;
  /** Experiment arm per EXPERIMENTS name. */
  arms?: Record<string, "control" | "treatment">;
}

export interface Scored extends CohortPlayer {
  start: StartClass;
  nsdDay: string;
  /** Worst closure between day0 and the NSD day: NSD is read across it. */
  nsdClosure: Closure | null;
  d1: boolean;
  d1Ready: boolean;
  d7: boolean;
  d7Ready: boolean;
  nsd: boolean;
  nsdReady: boolean;
  /** Return days in D1-D7. */
  ret7: number;
  r7Ready: boolean;
  week2: boolean;
  week2Ready: boolean;
}

/**
 * Outcomes as of UTC day `today`. A horizon is "ready" once its last local day is 2 UTC days in
 * the past, so every time zone has finished it. D1/D7 keep their original guards (day0+2 / +8)
 * so the series stays comparable with earlier snapshots.
 */
export function score(p: CohortPlayer, today: string): Scored {
  const nsdDay = nextSchoolDay(p.day0);
  const nsdOffset = dayDiff(nsdDay, p.day0);
  const has = (o: number) => p.ret.includes(o);
  return {
    ...p,
    start: startClass(p.day0),
    nsdDay,
    nsdClosure: nsdClosure(p.day0),
    d1: has(1),
    d1Ready: addDays(p.day0, 2) <= today,
    d7: has(7),
    d7Ready: addDays(p.day0, 8) <= today,
    nsd: has(nsdOffset),
    nsdReady: nsdOffset <= RETURN_HORIZON && addDays(nsdDay, 2) <= today,
    ret7: p.ret.filter((o) => o >= 1 && o <= 7).length,
    r7Ready: addDays(p.day0, 7 + 2) <= today,
    week2: p.ret.some((o) => o >= 7 && o <= 13),
    week2Ready: addDays(p.day0, 13 + 2) <= today,
  };
}

export type Row = Record<string, string | number | boolean | null>;
const pct = (y: number, n: number): number | null => (n > 0 ? Math.round((1000 * y) / n) / 10 : null);

/**
 * Rates for a group. NSD counts school-day starts only (Mon-Fri, not a full closure), the headline
 * definition, unless `nsdAllStarts` (rows that are already one start class, e.g. by weekday).
 * Every rate has its own denominator (`*_n`): only players whose horizon is ready.
 */
export function rates(ps: readonly Scored[], { nsdAllStarts = false } = {}): Row {
  const count = (xs: readonly Scored[], f: (p: Scored) => boolean) => xs.filter(f).length;
  const activated = count(ps, (p) => p.activated);
  const d1 = ps.filter((p) => p.d1Ready);
  const d7 = ps.filter((p) => p.d7Ready);
  const nsd = ps.filter((p) => p.nsdReady && (nsdAllStarts || isSchoolStart(p.start)));
  const nsdAct = nsd.filter((p) => p.activated);
  const r7 = ps.filter((p) => p.r7Ready);
  const w2 = ps.filter((p) => p.week2Ready);
  const nsdY = count(nsd, (p) => p.nsd);
  return {
    players: ps.length,
    activated,
    activated_pct: pct(activated, ps.length),
    d1_n: d1.length,
    d1_pct: pct(count(d1, (p) => p.d1), d1.length),
    d7_n: d7.length,
    d7_pct: pct(count(d7, (p) => p.d7), d7.length),
    nsd_n: nsd.length,
    nsd_y: nsdY,
    nsd_pct: pct(nsdY, nsd.length),
    nsd_act_n: nsdAct.length,
    nsd_act_pct: pct(count(nsdAct, (p) => p.nsd), nsdAct.length),
    any7_n: r7.length,
    any7_pct: pct(count(r7, (p) => p.ret7 >= 1), r7.length),
    ret2_7_pct: pct(count(r7, (p) => p.ret7 >= 2), r7.length),
    ret3_7_pct: pct(count(r7, (p) => p.ret7 >= 3), r7.length),
    week2_n: w2.length,
    week2_pct: pct(count(w2, (p) => p.week2), w2.length),
  };
}

function groupBy<T>(xs: readonly T[], keyOf: (x: T) => string): Map<string, T[]> {
  const m = new Map<string, T[]>();
  for (const x of xs) {
    const k = keyOf(x);
    const g = m.get(k);
    if (g) g.push(x);
    else m.set(k, [x]);
  }
  return m;
}

export function breakdown(
  ps: readonly Scored[],
  keyOf: (p: Scored) => string,
  opts: { nsdAllStarts?: boolean; sort?: "players" | "key"; limit?: number } = {},
): Row[] {
  const rows = [...groupBy(ps, keyOf)].map(([key, g]): Row => ({ key, ...rates(g, opts) }));
  const byKey = (a: Row, b: Row) => (String(a.key) < String(b.key) ? -1 : String(a.key) > String(b.key) ? 1 : 0);
  rows.sort(opts.sort === "key" ? byKey : (a, b) => Number(b.players) - Number(a.players) || byKey(a, b));
  return opts.limit ? rows.slice(0, opts.limit) : rows;
}

/** Referrer class x network group size: the cells activation is standardized over. */
export const mixCell = (p: CohortPlayer): string => `${refClass(p.referrer)} x ${clusterBucket(p.csize)}`;

/** Share of the reference cohort in each mix cell. */
export function mixWeights(ref: readonly CohortPlayer[]): Map<string, number> {
  const w = new Map<string, number>();
  for (const [cell, g] of groupBy(ref, mixCell)) w.set(cell, g.length / ref.length);
  return w;
}

/**
 * Direct standardization: Σ w(cell) x rate(cell) over the cells the group has, renormalized by the
 * covered weight. coverage_pct says how much of the reference mix the group covers; read the
 * standardized rate only when it is near 100.
 */
export function standardized(ps: readonly CohortPlayer[], weights: ReadonlyMap<string, number>, hit: (p: CohortPlayer) => boolean): { pct: number | null; coverage_pct: number | null } {
  let sum = 0;
  let covered = 0;
  for (const [cell, g] of groupBy(ps, mixCell)) {
    const w = weights.get(cell);
    if (!w) continue;
    sum += (w * g.filter(hit).length) / g.length;
    covered += w;
  }
  return covered > 0 ? { pct: Math.round((1000 * sum) / covered) / 10, coverage_pct: Math.round(1000 * covered) / 10 } : { pct: null, coverage_pct: null };
}

const stdActivation = (ps: readonly CohortPlayer[], weights: ReadonlyMap<string, number>): Row => {
  const s = standardized(ps, weights, (p) => p.activated);
  return { std_activated_pct: s.pct, std_coverage_pct: s.coverage_pct };
};

/** Every cohort-derived section of the snapshot (pure; tested with synthetic players). */
export function cohortSections(players: readonly CohortPlayer[], today: string): Record<string, unknown> {
  const ps = players.map((p) => score(p, today));
  const ref = ps.filter((p) => p.day0 >= MIX_FROM && p.day0 <= MIX_TO);
  const weights = mixWeights(ref);
  const activated = ps.filter((p) => p.activated);
  const school = ps.filter((p) => isSchoolStart(p.start));
  const out: Record<string, unknown> = {};

  // Existing keys (same names and columns, new columns appended).
  out.cohorts_by_day = breakdown(ps, (p) => p.day0, { sort: "key", nsdAllStarts: true }).map((r) => {
    const day = String(r.key);
    return { ...r, start: startClass(day), nsd_day: nextSchoolDay(day), nsd_closure: nsdClosure(day) };
  });
  out.by_landing = breakdown(ps, (p) => p.landing ?? "(unknown)", { limit: 25 });
  out.by_referrer = breakdown(ps, (p) => p.referrer ?? "(direct)", { limit: 25 });
  out.by_utm_source = breakdown(ps, (p) => p.utmSource ?? "(none)", { limit: 25 });
  out.by_platform = breakdown(ps, (p) => p.platform ?? "(unknown)", { limit: 25 });
  // Bet B: among activated new players, does finishing a challenge tier on day 0 go with returning?
  out.activated_by_challenge_d0 = breakdown(activated, (p) => (p.challengeD0 ? "completed a tier on day 0" : "no tier on day 0"));

  // The headline: NSD for school-day starts, all and activated (nsd_pct, nsd_act_pct).
  out.by_weekday_class = [
    { key: "school-day starts (mon-fri)", ...rates(school) },
    ...breakdown(ps, (p) => p.start, { nsdAllStarts: true, sort: "key" }),
  ];
  out.by_ref_class = breakdown(ps, (p) => refClass(p.referrer));
  out.by_cluster = breakdown(ps, (p) => clusterBucket(p.csize));
  out.by_ref_cluster = breakdown(ps, mixCell).map((r) => ({ ...r, mix_weight_pct: Math.round(1000 * (weights.get(String(r.key)) ?? 0)) / 10 }));
  out.by_day0_combines = breakdown(ps, (p) => combinesBucket(p.combines0)).sort(
    (a, b) => ["0", "1-9", "10-49", "50-199", "200+"].indexOf(String(a.key)) - ["0", "1-9", "10-49", "50-199", "200+"].indexOf(String(b.key)),
  );
  out.cohorts_by_week = [...groupBy(ps, (p) => weekOf(p.day0))]
    .sort(([a], [b]) => (a < b ? -1 : 1))
    .map(([week, g]) => ({
      week,
      closure: weekClosure(week),
      school_starts: g.filter((p) => isSchoolStart(p.start)).length,
      google: g.filter((p) => refClass(p.referrer) === "google").length,
      direct: g.filter((p) => refClass(p.referrer) === "direct").length,
      other: g.filter((p) => refClass(p.referrer) === "other").length,
      ...rates(g),
      ...stdActivation(g, weights),
    }));
  // Bet A's read: raw and mix-standardized activation side by side, per evaluation window.
  out.eval_windows = EVAL_WINDOWS.map(([label, from, to]): Row => {
    const g = ps.filter((p) => p.day0 >= from && p.day0 <= to);
    return { key: label, ...rates(g), ...stdActivation(g, weights) };
  }).filter((r) => Number(r.players) > 0);
  out.activation_standardized = {
    reference: `day0 ${MIX_FROM}..${MIX_TO}, all start days, cells = referrer class x network group size`,
    weights: Object.fromEntries([...weights].sort(([a], [b]) => (a < b ? -1 : 1)).map(([k, v]) => [k, Math.round(1000 * v) / 10])),
  };
  out.retention_excl_clusters = [
    { key: "all", ...rates(ps) },
    { key: "excluding same-network groups of 10+", ...rates(ps.filter((p) => p.csize < 10)) },
    { key: "solo and 2-4 only", ...rates(ps.filter((p) => p.csize < 5)) },
  ];

  // Wave 2 (contract C5/C6): only players whose rows carry the new fields.
  const timed = ps.filter((p) => p.activeSecs0 != null && p.sessions0 != null);
  if (timed.length > 0) {
    const order = ["<1 min", "1-4 min", "5-9 min", "10-29 min", "30+ min"];
    out.day0_active_minutes = breakdown(timed, (p) => activeMinutesBucket(p.activeSecs0!)).sort((a, b) => order.indexOf(String(a.key)) - order.indexOf(String(b.key)));
    out.day0_sessions = breakdown(timed, (p) => sessionsBucket(p.sessions0!), { sort: "key" });
    const act = timed.filter((p) => p.activated);
    const mins = act.map((p) => p.activeSecs0! / 60).sort((a, b) => a - b);
    out.day0_timing_summary = {
      players: timed.length,
      activated: act.length,
      activated_10min_pct: pct(act.filter((p) => p.activeSecs0! >= 600).length, act.length),
      activated_2plus_sessions_pct: pct(act.filter((p) => p.sessions0! >= 2).length, act.length),
      activated_median_active_min: mins.length ? Math.round(10 * mins[Math.floor(mins.length / 2)]!) / 10 : null,
    };
  }
  const touched = ps.filter((p) => p.touch != null);
  if (touched.length > 0) out.by_device_touch = breakdown(touched, (p) => deviceClass(p.platform, p.touch));
  if (EXPERIMENTS_FROM !== null) out.experiments = experimentRows(ps, EXPERIMENTS_FROM, weights);
  return out;
}

/** Rates per experiment arm for players with day0 >= `from` (randomized, so raw rates compare). */
export function experimentRows(ps: readonly Scored[], from: string, weights: ReadonlyMap<string, number>): Row[] {
  const live = ps.filter((p) => p.day0 >= from && p.arms);
  return EXPERIMENTS.flatMap(({ name }) =>
    (["control", "treatment"] as const).map((arm) => {
      const g = live.filter((p) => p.arms![name] === arm);
      return { experiment: name, arm, ...rates(g), ...stdActivation(g, weights) };
    }),
  );
}

// ------------------------------------------------------------------ counters: budgets and stats

const KNOWN_WINDOWS = [MIN, HOUR, DAY, 30 * DAY];
/** A counter row expires this long after its window: 1 min (rate limits, old budgets), 90 days (contract C2). */
const EXPIRY_PADS = [MIN, 90 * DAY];

export interface BudgetRow {
  rule: string;
  index: number;
  windowMs: number;
  startsAt: number;
  endsAt: number;
  used: number;
}

/**
 * Parse `rl:<rule>:<subject>:<window index>`. The window length is recovered from expires_at
 * (window end + a known pad), falling back to the rule name, so new budgets need no change here.
 */
export function parseBudgetRow(key: string, count: number, expiresAtMs: number): BudgetRow | null {
  const parts = key.split(":");
  if (parts.length < 4 || parts[0] !== "rl") return null;
  const rule = parts[1]!;
  const index = Number(parts[parts.length - 1]);
  if (!Number.isInteger(index)) return null;
  let windowMs = rule.endsWith(".month") ? 30 * DAY : DAY;
  outer: for (const w of KNOWN_WINDOWS) {
    for (const pad of EXPIRY_PADS) {
      if ((index + 1) * w + pad === expiresAtMs) {
        windowMs = w;
        break outer;
      }
    }
  }
  return { rule, index, windowMs, startsAt: index * windowMs, endsAt: (index + 1) * windowMs, used: count };
}

const iso = (ms: number) => new Date(ms).toISOString();
const isoDayOf = (ms: number) => iso(ms).slice(0, 10);

export function budgetSections(rows: readonly BudgetRow[], nowMs: number): { budgets: Row[]; budgets_history: Row[]; budgets_previous_windows: Row[] } {
  const current = rows.filter((r) => r.index === Math.floor(nowMs / r.windowMs));
  const fromIndex = Math.floor(nowMs / DAY) - 29;
  const daily = new Map<string, Row>();
  for (const r of rows) {
    if (r.windowMs !== DAY || r.index < fromIndex) continue;
    const day = isoDayOf(r.startsAt);
    daily.set(day, { ...(daily.get(day) ?? { day }), [r.rule]: r.used });
  }
  return {
    budgets: current
      .map((r) => ({ name: r.rule, used: r.used, window_starts: iso(r.startsAt), window_ends: iso(r.endsAt) }))
      .sort((a, b) => (a.name < b.name ? -1 : 1)),
    budgets_history: [...daily.values()].sort((a, b) => (String(a.day) < String(b.day) ? -1 : 1)),
    budgets_previous_windows: rows
      .filter((r) => r.windowMs > DAY && r.index < Math.floor(nowMs / r.windowMs))
      .map((r) => ({ name: r.rule, used: r.used, window_starts: iso(r.startsAt), window_ends: iso(r.endsAt) })),
  };
}

/** Parse `stat:<name>:<UTC day index>` (contract C1). The name may itself contain colons. */
export function parseStatKey(key: string): { name: string; day: string } | null {
  const m = /^stat:(.+):(\d+)$/.exec(key);
  return m ? { name: m[1]!, day: isoDayOf(Number(m[2]) * DAY) } : null;
}

/** Long-format daily rows per stat family; pivoted where a family has a fixed outcome set. */
export function statSections(stats: readonly { key: string; count: number }[], nowMs: number): Record<string, Row[]> {
  const since = isoDayOf(nowMs - 29 * DAY);
  const fam: Record<string, Row[]> = { denied: [], fizzle: [], art: [], pow: [], boot_abandon: [], other: [] };
  for (const s of stats) {
    const p = parseStatKey(s.key);
    if (!p || p.day < since) continue;
    const [family, ...rest] = p.name.split(":");
    const n = s.count;
    if (family === "denied") fam.denied!.push({ day: p.day, rule: rest.join(":"), n });
    else if (family === "fizzle") fam.fizzle!.push({ day: p.day, reason: rest.join(":"), n });
    else if (family === "art") fam.art!.push({ day: p.day, lane: rest[0] ?? "", outcome: rest.slice(1).join(":"), n });
    else if (family === "pow") fam.pow!.push({ day: p.day, kind: rest[0] ?? "", key: rest.slice(1).join(":"), n });
    else if (family === "boot_abandon") fam.boot_abandon!.push({ day: p.day, phase: rest[0] ?? "", band: rest[1] ?? "", ua: rest.slice(2).join(":"), n });
    else fam.other!.push({ day: p.day, name: p.name, n });
  }
  const byDayThenN = (a: Row, b: Row) => (a.day === b.day ? Number(b.n) - Number(a.n) : String(a.day) < String(b.day) ? -1 : 1);
  // Art lanes: one row per day x lane with an outcome column each (started, deferred_*).
  const art = new Map<string, Row>();
  for (const r of fam.art!) {
    const k = `${r.day}|${r.lane}`;
    const row: Row = art.get(k) ?? { day: r.day ?? null, lane: r.lane ?? null };
    row[String(r.outcome)] = (Number(row[String(r.outcome)]) || 0) + Number(r.n);
    art.set(k, row);
  }
  // PoW: issued vs redeemed per day x UA class; latency bands separately.
  const pow = new Map<string, Row>();
  for (const r of fam.pow!.filter((x) => x.kind === "issued" || x.kind === "redeemed")) {
    const k = `${r.day}|${r.key}`;
    const row: Row = pow.get(k) ?? { day: r.day ?? null, ua: r.key ?? null, issued: 0, redeemed: 0 };
    row[String(r.kind)] = Number(row[String(r.kind)]) + Number(r.n);
    pow.set(k, row);
  }
  return {
    stat_denials_by_day: fam.denied!.sort(byDayThenN),
    stat_fizzles_by_day: fam.fizzle!.sort(byDayThenN),
    stat_art_by_day: [...art.values()].sort((a, b) => (a.day === b.day ? (String(a.lane) < String(b.lane) ? -1 : 1) : String(a.day) < String(b.day) ? -1 : 1)),
    stat_pow_by_day: [...pow.values()].map((r): Row => ({ ...r, redeemed_pct: pct(Number(r.redeemed), Number(r.issued)) })).sort(byDayThenN),
    stat_pow_latency_by_day: fam.pow!.filter((x) => x.kind === "latency").map((r): Row => ({ day: r.day ?? null, band: r.key ?? null, n: r.n ?? 0 })).sort(byDayThenN),
    stat_boot_abandon_by_day: fam.boot_abandon!.sort(byDayThenN),
    stat_other_by_day: fam.other!.sort(byDayThenN),
  };
}

/** The 30-day image window every v2 attempt so far falls in (v2 launched 2026-11-06, inside it). */
const FIRST_V2_IMAGE_WINDOW = 692;

/** Charges on budget.image.month that started no generation (T1a), when it can be computed. */
export function phantomCheck(month: BudgetRow | undefined, attemptsTotal: number, previous?: { generated_at: string; window_index: number; monthly_counter: number; image_attempts_total: number }, nowMs = Date.now()): Row {
  if (!month) return { note: "no budget.image.month row in the current window" };
  const row: Row = {
    window_index: month.index,
    window_starts: iso(month.startsAt),
    window_ends: iso(month.endsAt),
    monthly_counter: month.used,
    image_attempts_total: attemptsTotal,
    // sum(image_attempts) is lifetime; it equals this window's real generations only while every
    // attempt falls inside it. Later windows use the delta against the previous snapshot.
    phantom_in_window: month.index === FIRST_V2_IMAGE_WINDOW ? month.used - attemptsTotal : null,
  };
  if (previous && previous.window_index === month.index) {
    const days = (nowMs - Date.parse(previous.generated_at)) / DAY;
    const phantom = month.used - previous.monthly_counter - (attemptsTotal - previous.image_attempts_total);
    Object.assign(row, {
      previous_snapshot: previous.generated_at,
      phantom_since_previous: phantom,
      phantom_per_day_since_previous: days > 0 ? Math.round((10 * phantom) / days) / 10 : null,
    });
  }
  return row;
}

/** The newest earlier db_snapshot.json next to `out` (sibling folders), for deltas. */
function previousSnapshot(out: string): Record<string, unknown> | undefined {
  let best: Record<string, unknown> | undefined;
  try {
    const parent = path.dirname(out);
    for (const d of fs.readdirSync(parent)) {
      const f = path.join(parent, d, "db_snapshot.json");
      if (path.resolve(parent, d) === path.resolve(out) || !fs.existsSync(f)) continue;
      const j = JSON.parse(fs.readFileSync(f, "utf8")) as Record<string, unknown>;
      if (typeof j.generated_at === "string" && (!best || j.generated_at > String(best.generated_at))) best = j;
    }
  } catch {
    // No sibling snapshots: nothing to diff against.
  }
  return best;
}

// ------------------------------------------------------------------ main

async function main(): Promise<void> {
  const { values } = parseArgs({ options: { schema: { type: "string" }, out: { type: "string" } } });
  const s = resolveSchema(values.schema);
  const nowMs = Date.now();
  const today = isoDayOf(nowMs);
  const out = path.resolve(REPO_ROOT, values.out ?? path.join(".analytics", today));
  const internal = (process.env.ANALYTICS_INTERNAL_PLAYERS ?? "").split(",").map((x) => x.trim()).filter(Boolean);
  const pool = createPool(1);
  const db = await pool.connect();
  const result: Record<string, unknown> = {
    generated_at: iso(nowMs),
    schema: s,
    local_days_from: LOCAL_DAYS_FROM,
    internal_players_excluded: internal.length,
    today_utc: today,
    holidays: Object.fromEntries(HOLIDAYS),
    experiments_from: EXPERIMENTS_FROM,
  };
  const show = (name: string, rows: unknown) => {
    result[name] = rows;
    console.log(`\n== ${name}`);
    if (!Array.isArray(rows)) return console.log(JSON.stringify(rows, null, 1));
    // Pivoted rows can differ in columns: print the union.
    const keys = [...new Set((rows as Row[]).flatMap((r) => Object.keys(r)))];
    printTable((rows as Row[]).map((r) => Object.fromEntries(keys.map((k) => [k, r[k] == null ? "" : String(r[k])]))));
  };
  const skip = (name: string, why: string) => show(name, { skipped: why });
  const query = async <T extends pg.QueryResultRow>(sql: string, params: unknown[] = []) => (await db.query<T>(sql, params)).rows;

  try {
    await db.query("SET default_transaction_read_only = on");
    // Optional columns and tables (migrations 0008/0009, contract C5): sections skip until they exist.
    const cols = new Set(
      (await query<{ t: string; c: string }>(
        `SELECT table_name AS t, column_name AS c FROM information_schema.columns
          WHERE table_schema = $1 AND table_name IN ('players', 'player_days', 'elements', 'element_reports')`,
        [s],
      )).map((r) => `${r.t}.${r.c}`),
    );
    const has = (tc: string) => cols.has(tc);
    const hasReports = [...cols].some((c) => c.startsWith("element_reports."));
    const timing = ["first_at", "sessions", "active_secs", "entry"].every((c) => has(`player_days.${c}`));
    result.schema_features = {
      image_ready_at: has("elements.image_ready_at"),
      player_days_timing: timing,
      acq_touch: has("players.acq_touch"),
      standalone_at: has("players.standalone_at"),
      element_reports: hasReports,
    };

    // One row per real new player: their local first day (day0) and segments. A player whose first
    // player_days row comes long after creation is an old player returning, not a new one.
    const extraCols = [
      ...(has("players.acq_touch") ? ["p.acq_touch"] : []),
      ...(has("players.standalone_at") ? ["p.standalone_at"] : []),
      ...(EXPERIMENTS_FROM !== null ? ["p.public_id"] : []),
    ];
    const extra = extraCols.map((c) => `, ${c}`).join("");
    const cohort = `
      c AS (
        SELECT p.id, p.created_ip_hash, p.acq_landing, p.acq_referrer, p.acq_utm_source, p.acq_ua_class${extra}, min(d.day) AS day0
          FROM ${s}.players p JOIN ${s}.player_days d ON d.player_id = p.id
         WHERE p.legacy_user_id IS NULL
           AND coalesce(p.acq_ua_class, '') <> 'bot'
           AND p.switched_away_at IS NULL
           AND NOT (p.public_id::STRING = ANY($1::STRING[]))
         GROUP BY p.id, p.created_at, p.created_ip_hash, p.acq_landing, p.acq_referrer, p.acq_utm_source, p.acq_ua_class${extra}
        HAVING min(d.day) >= $2::DATE AND p.created_at >= min(d.day)::TIMESTAMPTZ - INTERVAL '2 days'
      )`;
    const params = [internal, LOCAL_DAYS_FROM];
    const optional = [
      has("players.acq_touch") ? "k.acq_touch AS touch" : "NULL::BOOL AS touch",
      has("players.standalone_at") ? "k.standalone_at IS NOT NULL AS standalone" : "NULL::BOOL AS standalone",
      timing ? "CASE WHEN d0.first_at IS NULL THEN NULL ELSE d0.active_secs END AS active_secs0" : "NULL::INT4 AS active_secs0",
      timing ? "CASE WHEN d0.first_at IS NULL THEN NULL ELSE d0.sessions END AS sessions0" : "NULL::INT4 AS sessions0",
      ...EXPERIMENTS.map((e) => (EXPERIMENTS_FROM !== null ? `substr(k.public_id::STRING, ${e.index + 1}, 1) AS arm_${e.name}` : `NULL::STRING AS arm_${e.name}`)),
    ];
    type FeatureRow = {
      day0: string; landing: string | null; referrer: string | null; utm_source: string | null; platform: string | null;
      csize: number; activated: boolean; challenge_d0: boolean; combines0: number; ret: number[];
      touch: boolean | null; standalone: boolean | null; active_secs0: number | null; sessions0: number | null;
    } & Record<string, unknown>;
    const features = await query<FeatureRow>(
      `WITH ${cohort}, k AS (
         SELECT c.*, count(*) OVER (PARTITION BY coalesce(c.created_ip_hash, c.id::STRING), c.day0) AS csize FROM c
       )
       SELECT k.day0::STRING AS day0, k.acq_landing AS landing, k.acq_referrer AS referrer, k.acq_utm_source AS utm_source,
              k.acq_ua_class AS platform, k.csize::INT4 AS csize,
              EXISTS (SELECT 1 FROM ${s}.discoveries x WHERE x.player_id = k.id AND x.source = 'combine') AS activated,
              EXISTS (SELECT 1 FROM ${s}.challenge_completions x WHERE x.player_id = k.id AND x.day = k.day0 AND x.source = 'live') AS challenge_d0,
              coalesce(d0.combines, 0)::INT4 AS combines0,
              ARRAY(SELECT (x.day - k.day0)::INT4 FROM ${s}.player_days x
                     WHERE x.player_id = k.id AND x.day > k.day0 AND x.day <= k.day0 + ${RETURN_HORIZON} ORDER BY x.day) AS ret,
              ${optional.join(",\n              ")}
         FROM k LEFT JOIN ${s}.player_days d0 ON d0.player_id = k.id AND d0.day = k.day0`,
      params,
    );
    const players: CohortPlayer[] = features.map((r) => ({
      day0: r.day0,
      landing: r.landing,
      referrer: r.referrer,
      utmSource: r.utm_source,
      platform: r.platform,
      csize: Number(r.csize),
      activated: r.activated,
      challengeD0: r.challenge_d0,
      combines0: Number(r.combines0),
      ret: (r.ret ?? []).map(Number),
      touch: r.touch,
      standalone: r.standalone,
      activeSecs0: r.active_secs0 == null ? null : Number(r.active_secs0),
      sessions0: r.sessions0 == null ? null : Number(r.sessions0),
      ...(EXPERIMENTS_FROM !== null ? { arms: Object.fromEntries(EXPERIMENTS.map((e) => [e.name, armOf(String(r[`arm_${e.name}`]))])) } : {}),
    }));
    const sections = cohortSections(players, today);
    for (const [name, rows] of Object.entries(sections)) show(name, rows);
    if (!timing) {
      for (const n of ["day0_active_minutes", "day0_sessions", "day0_timing_summary", "return_day_entry_mix"]) skip(n, "player_days.first_at/sessions/active_secs/entry not migrated yet (0009)");
    } else {
      if (!("day0_timing_summary" in sections)) skip("day0_timing_summary", "no cohort day-0 rows with timing yet");
      show(
        "return_day_entry_mix",
        await query(
          `WITH ${cohort} SELECT coalesce(d.entry, '(none)') AS entry, count(*) AS return_days, count(DISTINCT d.player_id) AS players
             FROM c JOIN ${s}.player_days d ON d.player_id = c.id AND d.day > c.day0
            WHERE d.first_at IS NOT NULL GROUP BY 1 ORDER BY 2 DESC`,
          params,
        ),
      );
    }
    if (!has("players.acq_touch")) skip("by_device_touch", "players.acq_touch not migrated yet (0009)");
    else if (!("by_device_touch" in sections)) skip("by_device_touch", "no cohort players with acq_touch yet");
    if (EXPERIMENTS_FROM === null) skip("experiments", "EXPERIMENTS_FROM is null: no randomized arm is live");

    // Standalone (installed app) vs browser, for cohorts since standalone_at started recording.
    if (!has("players.standalone_at")) skip("standalone_retention", "players.standalone_at not migrated yet (0009)");
    else {
      const [first] = await query<{ d: string | null }>(`SELECT min(standalone_at)::DATE::STRING AS d FROM ${s}.players WHERE standalone_at IS NOT NULL`);
      if (!first?.d) skip("standalone_retention", "no standalone_at values yet");
      else {
        const since = first.d;
        const scored = players.filter((p) => p.day0 >= since).map((p) => score(p, today));
        show("standalone_retention", breakdown(scored, (p) => (p.standalone ? `standalone (day0 >= ${since})` : `browser (day0 >= ${since})`)));
      }
    }

    // Probable re-creation pool: networks with 5+ new players on the same day0 on 2+ days
    // (wiped school devices re-creating players?), and how many of those players ever came back.
    show(
      "probable_recreation_pool",
      (await query<Row>(
        `WITH ${cohort},
         cl AS (SELECT created_ip_hash AS ip, day0 FROM c WHERE created_ip_hash IS NOT NULL GROUP BY 1, 2 HAVING count(*) >= 5),
         ipd AS (SELECT ip, count(*) AS burst_days FROM cl GROUP BY 1),
         pl AS (
           SELECT c.created_ip_hash AS ip, c.acq_ua_class, ipd.burst_days,
                  EXISTS (SELECT 1 FROM ${s}.player_days x WHERE x.player_id = c.id AND x.day > c.day0) AS ever_returned
             FROM c JOIN cl ON cl.ip = c.created_ip_hash AND cl.day0 = c.day0 JOIN ipd ON ipd.ip = c.created_ip_hash
         )
         SELECT CASE WHEN burst_days >= 2 THEN 'repeat-burst network' ELSE 'single-burst network' END AS kind,
                coalesce(acq_ua_class, '(unknown)') AS platform,
                count(DISTINCT ip)::INT4 AS networks, count(*)::INT4 AS players, count(*) FILTER (WHERE ever_returned)::INT4 AS ever_returned
           FROM pl GROUP BY 1, 2 ORDER BY 1, 4 DESC`,
        params,
      )).map((r) => ({ ...r, ever_returned_pct: pct(Number(r.ever_returned), Number(r.players)) })),
    );

    const extraQueries: Record<string, string> = {
      excluded_by_day: `SELECT created_at::DATE::STRING AS day,
               count(*) FILTER (WHERE acq_ua_class = 'bot') AS bots,
               count(*) FILTER (WHERE switched_away_at IS NOT NULL) AS switched_away,
               count(*) FILTER (WHERE acq_ua_class IS NULL) AS no_platform
          FROM ${s}.players WHERE legacy_user_id IS NULL AND created_at >= $1::DATE - 1 GROUP BY 1 ORDER BY 1`,
      legacy_claims_by_day: `SELECT legacy_claimed_at::DATE::STRING AS day, count(*) AS claimed
          FROM ${s}.players WHERE legacy_claimed_at >= $1::DATE - 7 GROUP BY 1 ORDER BY 1`,
      // Bet E (a snapshot line now): legacy players active by local day and by week.
      legacy_activity_by_day: `SELECT d.day::STRING AS day, count(*) AS legacy_players, sum(d.combines) AS combines
          FROM ${s}.player_days d JOIN ${s}.players p ON p.id = d.player_id
         WHERE p.legacy_user_id IS NOT NULL AND d.day >= $1::DATE GROUP BY 1 ORDER BY 1`,
      legacy_active_by_week: `SELECT (d.day - (extract(dow FROM d.day)::INT + 6) % 7)::STRING AS week,
               count(DISTINCT d.player_id) AS legacy_players, sum(d.combines) AS combines
          FROM ${s}.player_days d JOIN ${s}.players p ON p.id = d.player_id
         WHERE p.legacy_user_id IS NOT NULL AND d.day >= $1::DATE GROUP BY 1 ORDER BY 1`,
      daily_activity: `SELECT d.day::STRING AS day, count(*) AS players, sum(d.loads) AS loads, sum(d.combines) AS combines
          FROM ${s}.player_days d WHERE d.day >= $1::DATE GROUP BY 1 ORDER BY 1`,
    };
    for (const [name, sql] of Object.entries(extraQueries)) show(name, await query(sql, [LOCAL_DAYS_FROM]));

    // Budgets (contract C2: global budget rows are kept 90 days past their window).
    const budgetRows = (await query<{ key: string; count: string; expires_at: Date }>(
      `SELECT key, count, expires_at FROM ${s}.counters WHERE key LIKE 'rl:budget.%'`,
    ))
      .map((r) => parseBudgetRow(r.key, Number(r.count), r.expires_at.getTime()))
      .filter((r): r is BudgetRow => r !== null);
    for (const [name, rows] of Object.entries(budgetSections(budgetRows, nowMs))) show(name, rows);
    const [art] = await query<{ attempts: string }>(`SELECT coalesce(sum(image_attempts), 0)::INT8 AS attempts FROM ${s}.elements`);
    const prev = previousSnapshot(out)?.phantom_check as Parameters<typeof phantomCheck>[2] | undefined;
    const month = budgetRows.find((r) => r.rule === "budget.image.month" && r.index === Math.floor(nowMs / r.windowMs));
    show("phantom_check", phantomCheck(month, Number(art?.attempts ?? 0), prev && typeof prev === "object" && "monthly_counter" in prev ? prev : undefined, nowMs));

    // Server daily stats (contract C1). PoW and boot-abandon families arrive later; empty until then.
    const stats = await query<{ key: string; count: string }>(`SELECT key, count FROM ${s}.counters WHERE key LIKE 'stat:%'`);
    const statOut = statSections(stats.map((r) => ({ key: r.key, count: Number(r.count) })), nowMs);
    for (const [name, rows] of Object.entries(statOut)) {
      if (rows.length === 0) skip(name, "no stat rows of this family in the last 30 days");
      else show(name, rows);
    }

    // Art coverage: new elements (all are world-firsts) painted within 1 h of creation, and all
    // fresh discoveries whose element had art within 1 h of the discovery, by UTC half-day. Rows
    // younger than an hour are left out: they can't have passed yet, so the latest half-day
    // would read low.
    if (!has("elements.image_ready_at")) skip("art_coverage_1h", "elements.image_ready_at not migrated yet (0008)");
    else {
      const [first] = await query<{ d: string | null }>(`SELECT (min(image_ready_at)::DATE + 1)::STRING AS d FROM ${s}.elements WHERE image_ready_at IS NOT NULL`);
      if (!first?.d) skip("art_coverage_1h", "no image_ready_at values yet");
      else {
        // The first full UTC day after image_ready_at started recording: art with a NULL
        // image_ready_at but status 'ready' was painted before it, so before these discoveries.
        const since = first.d;
        const wf = await query<{ day: string; half: string; n: string; y: string }>(
          `SELECT created_at::DATE::STRING AS day, CASE WHEN extract(hour FROM created_at) < 12 THEN 'am' ELSE 'pm' END AS half,
                  count(*) AS n, count(*) FILTER (WHERE image_ready_at <= created_at + INTERVAL '1 hour') AS y
             FROM ${s}.elements
            WHERE source = 'llm' AND discovered_by IS NOT NULL AND created_at >= $1::DATE AND created_at >= now() - INTERVAL '30 days'
              AND created_at < now() - INTERVAL '1 hour'
            GROUP BY 1, 2`,
          [since],
        );
        const disc = await query<{ day: string; half: string; n: string; y: string }>(
          `SELECT x.discovered_at::DATE::STRING AS day, CASE WHEN extract(hour FROM x.discovered_at) < 12 THEN 'am' ELSE 'pm' END AS half,
                  count(*) AS n,
                  count(*) FILTER (WHERE e.image_status = 'ready' AND (e.image_ready_at IS NULL OR e.image_ready_at <= x.discovered_at + INTERVAL '1 hour')) AS y
             FROM ${s}.discoveries x JOIN ${s}.elements e ON e.id = x.element_id
            WHERE x.source = 'combine' AND x.discovered_at >= $1::DATE AND x.discovered_at >= now() - INTERVAL '30 days'
              AND x.discovered_at < now() - INTERVAL '1 hour'
            GROUP BY 1, 2`,
          [since],
        );
        show("art_coverage_1h", artCoverageRows(wf, disc));
      }
    }

    // Player reports (contract C5): element names only, never who reported.
    if (!hasReports) skip("top_reported_elements", "element_reports not migrated yet (0009)");
    else {
      show(
        "top_reported_elements",
        (await query<{ name: string; status: string; reports: string; last_7d: string; last_report: string; reasons: (string | null)[] }>(
          `SELECT e.name, e.status, count(*) AS reports, count(*) FILTER (WHERE r.created_at >= now() - INTERVAL '7 days') AS last_7d,
                  max(r.created_at)::DATE::STRING AS last_report, array_agg(DISTINCT coalesce(r.reason, '(none)')) AS reasons
             FROM ${s}.element_reports r JOIN ${s}.elements e ON e.id = r.element_id
            GROUP BY e.id, e.name, e.status ORDER BY 3 DESC, 1 LIMIT 25`,
        )).map((r) => ({ name: r.name, status: r.status, reports: Number(r.reports), last_7d: Number(r.last_7d), last_report: r.last_report, reasons: r.reasons.join(", ") })),
      );
    }
  } finally {
    db.release();
    await pool.end();
  }
  fs.mkdirSync(out, { recursive: true });
  fs.writeFileSync(path.join(out, "db_snapshot.json"), JSON.stringify(result, null, 1));
  console.log(`\nwrote ${path.join(out, "db_snapshot.json")}`);
}

/** Pivot per-day half-day counts into coverage rows (am = 00-11 UTC, pm = 12-23 UTC). */
export function artCoverageRows(
  worldFirsts: readonly { day: string; half: string; n: string | number; y: string | number }[],
  discoveries: readonly { day: string; half: string; n: string | number; y: string | number }[],
): Row[] {
  const days = new Map<string, Record<string, { n: number; y: number }>>();
  const add = (prefix: string, rows: typeof worldFirsts) => {
    for (const r of rows) {
      const d = days.get(r.day) ?? {};
      d[`${prefix}_${r.half}`] = { n: Number(r.n), y: Number(r.y) };
      days.set(r.day, d);
    }
  };
  add("wf", worldFirsts);
  add("disc", discoveries);
  return [...days]
    .sort(([a], [b]) => (a < b ? -1 : 1))
    .map(([day, d]) => {
      const cell = (k: string) => d[k] ?? { n: 0, y: 0 };
      const both = (p: string) => ({ n: cell(`${p}_am`).n + cell(`${p}_pm`).n, y: cell(`${p}_am`).y + cell(`${p}_pm`).y });
      const wf = both("wf");
      const disc = both("disc");
      return {
        day,
        wf_n: wf.n,
        wf_1h_pct: pct(wf.y, wf.n),
        wf_00_11_pct: pct(cell("wf_am").y, cell("wf_am").n),
        wf_12_23_pct: pct(cell("wf_pm").y, cell("wf_pm").n),
        disc_n: disc.n,
        disc_1h_pct: pct(disc.y, disc.n),
        disc_00_11_pct: pct(cell("disc_am").y, cell("disc_am").n),
        disc_12_23_pct: pct(cell("disc_pm").y, cell("disc_pm").n),
      };
    });
}

if (isMain(import.meta.url)) runMain(main);
