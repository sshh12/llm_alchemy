// Daily challenges: day resolution, the (immutable) per-day targets, completions and streaks.
import type { ChallengeHistoryDay, ChallengeTarget, DailyChallengeDTO, Tier, TomorrowTeaser } from "../../src/shared/api.ts";
import { addDays, isPlausibleClientDay, utcDay } from "../../src/shared/dates.ts";
import { q, t, type Queryable } from "../db.ts";
import { ELEMENT_COLS, toElementDTO, type ElementRow } from "./dto.ts";

export const TIERS: readonly Tier[] = ["easy", "hard", "expert"];

/** The player's day if it is a real local date somewhere on Earth right now, else today in UTC. */
export function resolveDay(clientDate: string | undefined, now = new Date()): string {
  return clientDate && isPlausibleClientDay(clientDate, now) ? clientDate : utcDay(now);
}

/** Every calendar day that is "today" in some timezone right now (UTC-12 .. UTC+14). */
export function plausibleDays(now = new Date()): string[] {
  const first = utcDay(new Date(now.getTime() - 12 * 3_600_000));
  const last = utcDay(new Date(now.getTime() + 14 * 3_600_000));
  const days: string[] = [];
  for (let d = first; d <= last; d = addDays(d, 1)) days.push(d);
  return days;
}

export interface ChallengeRow {
  day: string;
  easy_id: string;
  hard_id: string;
  expert_id: string;
  easy_steps: number | null;
  hard_steps: number | null;
  expert_steps: number | null;
}

const targetId = (c: ChallengeRow, tier: Tier): string => c[`${tier}_id` as const];

// Challenge rows never change once written, so cache them per instance (misses are cached briefly).
const CACHE_TTL_MS = 10 * 60_000;
const cache = new Map<string, { row: ChallengeRow | null; until: number }>();

export async function getChallenge(day: string): Promise<ChallengeRow | null> {
  const hitRow = cache.get(day);
  if (hitRow && hitRow.until > Date.now()) return hitRow.row;
  const rows = await q<ChallengeRow>(
    `SELECT day, easy_id, hard_id, expert_id, easy_steps, hard_steps, expert_steps
       FROM ${t("challenges")} WHERE day = $1`,
    [day],
  );
  const row = rows[0] ?? null;
  if (cache.size > 64) cache.clear();
  cache.set(day, { row, until: Date.now() + (row ? CACHE_TTL_MS : 60_000) });
  return row;
}

/** Tiers whose target is `elementId` (normally zero or one). */
export function tiersFor(c: ChallengeRow, elementId: string): Tier[] {
  return TIERS.filter((tier) => targetId(c, tier) === elementId);
}

/**
 * Whether `elementId` is a target of a challenge that is "today" somewhere (cached rows): players
 * may ask for its art and report it without owning it.
 */
export async function isTodayTarget(elementId: string, now = new Date()): Promise<boolean> {
  const challenges = await Promise.all(plausibleDays(now).map(getChallenge));
  return challenges.some((c) => c != null && tiersFor(c, elementId).length > 0);
}

/** Record completions for any target produced by a combine; returns the newly completed tiers. */
export async function completeTiers(playerId: string, day: string, resultId: string, client?: Queryable): Promise<Tier[]> {
  const c = await getChallenge(day);
  const tiers = c ? tiersFor(c, resultId) : [];
  if (tiers.length === 0) return [];
  const rows = await q<{ tier: Tier }>(
    `INSERT INTO ${t("challenge_completions")} (player_id, day, tier, source)
     SELECT $1, $2, tier, 'live' FROM unnest($3::STRING[]) AS u(tier)
     ON CONFLICT (player_id, day, tier) DO NOTHING
     RETURNING tier`,
    [playerId, day, tiers],
    client,
  );
  return TIERS.filter((tier) => rows.some((r) => r.tier === tier));
}

/**
 * The teaser for a day's easy target: its art only when ready, and its name's length without
 * spaces. Nothing that names it (no name, no id). Exported for tests.
 */
export function teaserFor(row: ElementRow): TomorrowTeaser {
  return { img: toElementDTO(row).img, letters: [...row.name.replace(/\s+/g, "")].length };
}

export interface DailyChallenges {
  challenge: DailyChallengeDTO | null;
  /** Tomorrow's (day + 1) easy target as a teaser, or null without a row for that day. */
  tomorrow: TomorrowTeaser | null;
}

/**
 * Today's challenge and tomorrow's teaser for the bootstrap response, in the same two queries
 * today's challenge alone took (challenge rows are cached; element rows are read fresh so art
 * state is current).
 */
export async function dailyChallenges(playerId: string, day: string): Promise<DailyChallenges> {
  const [c, next] = await Promise.all([getChallenge(day), getChallenge(addDays(day, 1))]);
  const ids = [...(c ? TIERS.map((tier) => targetId(c, tier)) : []), ...(next ? [next.easy_id] : [])];
  if (ids.length === 0) return { challenge: null, tomorrow: null };
  const [elements, done] = await Promise.all([
    q<ElementRow>(`SELECT ${ELEMENT_COLS} FROM ${t("elements")} e WHERE e.id = ANY($1::INT8[])`, [ids]),
    c
      ? q<{ tier: Tier }>(`SELECT tier FROM ${t("challenge_completions")} WHERE player_id = $1 AND day = $2`, [playerId, day])
      : Promise.resolve([]),
  ]);
  const teaser = next ? elements.find((e) => e.id === next.easy_id) : undefined;
  return { challenge: c ? toChallenge(c, day, elements, done) : null, tomorrow: teaser ? teaserFor(teaser) : null };
}

function toChallenge(c: ChallengeRow, day: string, elements: readonly ElementRow[], done: readonly { tier: Tier }[]): DailyChallengeDTO | null {
  const targets: ChallengeTarget[] = [];
  for (const tier of TIERS) {
    const el = elements.find((e) => e.id === targetId(c, tier));
    if (!el) return null; // dangling target: treat the day as having no challenge
    targets.push({
      tier,
      element: toElementDTO(el),
      steps: c[`${tier}_steps` as const],
      completed: done.some((d) => d.tier === tier),
    });
  }
  return { day, targets };
}

/** Today's challenge alone (see dailyChallenges). */
export async function dailyChallenge(playerId: string, day: string): Promise<DailyChallengeDTO | null> {
  return (await dailyChallenges(playerId, day)).challenge;
}

/**
 * Streaks over days with ≥1 completion. `current` counts the run ending today, or ending
 * yesterday if today is not done yet (the streak is still alive until the day is over).
 */
export function computeStreak(days: readonly string[], today: string): { current: number; best: number } {
  const sorted = [...new Set(days)].sort();
  let best = 0;
  let run = 0;
  let prev: string | null = null;
  for (const d of sorted) {
    run = prev !== null && addDays(prev, 1) === d ? run + 1 : 1;
    best = Math.max(best, run);
    prev = d;
  }
  const alive = prev !== null && prev >= addDays(today, -1);
  return { current: alive ? run : 0, best };
}

/** Most days of history returned (newest first); streaks always use the full set. */
const HISTORY_LIMIT = 1_000;

export interface PlayerChallengeStats {
  history: ChallengeHistoryDay[];
  completed: number;
  streak: { current: number; best: number };
}

export async function challengeStats(playerId: string, today: string): Promise<PlayerChallengeStats> {
  const rows = await q<{ day: string; tier: Tier; easy: string; hard: string; expert: string }>(
    `SELECT cc.day, cc.tier, ee.name AS easy, he.name AS hard, xe.name AS expert
       FROM ${t("challenge_completions")} cc
       JOIN ${t("challenges")} c ON c.day = cc.day
       LEFT JOIN ${t("elements")} ee ON ee.id = c.easy_id
       LEFT JOIN ${t("elements")} he ON he.id = c.hard_id
       LEFT JOIN ${t("elements")} xe ON xe.id = c.expert_id
      WHERE cc.player_id = $1
      ORDER BY cc.day DESC`,
    [playerId],
  );
  const byDay = new Map<string, ChallengeHistoryDay>();
  for (const r of rows) {
    let day = byDay.get(r.day);
    if (!day) {
      day = { day: r.day, completed: [], names: { easy: r.easy ?? "", hard: r.hard ?? "", expert: r.expert ?? "" } };
      byDay.set(r.day, day);
    }
    day.completed.push(r.tier);
  }
  for (const day of byDay.values()) day.completed = TIERS.filter((tier) => day.completed.includes(tier));
  return {
    history: [...byDay.values()].slice(0, HISTORY_LIMIT),
    completed: rows.length,
    streak: computeStreak([...byDay.keys()], today),
  };
}
