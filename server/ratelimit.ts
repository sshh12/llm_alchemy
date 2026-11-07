// App-level fixed-window rate limits and global daily budgets, stored in <schema>.counters.
// Netlify's platform rules (90 combine / 60 image requests per IP per minute) sit in front
// of these; these add per-player limits, longer windows and money budgets.
//
// A request "hits" several limits at once with ONE multi-row upsert statement (single
// round trip, retried server-side by CockroachDB). Rejected attempts still count, which
// is intentional: hammering keeps you limited. Rows expire via row-level TTL.
//
// Limits (subject = player id or keyed hash of the client /64 or IPv4 address):
//
// | Rule                 | Subject | Limit  | Window | Rationale                                                   |
// |----------------------|---------|--------|--------|-------------------------------------------------------------|
// | bootstrap.ip         | ip      | 600    | 1 h    | one call per page load; a 30-seat classroom behind one NAT |
// | create.ip            | ip      | 60     | 1 h    | new players (also PoW-gated); a classroom twice over        |
// | create.ip.day        | ip      | 300    | 1 d    |                                                             |
// | adopt.ip             | ip      | 60     | 1 h    | legacy adoption; ids are unguessable, this caps scanning    |
// | combine.player       | player  | 60     | 1 min  | humans manage ~10-30/min; bots go much faster              |
// | combine.player.hour  | player  | 1,500  | 1 h    |                                                             |
// | combine.ip.hour      | ip      | 20,000 | 1 h    | backstop if the platform rule is missing                    |
// | llm.player           | player  | 20     | 1 min  | brand-new recipes only (each one is an LLM call)            |
// | llm.player.hour      | player  | 300    | 1 h    |                                                             |
// | llm.player.day       | player  | 1,500  | 1 d    |                                                             |
// | llm.ip.hour          | ip      | 1,500  | 1 h    | classroom: 30 players x 50 new recipes/h                    |
// | llm.ip.day           | ip      | 6,000  | 1 d    |                                                             |
// | image.player.hour    | player  | 60     | 1 h    | generations actually started (not polls, not ready art)     |
// | image.player.day     | player  | 200    | 1 d    |                                                             |
// | image.ip.hour        | ip      | 300    | 1 h    |                                                             |
// | image.ip.day         | ip      | 1,000  | 1 d    |                                                             |
// | reset.player         | player  | 10     | 1 h    |                                                             |
// | transfer.player      | player  | 30     | 1 h    |                                                             |
// | redeem.ip            | ip      | 30     | 1 h    | codes are HMAC-signed; this only caps lookups               |
//
// Global budgets (all players): new recipes LLM_DAILY_CAP (100,000/UTC day ≈ $10), images
// IMAGE_DAILY_CAP (17,000/UTC day ≈ $90), new players PLAYER_DAILY_CAP (20,000/UTC day), and
// IMAGE_MONTHLY_CAP (20,000 per 30-day window) which keeps image generation inside the Netlify
// Starter plan's 100 function-hours/month.
import { q, t } from "./db.ts";
import { env } from "./env.ts";
import { errors } from "./http.ts";

export interface Limit {
  name: string;
  limit: number;
  windowMs: number;
}

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

const rule = (name: string, limit: number, windowMs: number): Limit => ({ name, limit, windowMs });

export const LIMITS = {
  bootstrapIp: rule("bootstrap.ip", 600, HOUR),
  createIp: rule("create.ip", 60, HOUR),
  createIpDay: rule("create.ip.day", 300, DAY),
  adoptIp: rule("adopt.ip", 60, HOUR),
  combinePlayer: rule("combine.player", 60, MIN),
  combinePlayerHour: rule("combine.player.hour", 1_500, HOUR),
  combineIpHour: rule("combine.ip.hour", 20_000, HOUR),
  llmPlayer: rule("llm.player", 20, MIN),
  llmPlayerHour: rule("llm.player.hour", 300, HOUR),
  llmPlayerDay: rule("llm.player.day", 1_500, DAY),
  llmIpHour: rule("llm.ip.hour", 1_500, HOUR),
  llmIpDay: rule("llm.ip.day", 6_000, DAY),
  imagePlayerHour: rule("image.player.hour", 60, HOUR),
  imagePlayerDay: rule("image.player.day", 200, DAY),
  imageIpHour: rule("image.ip.hour", 300, HOUR),
  imageIpDay: rule("image.ip.day", 1_000, DAY),
  resetPlayer: rule("reset.player", 10, HOUR),
  transferPlayer: rule("transfer.player", 30, HOUR),
  redeemIp: rule("redeem.ip", 30, HOUR),
} satisfies Record<string, Limit>;

/** Global daily budgets, read lazily so env overrides apply. Subject is always "all". */
export const BUDGETS = {
  get llm() {
    return rule("budget.llm", env.llmDailyCap, DAY);
  },
  get image() {
    return rule("budget.image", env.imageDailyCap, DAY);
  },
  get players() {
    return rule("budget.players", env.playerDailyCap, DAY);
  },
  get imageMonth() {
    return rule("budget.image.month", env.imageMonthlyCap, 30 * DAY);
  },
};

export interface Hit {
  limit: Limit;
  subject: string;
  cost?: number;
}

export type HitResult = { ok: true } | { ok: false; limit: Limit; retryAfterMs: number };

/** Fixed window containing `nowMs`. Windows are aligned to the Unix epoch (so daily = UTC days). */
export function windowOf(nowMs: number, windowMs: number): { index: number; startsAt: number; endsAt: number } {
  const index = Math.floor(nowMs / windowMs);
  return { index, startsAt: index * windowMs, endsAt: (index + 1) * windowMs };
}

export function counterKey(limit: Limit, subject: string, nowMs: number): string {
  return `rl:${limit.name}:${subject}:${windowOf(nowMs, limit.windowMs).index}`;
}

/** Given post-increment counts, the first violated limit (with time until its window resets). */
export function evaluate(hits: Hit[], counts: Map<string, number>, nowMs: number): HitResult {
  let worst: HitResult = { ok: true };
  for (const h of hits) {
    const count = counts.get(counterKey(h.limit, h.subject, nowMs)) ?? 0;
    if (count <= h.limit.limit) continue;
    const retryAfterMs = Math.max(1_000, windowOf(nowMs, h.limit.windowMs).endsAt - nowMs);
    if (worst.ok || retryAfterMs > worst.retryAfterMs) worst = { ok: false, limit: h.limit, retryAfterMs };
  }
  return worst;
}

/** Increment every counter in one statement and report whether all limits still hold. */
export async function hit(hits: Hit[], nowMs = Date.now()): Promise<HitResult> {
  if (hits.length === 0) return { ok: true };
  const rows = new Map<string, { cost: number; expiresAt: string }>();
  for (const h of hits) {
    const key = counterKey(h.limit, h.subject, nowMs);
    // Keep the row a minute past its window so a slow TTL job never resets a live window.
    const expiresAt = new Date(windowOf(nowMs, h.limit.windowMs).endsAt + MIN).toISOString();
    const prev = rows.get(key);
    rows.set(key, { cost: (prev?.cost ?? 0) + (h.cost ?? 1), expiresAt });
  }
  const keys = [...rows.keys()];
  const result = await q<{ key: string; count: string }>(
    `INSERT INTO ${t("counters")} AS c (key, count, expires_at)
     SELECT k, n, e FROM unnest($1::STRING[], $2::INT8[], $3::TIMESTAMPTZ[]) AS u(k, n, e)
     ON CONFLICT (key) DO UPDATE SET count = c.count + excluded.count
     RETURNING key, count`,
    [keys, keys.map((k) => rows.get(k)!.cost), keys.map((k) => rows.get(k)!.expiresAt)],
  );
  return evaluate(hits, new Map(result.map((r) => [r.key, Number(r.count)])), nowMs);
}

/** `hit`, throwing 429 rate_limited (or 503 budget_exhausted for a global budget) when over. */
export async function enforce(hits: Hit[], nowMs = Date.now()): Promise<void> {
  const r = await hit(hits, nowMs);
  if (r.ok) return;
  throw r.limit.name.startsWith("budget.") ? errors.budgetExhausted(r.retryAfterMs) : errors.rateLimited(r.retryAfterMs);
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
