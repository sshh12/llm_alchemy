// Weekly database snapshot (aggregates only, no player identifiers):
// new-player cohorts by local first day with activation, D1 and D7, split by first landing page,
// referrer, UTM source and platform (bets A, C, D); D1 by day-0 challenge completion (bet B);
// legacy returners (bet E); crawler and throwaway counts; budget usage.
//
//   npm run analytics:snapshot [-- --schema=alchemy] [--out=.analytics/2026-11-16]
//
// Player metrics exclude crawlers (acq_ua_class = 'bot'), throwaway players left through a
// transfer code (switched_away_at), and internal players: ANALYTICS_INTERNAL_PLAYERS in .env, a
// comma-separated list of players.public_id values (yours, from Settings or GA user_id).
import "../lib/env.ts";
import fs from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import { printTable, runMain } from "../lib/cli.ts";
import { createPool, resolveSchema } from "../lib/db.ts";
import { REPO_ROOT } from "../lib/env.ts";

/** First local day player_days is keyed by local day (migration 0007); earlier rows are UTC. */
const LOCAL_DAYS_FROM = "2026-11-09";

async function main(): Promise<void> {
  const { values } = parseArgs({ options: { schema: { type: "string" }, out: { type: "string" } } });
  const s = resolveSchema(values.schema);
  const stamp = new Date().toISOString().slice(0, 10);
  const out = path.resolve(REPO_ROOT, values.out ?? path.join(".analytics", stamp));
  const internal = (process.env.ANALYTICS_INTERNAL_PLAYERS ?? "").split(",").map((x) => x.trim()).filter(Boolean);
  const pool = createPool(2);
  const result: Record<string, unknown> = { generated_at: new Date().toISOString(), schema: s, local_days_from: LOCAL_DAYS_FROM, internal_players_excluded: internal.length };

  // One row per real new player: their local first day (day0) and outcomes. A player whose first
  // player_days row comes long after creation is an old player returning, not a new one.
  const cohort = `
    WITH c AS (
      SELECT p.id, p.acq_landing, p.acq_referrer, p.acq_utm_source, p.acq_ua_class, min(d.day) AS day0
        FROM ${s}.players p JOIN ${s}.player_days d ON d.player_id = p.id
       WHERE p.legacy_user_id IS NULL
         AND coalesce(p.acq_ua_class, '') <> 'bot'
         AND p.switched_away_at IS NULL
         AND NOT (p.public_id::STRING = ANY($1::STRING[]))
       GROUP BY p.id, p.created_at, p.acq_landing, p.acq_referrer, p.acq_utm_source, p.acq_ua_class
      HAVING min(d.day) >= $2::DATE AND p.created_at >= min(d.day)::TIMESTAMPTZ - INTERVAL '2 days'
    ), m AS (
      SELECT c.*,
             EXISTS (SELECT 1 FROM ${s}.discoveries x WHERE x.player_id = c.id AND x.source = 'combine') AS activated,
             EXISTS (SELECT 1 FROM ${s}.player_days x WHERE x.player_id = c.id AND x.day = c.day0 + 1) AS d1,
             EXISTS (SELECT 1 FROM ${s}.player_days x WHERE x.player_id = c.id AND x.day = c.day0 + 7) AS d7,
             EXISTS (SELECT 1 FROM ${s}.challenge_completions x WHERE x.player_id = c.id AND x.day = c.day0 AND x.source = 'live') AS challenge_d0,
             c.day0 + 2 <= current_date AS d1_ready,
             c.day0 + 8 <= current_date AS d7_ready
        FROM c
    )`;
  const rates = `count(*) AS players,
       count(*) FILTER (WHERE activated) AS activated,
       round(100.0 * count(*) FILTER (WHERE activated) / count(*), 1) AS activated_pct,
       count(*) FILTER (WHERE d1_ready) AS d1_n,
       round(100.0 * count(*) FILTER (WHERE d1_ready AND d1) / nullif(count(*) FILTER (WHERE d1_ready), 0), 1) AS d1_pct,
       count(*) FILTER (WHERE d7_ready) AS d7_n,
       round(100.0 * count(*) FILTER (WHERE d7_ready AND d7) / nullif(count(*) FILTER (WHERE d7_ready), 0), 1) AS d7_pct`;
  const params = [internal, LOCAL_DAYS_FROM];
  const breakdown = async (name: string, key: string, where = "TRUE") => {
    const { rows } = await pool.query(`${cohort} SELECT ${key} AS key, ${rates} FROM m WHERE ${where} GROUP BY 1 ORDER BY players DESC LIMIT 25`, params);
    result[name] = rows;
    console.log(`\n== ${name}`);
    printTable(rows);
  };

  try {
    await breakdown("cohorts_by_day", "day0::STRING");
    await breakdown("by_landing", "coalesce(acq_landing, '(unknown)')");
    await breakdown("by_referrer", "coalesce(acq_referrer, '(direct)')");
    await breakdown("by_utm_source", "coalesce(acq_utm_source, '(none)')");
    await breakdown("by_platform", "coalesce(acq_ua_class, '(unknown)')");
    // Bet B: among activated new players, does finishing a challenge tier on day 0 go with returning?
    await breakdown("activated_by_challenge_d0", "CASE WHEN challenge_d0 THEN 'completed a tier on day 0' ELSE 'no tier on day 0' END", "activated");

    const extra: Record<string, string> = {
      excluded_by_day: `SELECT created_at::DATE::STRING AS day,
               count(*) FILTER (WHERE acq_ua_class = 'bot') AS bots,
               count(*) FILTER (WHERE switched_away_at IS NOT NULL) AS switched_away,
               count(*) FILTER (WHERE acq_ua_class IS NULL) AS no_platform
          FROM ${s}.players WHERE legacy_user_id IS NULL AND created_at >= $1::DATE - 1 GROUP BY 1 ORDER BY 1`,
      legacy_claims_by_day: `SELECT legacy_claimed_at::DATE::STRING AS day, count(*) AS claimed
          FROM ${s}.players WHERE legacy_claimed_at >= $1::DATE - 7 GROUP BY 1 ORDER BY 1`,
      // Bet E: legacy players active by local day, and how deep they play.
      legacy_activity_by_day: `SELECT d.day::STRING AS day, count(*) AS legacy_players, sum(d.combines) AS combines
          FROM ${s}.player_days d JOIN ${s}.players p ON p.id = d.player_id
         WHERE p.legacy_user_id IS NOT NULL AND d.day >= $1::DATE GROUP BY 1 ORDER BY 1`,
      daily_activity: `SELECT d.day::STRING AS day, count(*) AS players, sum(d.loads) AS loads, sum(d.combines) AS combines
          FROM ${s}.player_days d WHERE d.day >= $1::DATE GROUP BY 1 ORDER BY 1`,
      budgets: `SELECT split_part(key, ':', 2) AS name, count AS used, expires_at::STRING AS window_ends
          FROM ${s}.counters WHERE key LIKE 'rl:budget.%' ORDER BY key`,
    };
    for (const [name, sql] of Object.entries(extra)) {
      const { rows } = await pool.query(sql, name === "budgets" ? [] : [LOCAL_DAYS_FROM]);
      result[name] = rows;
      console.log(`\n== ${name}`);
      printTable(rows);
    }
  } finally {
    await pool.end();
  }
  fs.mkdirSync(out, { recursive: true });
  fs.writeFileSync(path.join(out, "db_snapshot.json"), JSON.stringify(result, null, 1));
  console.log(`\nwrote ${path.join(out, "db_snapshot.json")}`);
}

runMain(main);
