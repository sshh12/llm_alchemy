// Reach: the share of recent v2 players who made an element ON THEIR OWN (through a combine,
// outside the days it was a challenge target). It is the main input of the daily-challenge
// difficulty model (scripts/lib/challengeModel.ts): the R1 fit, measure "r1".
//
// Cohort (at `asOf`): v2 players (legacy_user_id NULL), not bots, not switched away as of asOf,
// with at least one combine discovery before asOf, created in [asOf - 35d, asOf). Two views:
//   - "r1" (P0, what COEF_SELECT was fitted on): players created in [asOf - 28d, asOf);
//     reach = owners / (N28 · (1 - window share)).
//   - "r7" (fixed tenure, logged from day one; selection switches to it only through the offset
//     bridge in challengeModel.ts): players created in [asOf - 35d, asOf - 7d), counting what they
//     made within 7 days of creation; reach7 = owners7 / (N7 · (1 - window share7)).
// Target windows: for every day D an element was a target (any tier), its discoveries in
// [D 00:00 UTC, D + 36 h) do not count, and the denominator shrinks by the share of all cohort
// combine discoveries that fall inside those windows (capped at 0.9).
//
// loadReachInputs runs three read-only queries over the cohort's discoveries (~0.3M rows, a few
// seconds; discoveries is keyed by player_id, so the legacy libraries are never scanned).
// computeReach is the pure arithmetic (tested).
import type pg from "pg";
import { addDays } from "../../src/shared/dates.ts";
import { REACH_FLOOR } from "./challengeModel.ts";

export type ReachMode = "r1" | "r7";

export interface ReachInputs {
  /** ISO instant the measure is taken at (exclusive upper bound for discoveries). */
  asOf: string;
  /** Cohort sizes: N28 = created in [asOf-28d, asOf); N7 = created in [asOf-35d, asOf-7d). */
  n28: number;
  n7: number;
  /** Per element: cohort owners outside target windows (owners: 28-day cohort; owners7: N7 cohort within 7 days of creation). */
  owners: ReadonlyMap<string, { owners: number; owners7: number }>;
  /** Cohort combine discoveries per UTC hour ('YYYY-MM-DDTHH'), for the window shares. */
  hourly: ReadonlyMap<string, { n28: number; n7: number }>;
  /** Per element: the target days (any tier) whose 36 h window can overlap the cohort's discoveries. */
  windows: ReadonlyMap<string, readonly string[]>;
}

export interface Reach {
  asOf: string;
  mode: ReachMode;
  cohortN: number;
  cohortN7: number;
  /** r1 reach per element (floored at REACH_FLOOR, capped at 1); missing = REACH_FLOOR. */
  reach: ReadonlyMap<string, number>;
  /** Fixed-tenure reach7 per element (same treatment); missing = REACH_FLOOR. */
  reach7: ReadonlyMap<string, number>;
  /** Raw owner counts (for logging and shrinkage later). */
  owners: ReadonlyMap<string, number>;
}

export const WINDOW_HOURS = 36;
export const MAX_WINDOW_SHARE = 0.9;
export const COHORT_DAYS = 28;
export const R7_TENURE_DAYS = 7;

const hourKey = (ms: number) => new Date(ms).toISOString().slice(0, 13);

/** Share of the cohort's combine discoveries (column `col`) inside the 36 h windows of `days`. */
export function windowShare(days: readonly string[], hourly: ReachInputs["hourly"], col: "n28" | "n7", total: number): number {
  if (total <= 0 || days.length === 0) return 0;
  let s = 0;
  for (const day of new Set(days)) {
    const t0 = Date.parse(`${day}T00:00:00Z`);
    for (let h = 0; h < WINDOW_HOURS; h++) s += hourly.get(hourKey(t0 + h * 3_600_000))?.[col] ?? 0;
  }
  return Math.min(MAX_WINDOW_SHARE, s / total);
}

const clampReach = (x: number) => Math.min(1, Math.max(REACH_FLOOR, x));

/** Pure: reach and reach7 per element from the loaded counts (see the top of the file). */
export function computeReach(inp: ReachInputs): Reach {
  let tot28 = 0;
  let tot7 = 0;
  for (const v of inp.hourly.values()) {
    tot28 += v.n28;
    tot7 += v.n7;
  }
  const reach = new Map<string, number>();
  const reach7 = new Map<string, number>();
  const owners = new Map<string, number>();
  for (const [id, o] of inp.owners) {
    const days = inp.windows.get(id) ?? [];
    owners.set(id, o.owners);
    if (inp.n28 > 0 && o.owners > 0) reach.set(id, clampReach(o.owners / (inp.n28 * (1 - windowShare(days, inp.hourly, "n28", tot28)))));
    if (inp.n7 > 0 && o.owners7 > 0) reach7.set(id, clampReach(o.owners7 / (inp.n7 * (1 - windowShare(days, inp.hourly, "n7", tot7)))));
  }
  return { asOf: inp.asOf, mode: "r1", cohortN: inp.n28, cohortN7: inp.n7, reach, reach7, owners };
}

/** reach lookup with the floor for elements nobody in the cohort made. */
export const reachOf = (m: ReadonlyMap<string, number>, id: string): number => m.get(id) ?? REACH_FLOOR;

const COHORT_SQL = (s: string) => `
  cohort AS (
    SELECT p.id, p.created_at FROM ${s}.players p
     WHERE p.legacy_user_id IS NULL AND coalesce(p.acq_ua_class, '') <> 'bot'
       AND (p.switched_away_at IS NULL OR p.switched_away_at >= $1::TIMESTAMPTZ)
       AND p.created_at >= $1::TIMESTAMPTZ - INTERVAL '35 days' AND p.created_at < $1::TIMESTAMPTZ
       AND EXISTS (SELECT 1 FROM ${s}.discoveries d WHERE d.player_id = p.id AND d.source = 'combine' AND d.discovered_at < $1::TIMESTAMPTZ)
  )`;

/** The owners query (spec §2.2); exported for review and tests. $1 = asOf. */
export const OWNERS_SQL = (s: string) => `
WITH ${COHORT_SQL(s)}, tw AS (
  SELECT id, day FROM (SELECT easy_id AS id, day FROM ${s}.challenges UNION ALL
                       SELECT hard_id, day FROM ${s}.challenges UNION ALL
                       SELECT expert_id, day FROM ${s}.challenges) t
   WHERE day >= ($1::TIMESTAMPTZ - INTERVAL '36 days')::DATE AND day <= $1::TIMESTAMPTZ::DATE
)
SELECT d.element_id::STRING AS id,
       count(*) FILTER (WHERE c.created_at >= $1::TIMESTAMPTZ - INTERVAL '28 days') AS owners,
       count(*) FILTER (WHERE c.created_at < $1::TIMESTAMPTZ - INTERVAL '7 days'
                          AND d.discovered_at < c.created_at + INTERVAL '7 days') AS owners7
  FROM ${s}.discoveries d JOIN cohort c ON c.id = d.player_id
 WHERE d.source = 'combine' AND d.discovered_at < $1::TIMESTAMPTZ
   AND NOT EXISTS (SELECT 1 FROM tw WHERE tw.id = d.element_id
                     AND d.discovered_at >= tw.day::TIMESTAMPTZ
                     AND d.discovered_at <  tw.day::TIMESTAMPTZ + INTERVAL '36 hours')
 GROUP BY 1`;

const COUNTS_SQL = (s: string) => `
WITH ${COHORT_SQL(s)}
SELECT count(*) FILTER (WHERE created_at >= $1::TIMESTAMPTZ - INTERVAL '28 days') AS n28,
       count(*) FILTER (WHERE created_at < $1::TIMESTAMPTZ - INTERVAL '7 days') AS n7
  FROM cohort`;

const HOURLY_SQL = (s: string) => `
WITH ${COHORT_SQL(s)}
SELECT (d.discovered_at AT TIME ZONE 'UTC')::DATE::STRING AS day, extract(hour FROM d.discovered_at AT TIME ZONE 'UTC')::INT AS hr,
       count(*) FILTER (WHERE c.created_at >= $1::TIMESTAMPTZ - INTERVAL '28 days') AS n28,
       count(*) FILTER (WHERE c.created_at < $1::TIMESTAMPTZ - INTERVAL '7 days'
                          AND d.discovered_at < c.created_at + INTERVAL '7 days') AS n7
  FROM ${s}.discoveries d JOIN cohort c ON c.id = d.player_id
 WHERE d.source = 'combine' AND d.discovered_at < $1::TIMESTAMPTZ
 GROUP BY 1, 2`;

/**
 * Read the counts computeReach needs, at `asOf` (default now). `db` should be a client inside a
 * READ ONLY transaction so the three queries see one snapshot.
 */
export async function loadReachInputs(db: pg.Pool | pg.PoolClient, schema: string, asOf: Date = new Date()): Promise<ReachInputs> {
  const at = asOf.toISOString();
  const own = await db.query<{ id: string; owners: string; owners7: string }>(OWNERS_SQL(schema), [at]);
  const cnt = await db.query<{ n28: string; n7: string }>(COUNTS_SQL(schema), [at]);
  const hr = await db.query<{ day: string; hr: number; n28: string; n7: string }>(HOURLY_SQL(schema), [at]);
  const asOfDay = at.slice(0, 10);
  const win = await db.query<{ id: string; day: string }>(
    `SELECT id::STRING AS id, day::STRING AS day FROM (
       SELECT easy_id AS id, day FROM ${schema}.challenges UNION ALL
       SELECT hard_id, day FROM ${schema}.challenges UNION ALL
       SELECT expert_id, day FROM ${schema}.challenges) t
      WHERE day >= $1::DATE AND day <= $2::DATE`,
    [addDays(asOfDay, -36), asOfDay],
  );
  const windows = new Map<string, string[]>();
  for (const r of win.rows) windows.set(r.id, [...(windows.get(r.id) ?? []), r.day]);
  return {
    asOf: at,
    n28: Number(cnt.rows[0]?.n28 ?? 0),
    n7: Number(cnt.rows[0]?.n7 ?? 0),
    owners: new Map(own.rows.map((r) => [r.id, { owners: Number(r.owners), owners7: Number(r.owners7) }])),
    hourly: new Map(hr.rows.map((r) => [`${r.day}T${String(r.hr).padStart(2, "0")}`, { n28: Number(r.n28), n7: Number(r.n7) }])),
    windows,
  };
}

/** JSON-safe form of ReachInputs (plan files, snapshots). */
export function reachInputsToJson(r: ReachInputs) {
  return { asOf: r.asOf, n28: r.n28, n7: r.n7, owners: [...r.owners], hourly: [...r.hourly], windows: [...r.windows] };
}

export function reachInputsFromJson(j: ReturnType<typeof reachInputsToJson>): ReachInputs {
  return { asOf: j.asOf, n28: j.n28, n7: j.n7, owners: new Map(j.owners), hourly: new Map(j.hourly), windows: new Map(j.windows) };
}
