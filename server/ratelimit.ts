// App-level fixed-window rate limits and global budgets, stored in <schema>.counters.
// Netlify's platform rules (90 combine / 60 image requests per IP per minute) sit in front
// of these; these add per-player limits, longer windows and money budgets.
//
// A request "hits" several limits at once with ONE multi-row upsert statement (single
// round trip, retried server-side by CockroachDB), in two stages:
//   1. Per-player/per-IP limits are charged and checked. If one is over, only the violated
//      rule(s) keep this charge and every other local counter of the hit is refunded, so
//      hammering keeps you limited on the rule you broke, but a 1-minute throttle never turns
//      into an hour or day lock (and one fast student never eats the class's per-IP budget).
//      Global budgets are not touched.
//   2. Global budgets are charged only once those pass (a second round trip, only where a
//      request carries both: new recipes, image generations and sorts). If a budget is over,
//      every counter of the hit (budgets and locals) is refunded: the request was not served.
// So counters count served requests, plus the rejected attempts on the rule that rejected
// them. Refunds are one decrement statement, on the denial path only; every denial also bumps
// the daily stat "denied:<rule>" (bumpStat). Rows expire via row-level TTL.
//
// Limits (subject = player id or keyed hash of the client /64 or IPv4 address):
//
// | Rule                    | Subject | Limit     | Window | Rationale                                                  |
// |-------------------------|---------|-----------|--------|------------------------------------------------------------|
// | bootstrap.ip            | ip      | 600       | 1 h    | one call per page load; a 30-seat classroom behind one NAT |
// | create.ip               | ip      | 60        | 1 h    | new players (also PoW-gated); a classroom twice over       |
// | create.ip.day           | ip      | 300       | 1 d    |                                                            |
// | adopt.ip                | ip      | 10        | 1 h    | legacy adoption: ids were public (2023 creator ids), so    |
// |                         |         |           |        | adopt-once is the defense; this only slows mass claiming   |
// | combine.player          | player  | 60        | 1 min  | humans manage ~10-30/min; bots go much faster              |
// | combine.player.hour     | player  | 1,500     | 1 h    |                                                            |
// | combine.ip.hour         | ip      | 20,000    | 1 h    | backstop if the platform rule is missing                   |
// | llm.player              | player  | 40        | 1 min  | brand-new recipes only (each one is an LLM call); at 20,   |
// |                         |         |           |        | 160+ students sat at exactly the cap (2026-11)             |
// | llm.player.hour         | player  | 600       | 1 h    |                                                            |
// | llm.player.day          | player  | 1,500     | 1 d    | ~1 player-day/day reaches it; the per-player cost backstop |
// | llm.ip.hour             | ip      | 8,000     | 1 h    | a school behind one IP: a class makes ~125-150 LLM/min     |
// | llm.ip.day              | ip      | 25,000    | 1 d    | the largest iPad school used 70-81% of the old 6,000       |
// | image.player.hour       | player  | 30        | 1 h    | generations actually started (not polls, not ready art,    |
// | image.player.day        | player  | 60        | 1 d    | not deferrals); fairness: the top 10 made 69% of requests  |
// | image.backlog.player.day| player  | 20        | 1 d    | backlog-lane art only (not discovered in the last 20 min)  |
// | image.ip.hour           | ip      | 300       | 1 h    | binds a classroom first: ~11 starts per seat per hour for  |
// |                         |         |           |        | 26 seats on one IP, below image.player.hour                |
// | image.ip.day            | ip      | 1,500     | 1 d    | 25 seats x image.player.day 60                             |
// | reset.player            | player  | 10        | 1 h    |                                                            |
// | transfer.player         | player  | 30        | 1 h    |                                                            |
// | redeem.ip               | ip      | 30        | 1 h    | codes are HMAC-signed; this only caps lookups              |
// | sort.player             | player  | 40        | 1 min  | /api/sort requests; has no platform rule (both are used),  |
// | sort.player.hour        | player  | 400       | 1 h    | so these are the only gate; the client batches discoveries |
// | sort.ip.hour            | ip      | 4,000     | 1 h    | classroom backstop                                         |
// | sort.items.player.hour  | player  | 50,000    | 1 h    | cost = Jev questions (rank 1, groups 2 per element):       |
// | sort.items.player.day   | player  | 150,000   | 1 d    | ~2 full re-sorts of a 25k library per hour; one player     |
// |                         |         |           |        | used 431k of a day's 523k questions (2026-11-22)           |
// | sort.items.ip.hour      | ip      | 400,000   | 1 h    |                                                            |
// | sort.items.ip.day       | ip      | 1,000,000 | 1 d    |                                                            |
// | report.player           | player  | 20        | 1 d    | "Report this element"; duplicates are already ignored      |
// | beacon.ip               | ip      | 120       | 1 h    | boot-abandon beacons: one per hide before the game is      |
// |                         |         |           |        | ready, plus its take-back if the page comes back, so a     |
// |                         |         |           |        | classroom behind one NAT stays far below it                |
//
// Global budgets (all players): new recipes LLM_DAILY_CAP (100,000/UTC day ≈ $10), images
// IMAGE_DAILY_CAP (2,000/UTC day ≈ $10.60), new players PLAYER_DAILY_CAP (20,000/UTC day), and
// IMAGE_MONTHLY_CAP (40,000 per 30-day window ≈ $212, the art budget; see server/env.ts).
// Custom-sort scoring JEV_DAILY_CAP (2,500,000 Jev
// questions/UTC day ≈ $10-13), charged by /api/sort and by the sort score /api/combine
// piggybacks on a discovery; when it runs out only custom sorting stops.
//
// The two image budgets are PACED (imageBudgets): the allowance rises through the window, so
// art spending is smoothed over the day (weighted by when players discover things) and over the
// 30-day window (linear accrual) instead of being spent by mid-morning or mid-month. A request
// over pace is deferred, not failed: the tile keeps its emoji placeholder and asks again later.
import type { ArtLane } from "../src/shared/api.ts";
import { q, t } from "./db.ts";
import { env } from "./env.ts";
import { errors } from "./http.ts";

export interface Limit {
  name: string;
  limit: number;
  windowMs: number;
  /**
   * Paced budget: how much of `limit` may be used by `nowMs` (rising through the window, never
   * above `limit`). The counter is keyed by `name` alone, so paced variants of one budget (the
   * art lanes) share it.
   */
  allowance?: (nowMs: number) => number;
}

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
/** Global budget rows and daily stats are kept this long past their window, as history. */
const HISTORY_MS = 90 * DAY;
/** Shortest retry hint for a paced denial (the allowance grows continuously). */
const PACE_MIN_RETRY_MS = MIN;

const rule = (name: string, limit: number, windowMs: number): Limit => ({ name, limit, windowMs });

export const LIMITS = {
  bootstrapIp: rule("bootstrap.ip", 600, HOUR),
  // CREATE_IP_HOURLY lets the e2e environment (one IP, ~60 players per full run) raise this.
  createIp: rule("create.ip", Number(process.env.CREATE_IP_HOURLY) || 60, HOUR),
  createIpDay: rule("create.ip.day", 300, DAY),
  adoptIp: rule("adopt.ip", 10, HOUR),
  combinePlayer: rule("combine.player", 60, MIN),
  combinePlayerHour: rule("combine.player.hour", 1_500, HOUR),
  combineIpHour: rule("combine.ip.hour", 20_000, HOUR),
  llmPlayer: rule("llm.player", 40, MIN),
  llmPlayerHour: rule("llm.player.hour", 600, HOUR),
  llmPlayerDay: rule("llm.player.day", 1_500, DAY),
  llmIpHour: rule("llm.ip.hour", 8_000, HOUR),
  llmIpDay: rule("llm.ip.day", 25_000, DAY),
  imagePlayerHour: rule("image.player.hour", 30, HOUR),
  imagePlayerDay: rule("image.player.day", 60, DAY),
  /** Charged only for backlog-lane generations (server/game/images.ts). */
  imageBacklogPlayerDay: rule("image.backlog.player.day", 20, DAY),
  imageIpHour: rule("image.ip.hour", 300, HOUR),
  imageIpDay: rule("image.ip.day", 1_500, DAY),
  resetPlayer: rule("reset.player", 10, HOUR),
  transferPlayer: rule("transfer.player", 30, HOUR),
  redeemIp: rule("redeem.ip", 30, HOUR),
  // Custom library sort. Request counts are charged up front; the items limits are charged
  // with cost = Jev questions once the owned elements are loaded.
  sortPlayer: rule("sort.player", 40, MIN),
  sortPlayerHour: rule("sort.player.hour", 400, HOUR),
  sortIpHour: rule("sort.ip.hour", 4_000, HOUR),
  sortItemsPlayerHour: rule("sort.items.player.hour", 50_000, HOUR),
  sortItemsPlayerDay: rule("sort.items.player.day", 150_000, DAY),
  sortItemsIpHour: rule("sort.items.ip.hour", 400_000, HOUR),
  sortItemsIpDay: rule("sort.items.ip.day", 1_000_000, DAY),
  reportPlayer: rule("report.player", 20, DAY),
  beaconIp: rule("beacon.ip", 120, HOUR),
} satisfies Record<string, Limit>;

/** Global budgets, read lazily so env overrides apply. Subject is always "all". */
export const BUDGETS = {
  get llm() {
    return rule("budget.llm", env.llmDailyCap, DAY);
  },
  /** Un-paced; image generations charge the paced variants from imageBudgets(lane). */
  get image() {
    return rule("budget.image", env.imageDailyCap, DAY);
  },
  get players() {
    return rule("budget.players", env.playerDailyCap, DAY);
  },
  /** Un-paced; see imageBudgets(lane). */
  get imageMonth() {
    return rule("budget.image.month", env.imageMonthlyCap, 30 * DAY);
  },
  /** Jev questions (custom library sort), charged with `cost`. */
  get jev() {
    return rule("budget.jev", env.jevDailyCap, DAY);
  },
};

// ---------------------------------------------------------------- art pacing

/**
 * Weekday share (%) of world-first discoveries by UTC hour, 0..23 (GA, 2026-11-16..20; sums to
 * 100). US school hours (13-21 UTC) hold about two thirds of them.
 */
const ART_HOURLY_SHARE = [
  3.0, 4.1, 4.0, 3.4, 2.8, 1.8, 1.5, 1.8, 1.0, 1.6, 1.2, 1.8, 3.0, 5.0, 6.3, 10.0, 7.9, 7.0, 6.5, 7.8, 9.6, 4.5, 1.8, 2.6,
];
const ART_CDF = (() => {
  const total = ART_HOURLY_SHARE.reduce((a, b) => a + b, 0);
  const cdf = [0];
  for (const s of ART_HOURLY_SHARE) cdf.push(cdf[cdf.length - 1]! + s / total);
  cdf[24] = 1;
  return cdf;
})();

/** Share (0..1) of a UTC day's discoveries made by `nowMs`, linear within each hour. */
export function dayTrafficShare(nowMs: number): number {
  const hours = (((nowMs % DAY) + DAY) % DAY) / HOUR;
  const h = Math.min(23, Math.floor(hours));
  return ART_CDF[h]! + (ART_CDF[h + 1]! - ART_CDF[h]!) * (hours - h);
}

/**
 * How far ahead of (or behind) pace each art lane (ArtLane, server/game/images.ts) may spend.
 * Fresh art may run 10% of the daily cap and one day of monthly accrual ahead of pace; backlog
 * only spends while spending is at least 5% of the daily cap behind pace, so it fills quiet
 * hours and never crowds out fresh results.
 */
export const ART_PACE: Record<ArtLane, { dayLead: number; monthLeadMs: number }> = {
  fresh: { dayLead: 0.1, monthLeadMs: DAY },
  backlog: { dayLead: -0.05, monthLeadMs: 0 },
};

const clamp01 = (x: number) => Math.min(1, Math.max(0, x));

/**
 * The image budgets as `lane` sees them: the same counters as BUDGETS.image and
 * BUDGETS.imageMonth, with paced allowances.
 *   daily:   cap × min(1, dayTrafficShare(t) + dayLead)
 *   monthly: cap × min(1, (elapsed in the 30-day window + monthLead) / 30 days)
 * A cap change mid-window (IMAGE_MONTHLY_CAP) moves the whole accrual line at once.
 */
export function imageBudgets(lane: ArtLane): Limit[] {
  const { dayLead, monthLeadMs } = ART_PACE[lane];
  const day = BUDGETS.image;
  const month = BUDGETS.imageMonth;
  return [
    { ...day, allowance: (nowMs) => day.limit * clamp01(dayTrafficShare(nowMs) + dayLead) },
    {
      ...month,
      allowance: (nowMs) =>
        month.limit * clamp01((nowMs - windowOf(nowMs, month.windowMs).startsAt + monthLeadMs) / month.windowMs),
    },
  ];
}

// ---------------------------------------------------------------- counting

export interface Hit {
  limit: Limit;
  subject: string;
  cost?: number;
}

/** `paced`: a paced budget is ahead of its pace (its cap itself is not spent yet). */
export type HitResult = { ok: true } | { ok: false; limit: Limit; retryAfterMs: number; paced?: true };

/** Fixed window containing `nowMs`. Windows are aligned to the Unix epoch (so daily = UTC days). */
export function windowOf(nowMs: number, windowMs: number): { index: number; startsAt: number; endsAt: number } {
  const index = Math.floor(nowMs / windowMs);
  return { index, startsAt: index * windowMs, endsAt: (index + 1) * windowMs };
}

export function counterKey(limit: Limit, subject: string, nowMs: number): string {
  return `rl:${limit.name}:${subject}:${windowOf(nowMs, limit.windowMs).index}`;
}

/** How much of `limit` may be used at `nowMs`. */
export const allowedAt = (limit: Limit, nowMs: number): number =>
  limit.allowance ? Math.min(limit.limit, limit.allowance(nowMs)) : limit.limit;

/**
 * When a paced limit's allowance first reaches `count` within the current window (it only grows
 * there), or the window end if it never does. Binary search to the second.
 */
function paceReachedAt(limit: Limit, count: number, nowMs: number): number {
  const { endsAt } = windowOf(nowMs, limit.windowMs);
  let hi = endsAt - 1;
  if (allowedAt(limit, hi) < count) return endsAt;
  let lo = nowMs;
  while (hi - lo > 1_000) {
    const mid = Math.floor((lo + hi) / 2);
    if (allowedAt(limit, mid) >= count) hi = mid;
    else lo = mid;
  }
  return hi;
}

interface Violation {
  hit: Hit;
  retryAfterMs: number;
  paced: boolean;
}

/** Every violated limit, given post-increment counts, with the time until a retry can pass. */
function violations(hits: Hit[], counts: Map<string, number>, nowMs: number): Violation[] {
  const out: Violation[] = [];
  for (const h of hits) {
    const count = counts.get(counterKey(h.limit, h.subject, nowMs)) ?? 0;
    if (count <= allowedAt(h.limit, nowMs)) continue;
    const { endsAt } = windowOf(nowMs, h.limit.windowMs);
    const paced = !!h.limit.allowance && count <= h.limit.limit;
    const retryAfterMs = paced
      ? Math.max(1_000, Math.min(endsAt - nowMs, Math.max(PACE_MIN_RETRY_MS, paceReachedAt(h.limit, count, nowMs) - nowMs)))
      : Math.max(1_000, endsAt - nowMs);
    out.push({ hit: h, retryAfterMs, paced });
  }
  return out;
}

const worstOf = (over: Violation[]): Violation => over.reduce((a, b) => (b.retryAfterMs > a.retryAfterMs ? b : a));

/**
 * Given post-increment counts, the violated limit with the longest wait (and that wait). A paced
 * limit's wait is the time until its allowance reaches the count (at least a minute, at most its
 * window end); anything else waits for its window to reset.
 */
export function evaluate(hits: Hit[], counts: Map<string, number>, nowMs: number): HitResult {
  const over = violations(hits, counts, nowMs);
  if (over.length === 0) return { ok: true };
  const w = worstOf(over);
  return { ok: false, limit: w.hit.limit, retryAfterMs: w.retryAfterMs, ...(w.paced ? { paced: true as const } : {}) };
}

export const isBudget = (l: Limit): boolean => l.name.startsWith("budget.");

/** Counter rows for `hits`: one per key, with summed costs. */
function rowsFor(hits: Hit[], nowMs: number): Map<string, { cost: number; expiresAt: string }> {
  const rows = new Map<string, { cost: number; expiresAt: string }>();
  for (const h of hits) {
    const key = counterKey(h.limit, h.subject, nowMs);
    // Keep a row a minute past its window so a slow TTL job never resets a live window; global
    // budgets are kept 90 days as spending history.
    const expiresAt = new Date(windowOf(nowMs, h.limit.windowMs).endsAt + (isBudget(h.limit) ? HISTORY_MS : MIN)).toISOString();
    const prev = rows.get(key);
    rows.set(key, { cost: (prev?.cost ?? 0) + (h.cost ?? 1), expiresAt });
  }
  return rows;
}

/**
 * Increment every counter of `hits` in one statement; returns the post-increment counts. An
 * existing row's expiry only ever moves later: a no-op for rows this code wrote (a key maps to
 * one expiry), and it gives budget rows written before the 90-day history (contract C2) their
 * history expiry on their next charge instead of losing them a minute after the window.
 */
async function charge(hits: Hit[], nowMs: number): Promise<Map<string, number>> {
  const rows = rowsFor(hits, nowMs);
  const keys = [...rows.keys()];
  const result = await q<{ key: string; count: string }>(
    `INSERT INTO ${t("counters")} AS c (key, count, expires_at)
     SELECT k, n, e FROM unnest($1::STRING[], $2::INT8[], $3::TIMESTAMPTZ[]) AS u(k, n, e)
     ON CONFLICT (key) DO UPDATE SET count = c.count + excluded.count, expires_at = greatest(c.expires_at, excluded.expires_at)
     RETURNING key, count`,
    [keys, keys.map((k) => rows.get(k)!.cost), keys.map((k) => rows.get(k)!.expiresAt)],
  );
  return new Map(result.map((r) => [r.key, Number(r.count)]));
}

/** Take back what `hits` charged (denial path only). Best-effort: a failed refund over-counts. */
async function refund(hits: Hit[], nowMs: number): Promise<void> {
  if (hits.length === 0) return;
  const rows = rowsFor(hits, nowMs);
  const keys = [...rows.keys()];
  try {
    await q(
      `UPDATE ${t("counters")} AS c SET count = c.count - u.n
         FROM unnest($1::STRING[], $2::INT8[]) AS u(k, n)
        WHERE c.key = u.k`,
      [keys, keys.map((k) => rows.get(k)!.cost)],
    );
  } catch (e) {
    console.warn("[ratelimit] refund failed", (e as Error).message);
  }
}

/** Report the worst violation, after refunding `give` and counting the denial. */
async function deny(over: Violation[], give: Hit[], nowMs: number): Promise<HitResult> {
  const w = worstOf(over);
  await Promise.all([refund(give, nowMs), bumpStat(`denied:${w.hit.limit.name}`, 1, nowMs)]);
  return { ok: false, limit: w.hit.limit, retryAfterMs: w.retryAfterMs, ...(w.paced ? { paced: true as const } : {}) };
}

/**
 * Charge the counters and report whether all limits still hold (see the header for the two
 * stages and their refunds). One statement when the hits are all local or all global, two when
 * mixed; a denial adds one refund and one stat statement, in parallel.
 */
export async function hit(hits: Hit[], nowMs = Date.now()): Promise<HitResult> {
  const local = hits.filter((h) => !isBudget(h.limit));
  const global = hits.filter((h) => isBudget(h.limit));
  if (local.length > 0) {
    const over = violations(local, await charge(local, nowMs), nowMs);
    if (over.length > 0) {
      const keep = new Set(over.map((v) => counterKey(v.hit.limit, v.hit.subject, nowMs)));
      return deny(over, local.filter((h) => !keep.has(counterKey(h.limit, h.subject, nowMs))), nowMs);
    }
  }
  if (global.length > 0) {
    const over = violations(global, await charge(global, nowMs), nowMs);
    if (over.length > 0) return deny(over, hits, nowMs);
  }
  return { ok: true };
}

/** `hit`, throwing 429 rate_limited (or 503 budget_exhausted for a global budget) naming the rule. */
export async function enforce(hits: Hit[], nowMs = Date.now()): Promise<void> {
  const r = await hit(hits, nowMs);
  if (r.ok) return;
  throw isBudget(r.limit) ? errors.budgetExhausted(r.retryAfterMs, r.limit.name) : errors.rateLimited(r.retryAfterMs, r.limit.name);
}

/**
 * Add `n` to the daily stat `name`: counters key `stat:<name>:<UTC day index>` (days since the
 * epoch), kept until 90 days after that day. Names: "denied:<rule>" (every limit/budget
 * denial), "fizzle:<reason>", "art:<lane>:<outcome>". Best-effort and never throws, so callers
 * can await it on any path without risking the request.
 */
export async function bumpStat(name: string, n = 1, nowMs = Date.now()): Promise<void> {
  const day = windowOf(nowMs, DAY);
  try {
    await q(
      `INSERT INTO ${t("counters")} AS c (key, count, expires_at) VALUES ($1, $2, $3)
       ON CONFLICT (key) DO UPDATE SET count = c.count + excluded.count`,
      [`stat:${name}:${day.index}`, n, new Date(day.endsAt + HISTORY_MS).toISOString()],
    );
  } catch (e) {
    console.warn("[stats] bump failed", name, (e as Error).message);
  }
}

/** Single-use token: true the first time `token` is seen within `ttlMs`. */
export async function consumeOnce(token: string, ttlMs: number, nowMs = Date.now()): Promise<boolean> {
  const rows = await q<{ count: string }>(
    `INSERT INTO ${t("counters")} AS c (key, count, expires_at) VALUES ($1, 1, $2)
     ON CONFLICT (key) DO UPDATE SET count = c.count + 1
     RETURNING count`,
    [`once:${token}`, new Date(nowMs + ttlMs).toISOString()],
  );
  return Number(rows[0]?.count) === 1;
}
