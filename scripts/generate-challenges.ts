// Generate daily challenges from the cutover day forward (port of the legacy notebook's BFS,
// made deterministic and repeat-aware; see scripts/lib/challenges.ts).
//
//   npm run db:challenges                          # CHALLENGE_CUTOVER_DAY + CHALLENGE_GENERATE_YEARS
//   npm run db:challenges -- --dry-run
//   npm run db:challenges -- --from=2031-11-06 --days=365
//   npm run db:challenges -- --replace-generated   # re-pick generated days >= --from (see below)
//
// Existing days are never changed (INSERT ... ON CONFLICT (day) DO NOTHING). Picks for missing
// days are a deterministic function of the stored rows and the active recipe graph: the
// simulation always starts at the cutover, so --from only limits which days get written.
//
// Targets must be recognizable (elements.recognizable = true, set by `npm run db:classify`;
// run it first) whenever a tier has at least MIN_RECOGNIZABLE_POOL of them; otherwise that tier
// falls back to every eligible candidate with the recognizable ones preferred (logged below).
//
// --replace-generated: in ONE transaction, refuse if any challenge completion exists on/after
// --from, delete the source='generated' rows in the range (--from, --days), and insert fresh picks.
// Rows with any other source (e.g. 'legacy') are never touched.
//
// Small pools: the no-repeat window is 120 days. If a tier's pool is smaller than that (the
// tier-2 easy pool can be), targets come from the least-recently-used quarter of the pool, so
// repeats are spaced as widely as the pool allows instead of failing.
import "./lib/env.ts";
import { parseArgs } from "node:util";
import type pg from "pg";
import type { Tier } from "../src/shared/api.ts";
import { addDays, CHALLENGE_CUTOVER_DAY, CHALLENGE_GENERATE_YEARS, isDay } from "../src/shared/dates.ts";
import {
  buildPools,
  dayRange,
  GENERATOR,
  MIN_RECOGNIZABLE_POOL,
  NO_REPEAT_DAYS,
  pickChallenges,
  TIERS,
  type DayTargets,
  type PoolStats,
  type TierPool,
} from "./lib/challenges.ts";
import { isMain, printTable, runMain } from "./lib/cli.ts";
import { chunk, createPool, fmt, resolveSchema, retrying } from "./lib/db.ts";
import { loadWorld } from "./lib/world.ts";

export function daysBetween(a: string, b: string): number {
  return Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86_400_000);
}

/** Days from `from` to the same calendar date `years` later (1826 for 5 years incl. a leap day). */
export function daysForYears(from: string, years: number): number {
  return daysBetween(from, `${Number(from.slice(0, 4)) + years}${from.slice(4)}`);
}

export function printPools(pools: Record<Tier, TierPool>, stats: Record<Tier, PoolStats>, tierSizes: Map<number, number>) {
  console.log("BFS tier sizes (active elements, 2-ingredient recipes):");
  printTable([...tierSizes].map(([tier, n]) => ({ tier, elements: fmt(n) })));
  console.log(`\nCandidate pools (recognizable-only when >= ${MIN_RECOGNIZABLE_POOL} recognizable):`);
  printTable(
    TIERS.map((t) => ({
      tier: t,
      bfs_tier: stats[t].bfsTier,
      eligible: fmt(stats[t].eligible),
      recognizable: fmt(stats[t].recognizable),
      not: fmt(stats[t].notRecognizable),
      unclassified: fmt(stats[t].unclassified),
      mode: stats[t].mode,
      candidates: fmt(pools[t].candidates.length),
      preferred: pools[t].preferred?.length ? pools[t].preferred!.map((l) => fmt(l.size)).join(" > ") : "-",
      repeats_within_window: pools[t].candidates.length < NO_REPEAT_DAYS ? "unavoidable (LRU spacing)" : "avoided",
    })),
  );
  for (const t of TIERS) {
    const s = stats[t];
    if (s.mode === "fallback") {
      console.warn(
        `WARNING: ${t}: only ${s.recognizable} recognizable of ${s.eligible} eligible (< ${MIN_RECOGNIZABLE_POOL}); ` +
          `falling back to all eligible candidates, recognizable preferred.`,
      );
    }
    if (s.unclassified > 0) console.warn(`WARNING: ${t}: ${fmt(s.unclassified)} candidate(s) not classified yet (run npm run db:classify).`);
  }
}

export interface InsertRow {
  day: string;
  t: DayTargets;
}

export async function insertDays(db: pg.Pool | pg.PoolClient, schema: string, rows: InsertRow[], steps: Map<string, number | null>): Promise<number> {
  let inserted = 0;
  for (const batch of chunk(rows, 1_000)) {
    const res = await db.query(
      `INSERT INTO ${schema}.challenges (day, easy_id, hard_id, expert_id, easy_steps, hard_steps, expert_steps, source, generator)
       SELECT u.day, u.e, u.h, u.x, u.es, u.hs, u.xs, 'generated', $8
       FROM unnest($1::DATE[], $2::INT8[], $3::INT8[], $4::INT8[], $5::INT4[], $6::INT4[], $7::INT4[]) AS u(day, e, h, x, es, hs, xs)
       ON CONFLICT (day) DO NOTHING`,
      [
        batch.map((r) => r.day),
        batch.map((r) => r.t.easy),
        batch.map((r) => r.t.hard),
        batch.map((r) => r.t.expert),
        batch.map((r) => steps.get(r.t.easy) ?? null),
        batch.map((r) => steps.get(r.t.hard) ?? null),
        batch.map((r) => steps.get(r.t.expert) ?? null),
        GENERATOR,
      ],
    );
    inserted += res.rowCount ?? 0;
  }
  return inserted;
}

export async function completionsFrom(db: pg.Pool | pg.PoolClient, schema: string, from: string): Promise<number> {
  const res = await db.query<{ n: string }>(`SELECT count(*) AS n FROM ${schema}.challenge_completions WHERE day >= $1::DATE`, [from]);
  return Number(res.rows[0]!.n);
}

if (isMain(import.meta.url)) {
  runMain(async () => {
    const { values } = parseArgs({
      options: {
        schema: { type: "string" },
        from: { type: "string" },
        days: { type: "string" },
        show: { type: "string" },
        "dry-run": { type: "boolean" },
        "replace-generated": { type: "boolean" },
      },
    });
    const schema = resolveSchema(values.schema);
    const from = values.from ?? CHALLENGE_CUTOVER_DAY;
    if (!isDay(from) || from < CHALLENGE_CUTOVER_DAY) throw new Error(`--from must be a day on/after ${CHALLENGE_CUTOVER_DAY}`);
    const count = values.days ? Number.parseInt(values.days, 10) : daysForYears(CHALLENGE_CUTOVER_DAY, CHALLENGE_GENERATE_YEARS) - daysBetween(CHALLENGE_CUTOVER_DAY, from);
    if (!(count > 0)) throw new Error("--days must be positive");
    const show = values.show ? Number.parseInt(values.show, 10) : 21;
    const end = addDays(from, count); // exclusive
    const dryRun = values["dry-run"] ?? false;
    const replace = values["replace-generated"] ?? false;

    const pool = createPool(2);
    try {
      if (replace) {
        const n = await completionsFrom(pool, schema, from);
        if (n > 0) throw new Error(`--replace-generated refused: ${fmt(n)} challenge completion(s) on/after ${from} in ${schema}.challenge_completions`);
        console.log(`Replace mode: 0 challenge completions on/after ${from}; generated days on/after ${from} will be re-picked.\n`);
      }
      const { elements, recipes } = await loadWorld(pool, schema);
      console.log(`Schema "${schema}": ${fmt(elements.length)} active elements, ${fmt(recipes.length)} active 2-ingredient recipes\n`);
      const { pools, stats, tierSizes } = buildPools(elements, recipes);
      printPools(pools, stats, tierSizes);

      const stored = (
        await pool.query<{ day: string; easy_id: string; hard_id: string; expert_id: string; source: string }>(
          `SELECT day, easy_id, hard_id, expert_id, source FROM ${schema}.challenges WHERE day >= $1::DATE ORDER BY day`,
          [addDays(CHALLENGE_CUTOVER_DAY, -NO_REPEAT_DAYS)],
        )
      ).rows;
      const replaced = (r: (typeof stored)[number]) => replace && r.source === "generated" && r.day >= from && r.day < end;
      const toTargets = (r: (typeof stored)[number]): DayTargets => ({ easy: r.easy_id, hard: r.hard_id, expert: r.expert_id });
      const history = stored.filter((r) => r.day < CHALLENGE_CUTOVER_DAY).map((r) => ({ day: r.day, targets: toTargets(r) }));
      const fixed = new Map(stored.filter((r) => r.day >= CHALLENGE_CUTOVER_DAY && !replaced(r)).map((r) => [r.day, toTargets(r)]));
      const toReplace = stored.filter(replaced).length;

      const simDays = dayRange(CHALLENGE_CUTOVER_DAY, daysBetween(CHALLENGE_CUTOVER_DAY, end));
      const picks = pickChallenges(simDays, pools, fixed, history);
      const steps = new Map(elements.map((e) => [e.id, e.steps]));
      const names = new Map(elements.map((e) => [e.id, e.name]));
      const rows = simDays.filter((d) => d >= from && !fixed.has(d)).map((day) => ({ day, t: picks.get(day)! }));

      console.log(
        `\nRange ${from} .. ${addDays(end, -1)} (${fmt(count)} days): ${fmt(rows.length)} to insert` +
          (replace ? ` (replacing ${fmt(toReplace)} generated row(s))` : "") +
          `, ${fmt(count - rows.length)} kept as stored.`,
      );
      console.log(`\nFirst ${Math.min(show, count)} days (name (steps)):`);
      printTable(
        dayRange(from, Math.min(show, count)).map((day) => {
          const t = picks.get(day)!;
          const cell = (tier: Tier) => `${names.get(t[tier]) ?? t[tier]} (${steps.get(t[tier]) ?? "?"})`;
          return { day, easy: cell("easy"), hard: cell("hard"), expert: cell("expert"), stored: fixed.has(day) ? "yes" : "" };
        }),
      );
      if (dryRun) {
        console.log("\nDry run: nothing written.");
        return;
      }
      if (!replace) {
        const inserted = await insertDays(pool, schema, rows, steps);
        console.log(`\nInserted ${fmt(inserted)} challenge day(s) into ${schema}.challenges.`);
        return;
      }
      const { deleted, inserted } = await retrying("replace generated challenges", async () => {
        const client = await pool.connect();
        try {
          await client.query("BEGIN");
          const n = await completionsFrom(client, schema, from);
          if (n > 0) throw new Error(`--replace-generated refused: ${fmt(n)} challenge completion(s) on/after ${from} (checked in the transaction)`);
          const del = await client.query(`DELETE FROM ${schema}.challenges WHERE source = 'generated' AND day >= $1::DATE AND day < $2::DATE`, [from, end]);
          const ins = await insertDays(client, schema, rows, steps);
          if (ins !== rows.length) throw new Error(`expected to insert ${rows.length} day(s), inserted ${ins}; rolled back`);
          await client.query("COMMIT");
          return { deleted: del.rowCount ?? 0, inserted: ins };
        } catch (e) {
          await client.query("ROLLBACK").catch(() => {});
          throw e;
        } finally {
          client.release();
        }
      });
      console.log(`\nReplaced: deleted ${fmt(deleted)} generated day(s) and inserted ${fmt(inserted)} into ${schema}.challenges (one transaction).`);
    } finally {
      await pool.end();
    }
  });
}
