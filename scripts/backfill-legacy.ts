// Idempotent legacy -> v2 backfill (see docs/ARCHITECTURE.md "Legacy migration").
//
//   npm run db:backfill                     # into DB_SCHEMA (default "alchemy")
//   npm run db:backfill -- --dry-run        # read legacy + compute + print, write nothing
//   npm run db:backfill -- --schema=alchemy_e2e --sample=500   # smoke-test writes (non-production)
//
// Reads public."Alchemy*" read-only at one follower-read snapshot, builds every v2 row in memory
// (scripts/lib/legacy.ts), then inserts only rows that are missing (diffed against what the
// target schema already holds, plus ON CONFLICT DO NOTHING for safety), so a re-run is a fast
// near no-op. Depth/steps are only ever lowered. A summary lands in <schema>.meta 'backfill:v1'.
import "./lib/env.ts";
import { parseArgs } from "node:util";
import type pg from "pg";
import { RARITY_ORDER } from "../src/shared/rarity.ts";
import { isMain, printTable, runMain } from "./lib/cli.ts";
import { chunk, createPool, fmt, mapConcurrent, resolveSchema, retrying } from "./lib/db.ts";
import { histogram, suggestRarityThresholds } from "./lib/graph.ts";
import { buildPlan, dayNoon, readLegacy, type Plan } from "./lib/legacy.ts";

const CONCURRENCY = 4;
const BATCH = 2_000;
const META_KEY = "backfill:v1";

const iso = (d: Date) => d.toISOString();

interface Written {
  table: string;
  planned: number;
  existing: number;
  inserted: number;
}

/** Insert `rows` in batches (in parallel), returning the number of rows actually inserted. */
async function insertBatches<T>(pool: pg.Pool, label: string, rows: T[], sql: string, params: (batch: T[]) => unknown[], size = BATCH) {
  let inserted = 0;
  let done = 0;
  let batchesDone = 0;
  const batches = chunk(rows, size);
  await mapConcurrent(batches, CONCURRENCY, async (batch) => {
    const res = await retrying(label, () => pool.query(sql, params(batch)));
    inserted += res.rowCount ?? 0;
    done += batch.length;
    if (++batchesDone % 10 === 0) console.log(`    ${label}: ${fmt(done)}/${fmt(rows.length)}`);
  });
  if (inserted !== rows.length) console.warn(`    ${label}: ${fmt(rows.length - inserted)} row(s) not written (conflict or guard)`);
  return inserted;
}

async function writePlan(pool: pg.Pool, schema: string, plan: Plan, sample: number | null): Promise<Written[]> {
  const S = schema;
  const take = <T>(rows: T[]) => (sample === null ? rows : rows.slice(0, sample));
  const written: Written[] = [];
  const t0 = performance.now();
  const step = (msg: string) => console.log(`  [${((performance.now() - t0) / 1000).toFixed(1)}s] ${msg}`);

  const migrated = await pool.query(`SELECT 1 FROM ${S}.schema_migrations WHERE version = '0001_init'`).catch(() => ({ rowCount: 0 }));
  if (!migrated.rowCount) throw new Error(`schema ${S} is not migrated; run npm run db:migrate first`);

  // ---- players (first: elements.discovered_by needs their ids)
  step("players");
  const playerId = new Map<string, string>();
  const seen = new Set<string>(); // players that already played v2: never touch their library
  for (const r of (
    await pool.query<{ id: string; legacy_user_id: string; touched: boolean }>(
      `SELECT id, legacy_user_id, (last_seen_at IS NOT NULL OR legacy_imported_at IS NOT NULL) AS touched
       FROM ${S}.players WHERE legacy_user_id IS NOT NULL`,
    )
  ).rows) {
    playerId.set(r.legacy_user_id, r.id);
    if (r.touched) seen.add(r.legacy_user_id);
  }
  const players = take(plan.players);
  const newPlayers = players.filter((p) => !playerId.has(p.legacyUserId));
  let insertedPlayers = 0;
  await mapConcurrent(chunk(newPlayers, 5_000), CONCURRENCY, async (batch) => {
    const res = await retrying("players", () =>
      pool.query<{ id: string; legacy_user_id: string }>(
        `INSERT INTO ${S}.players (legacy_user_id, created_at)
         SELECT * FROM unnest($1::STRING[], $2::TIMESTAMPTZ[])
         ON CONFLICT (legacy_user_id) DO NOTHING
         RETURNING id, legacy_user_id`,
        [batch.map((p) => p.legacyUserId), batch.map((p) => iso(p.createdAt))],
      ),
    );
    for (const r of res.rows) playerId.set(r.legacy_user_id, r.id);
    insertedPlayers += res.rowCount ?? 0;
  });
  // Rows that conflicted (a concurrent writer) are looked up explicitly.
  const missing = players.filter((p) => !playerId.has(p.legacyUserId)).map((p) => p.legacyUserId);
  for (const batch of chunk(missing, 5_000)) {
    const res = await pool.query<{ id: string; legacy_user_id: string }>(
      `SELECT id, legacy_user_id FROM ${S}.players WHERE legacy_user_id = ANY($1::STRING[])`,
      [batch],
    );
    for (const r of res.rows) playerId.set(r.legacy_user_id, r.id);
  }
  written.push({ table: "players", planned: players.length, existing: players.length - newPlayers.length, inserted: insertedPlayers });

  // ---- elements
  step("elements");
  const existingElements = new Set(
    (await pool.query<{ id: string }>(`SELECT id FROM ${S}.elements WHERE legacy_id IS NOT NULL`)).rows.map((r) => r.id),
  );
  const elements = take(plan.elements);
  const newElements = elements.filter((e) => !existingElements.has(e.id));
  const insertedElements = await insertBatches(
    pool,
    "elements",
    newElements,
    `INSERT INTO ${S}.elements
       (id, legacy_id, name, name_key, fold_key, emoji, status, is_starter, discovered_by, created_at, enriched_at, source)
     SELECT u.id, u.id, u.name, u.name_key, u.fold_key, u.emoji, u.status, u.is_starter, u.discovered_by, u.created_at,
            CASE WHEN u.is_starter THEN now() END, 'legacy'
     FROM unnest($1::INT8[], $2::STRING[], $3::STRING[], $4::STRING[], $5::STRING[], $6::STRING[], $7::BOOL[], $8::INT8[], $9::TIMESTAMPTZ[])
       AS u(id, name, name_key, fold_key, emoji, status, is_starter, discovered_by, created_at)
     ON CONFLICT DO NOTHING`,
    (b) => [
      b.map((e) => e.id),
      b.map((e) => e.name),
      b.map((e) => e.nameKey),
      b.map((e) => e.foldKey),
      b.map((e) => e.emoji),
      b.map((e) => e.status),
      b.map((e) => e.isStarter),
      b.map((e) => (e.creator ? (playerId.get(e.creator) ?? null) : null)),
      b.map((e) => iso(e.createdAt)),
    ],
    1_000,
  );
  written.push({ table: "elements", planned: elements.length, existing: elements.length - newElements.length, inserted: insertedElements });

  // Discoverer credit for rows that already existed when their creator became a known
  // player (e.g. the earliest players, whose ids predate the 'alchemy:' prefix).
  // Never overwrites an existing credit.
  const credit = elements.filter((e) => existingElements.has(e.id) && e.creator && playerId.has(e.creator));
  let credited = 0;
  for (const batch of chunk(credit, 5_000)) {
    const res = await retrying("elements.discovered_by", () =>
      pool.query(
        `UPDATE ${S}.elements AS e SET discovered_by = u.p
           FROM unnest($1::INT8[], $2::INT8[]) AS u(id, p)
          WHERE e.id = u.id AND e.discovered_by IS NULL`,
        [batch.map((e) => e.id), batch.map((e) => playerId.get(e.creator!)!)],
      ),
    );
    credited += res.rowCount ?? 0;
  }
  written.push({ table: "elements.discovered_by", planned: credit.length, existing: credit.length - credited, inserted: credited });

  // ---- legacy id map
  step("legacy_element_map");
  const existingMap = new Set((await pool.query<{ legacy_id: string }>(`SELECT legacy_id FROM ${S}.legacy_element_map`)).rows.map((r) => r.legacy_id));
  const mapRows = take(plan.map);
  const newMap = mapRows.filter((m) => !existingMap.has(m.legacyId));
  const insertedMap = await insertBatches(
    pool,
    "legacy_element_map",
    newMap,
    `INSERT INTO ${S}.legacy_element_map (legacy_id, element_id, disposition)
     SELECT * FROM unnest($1::INT8[], $2::INT8[], $3::STRING[])
     ON CONFLICT (legacy_id) DO NOTHING`,
    (b) => [b.map((m) => m.legacyId), b.map((m) => m.elementId), b.map((m) => m.disposition)],
    5_000,
  );
  written.push({ table: "legacy_element_map", planned: mapRows.length, existing: mapRows.length - newMap.length, inserted: insertedMap });

  // ---- recipes (id = legacy recipe id)
  step("recipes");
  const existingRecipes = new Set(
    (await pool.query<{ legacy_id: string }>(`SELECT legacy_id FROM ${S}.recipes WHERE legacy_id IS NOT NULL`)).rows.map((r) => r.legacy_id),
  );
  const recipes = take(plan.recipes);
  const newRecipes = recipes.filter((r) => !existingRecipes.has(r.id));
  const insertedRecipes = await insertBatches(
    pool,
    "recipes",
    newRecipes,
    `INSERT INTO ${S}.recipes (id, legacy_id, ingredient_ids, result_id, arity, status, protected, created_at, source)
     SELECT u.id, u.id, string_to_array(u.ings, ',')::INT8[], u.result_id, cardinality(string_to_array(u.ings, ','))::INT2,
            u.status, u.protected, u.created_at, 'legacy'
     FROM unnest($1::INT8[], $2::STRING[], $3::INT8[], $4::STRING[], $5::BOOL[], $6::TIMESTAMPTZ[])
       AS u(id, ings, result_id, status, protected, created_at)
     ON CONFLICT DO NOTHING`,
    (b) => [
      b.map((r) => r.id),
      b.map((r) => r.ingredientIds.join(",")),
      b.map((r) => r.resultId),
      b.map((r) => r.status),
      b.map((r) => r.protected),
      b.map((r) => iso(r.createdAt)),
    ],
    5_000,
  );
  written.push({ table: "recipes", planned: recipes.length, existing: recipes.length - newRecipes.length, inserted: insertedRecipes });

  // ---- depth / steps: only ever lowered (live play may already have found shorter paths)
  step("depth/steps");
  const current = new Map(
    (await pool.query<{ id: string; depth: number | null; steps: number | null }>(`SELECT id, depth, steps FROM ${S}.elements WHERE legacy_id IS NOT NULL`)).rows.map(
      (r) => [r.id, r],
    ),
  );
  const updates: { id: string; depth: number; steps: number }[] = [];
  let present = 0;
  for (const [id, depth] of plan.depth) {
    const cur = current.get(id);
    if (!cur) continue;
    present++;
    const steps = plan.steps.get(id)!;
    const d = cur.depth === null ? depth : Math.min(cur.depth, depth);
    const s = cur.steps === null ? steps : Math.min(cur.steps, steps);
    if (d !== cur.depth || s !== cur.steps) updates.push({ id, depth: d, steps: s });
  }
  const updated = await insertBatches(
    pool,
    "depth/steps",
    updates,
    `UPDATE ${S}.elements AS e SET depth = u.depth, steps = u.steps
     FROM unnest($1::INT8[], $2::INT4[], $3::INT4[]) AS u(id, depth, steps)
     WHERE e.id = u.id
       AND (e.depth IS NULL OR u.depth <= e.depth) AND (e.steps IS NULL OR u.steps <= e.steps)
       AND (e.depth IS DISTINCT FROM u.depth OR e.steps IS DISTINCT FROM u.steps)`,
    (b) => [b.map((u) => u.id), b.map((u) => u.depth), b.map((u) => u.steps)],
    5_000,
  );
  written.push({ table: "elements.depth/steps", planned: present, existing: present - updates.length, inserted: updated });

  // ---- discoveries (never for players who already used v2: they may have reset their library)
  step("discoveries");
  const existingDisc = new Set(
    (await pool.query<{ k: string }>(`SELECT player_id::STRING || ' ' || element_id::STRING AS k FROM ${S}.discoveries WHERE source = 'legacy'`)).rows.map(
      (r) => r.k,
    ),
  );
  const knownElements = new Set([...existingElements, ...newElements.map((e) => e.id)]);
  const wantedDisc = take(plan.discoveries)
    .filter((d) => playerId.has(d.legacyUserId) && !seen.has(d.legacyUserId) && knownElements.has(d.elementId))
    .map((d) => ({ playerId: playerId.get(d.legacyUserId)!, elementId: d.elementId, at: d.discoveredAt }));
  const newDisc = wantedDisc.filter((d) => !existingDisc.has(`${d.playerId} ${d.elementId}`));
  const insertedDisc = await insertBatches(
    pool,
    "discoveries",
    newDisc,
    `INSERT INTO ${S}.discoveries (player_id, element_id, discovered_at, source)
     SELECT u.p, u.e, u.at, 'legacy' FROM unnest($1::INT8[], $2::INT8[], $3::TIMESTAMPTZ[]) AS u(p, e, at)
     ON CONFLICT (player_id, element_id) DO NOTHING`,
    (b) => [b.map((d) => d.playerId), b.map((d) => d.elementId), b.map((d) => iso(d.at))],
    5_000,
  );
  written.push({ table: "discoveries", planned: wantedDisc.length, existing: wantedDisc.length - newDisc.length, inserted: insertedDisc });

  // ---- challenges (legacy days before the cutover)
  step("challenges");
  const existingDays = new Set((await pool.query<{ day: string }>(`SELECT day FROM ${S}.challenges WHERE source = 'legacy'`)).rows.map((r) => r.day));
  const challenges = take(plan.challenges);
  const newDays = challenges.filter((c) => !existingDays.has(c.day));
  const insertedDays = await insertBatches(
    pool,
    "challenges",
    newDays,
    `INSERT INTO ${S}.challenges (day, easy_id, hard_id, expert_id, easy_steps, hard_steps, expert_steps, source)
     SELECT u.day, u.e, u.h, u.x, u.es, u.hs, u.xs, 'legacy'
     FROM unnest($1::DATE[], $2::INT8[], $3::INT8[], $4::INT8[], $5::INT4[], $6::INT4[], $7::INT4[]) AS u(day, e, h, x, es, hs, xs)
     ON CONFLICT (day) DO NOTHING`,
    (b) => [
      b.map((c) => c.day),
      b.map((c) => c.ids.easy),
      b.map((c) => c.ids.hard),
      b.map((c) => c.ids.expert),
      b.map((c) => c.steps.easy),
      b.map((c) => c.steps.hard),
      b.map((c) => c.steps.expert),
    ],
  );
  written.push({ table: "challenges", planned: challenges.length, existing: challenges.length - newDays.length, inserted: insertedDays });

  // ---- challenge completions (history is kept across resets, so no "seen" filter)
  step("challenge_completions");
  const existingComp = new Set(
    (
      await pool.query<{ k: string }>(
        `SELECT player_id::STRING || ' ' || day::STRING || ' ' || tier AS k FROM ${S}.challenge_completions WHERE source = 'legacy'`,
      )
    ).rows.map((r) => r.k),
  );
  const wantedComp = take(plan.completions)
    .filter((c) => playerId.has(c.legacyUserId))
    .map((c) => ({ playerId: playerId.get(c.legacyUserId)!, day: c.day, tier: c.tier }));
  const newComp = wantedComp.filter((c) => !existingComp.has(`${c.playerId} ${c.day} ${c.tier}`));
  const insertedComp = await insertBatches(
    pool,
    "challenge_completions",
    newComp,
    `INSERT INTO ${S}.challenge_completions (player_id, day, tier, completed_at, source)
     SELECT u.p, u.day, u.tier, u.at, 'legacy' FROM unnest($1::INT8[], $2::DATE[], $3::STRING[], $4::TIMESTAMPTZ[]) AS u(p, day, tier, at)
     ON CONFLICT (player_id, day, tier) DO NOTHING`,
    (b) => [b.map((c) => c.playerId), b.map((c) => c.day), b.map((c) => c.tier), b.map((c) => iso(dayNoon(c.day)))],
    5_000,
  );
  written.push({ table: "challenge_completions", planned: wantedComp.length, existing: wantedComp.length - newComp.length, inserted: insertedComp });
  step("done");
  return written;
}

function printPlan(plan: Plan) {
  console.log("\nBuckets:");
  printTable(Object.entries(plan.stats).sort(([a], [b]) => (a < b ? -1 : 1)).map(([bucket, count]) => ({ bucket, count: fmt(count) })));

  const reachable = plan.elements.filter((e) => e.status === "active" && plan.depth.has(e.id)).map((e) => plan.depth.get(e.id)!);
  const hist = histogram(reachable);
  console.log(`\nDepth histogram (reachable active elements: ${fmt(reachable.length)}):`);
  let cum = 0;
  printTable(
    [...hist].map(([depth, n]) => {
      cum += n;
      return { depth, elements: fmt(n), cumulative: `${((100 * cum) / reachable.length).toFixed(1)}%` };
    }),
  );
  const { thresholds, share } = suggestRarityThresholds(hist);
  console.log("\nSuggested RARITY_MIN_DEPTH (src/shared/rarity.ts):");
  printTable(RARITY_ORDER.map((r) => ({ rarity: r, min_depth: thresholds[r], share: `${(100 * share[r]).toFixed(1)}%` })));
  return { thresholds, share, histogram: Object.fromEntries(hist) };
}

if (isMain(import.meta.url)) {
  runMain(async () => {
    const { values } = parseArgs({
      options: { schema: { type: "string" }, "dry-run": { type: "boolean" }, sample: { type: "string" } },
    });
    const schema = resolveSchema(values.schema);
    const dryRun = values["dry-run"] ?? false;
    const sample = values.sample ? Number.parseInt(values.sample, 10) : null;
    if (sample !== null && (!(sample > 0) || schema === "alchemy")) throw new Error("--sample=N (N>0) is only for non-production schemas");

    const pool = createPool(CONCURRENCY + 1);
    try {
      const started = Date.now();
      console.log(`Reading legacy tables (follower read) ...`);
      const snap = await readLegacy(pool);
      console.log(`Building plan ...`);
      const plan = buildPlan(snap);
      const rarity = printPlan(plan);
      if (dryRun) {
        console.log(`\nDry run: nothing written. (${((Date.now() - started) / 1000).toFixed(1)}s)`);
        return;
      }
      console.log(`\nWriting to schema "${schema}"${sample ? ` (sample: first ${sample} rows per table)` : ""} ...`);
      const written = await writePlan(pool, schema, plan, sample);
      console.log("\nSummary:");
      printTable(written.map((w) => ({ table: w.table, planned: fmt(w.planned), already_present: fmt(w.existing), inserted: fmt(w.inserted) })));
      const summary = {
        snapshot: snap.asOf,
        finishedAt: new Date().toISOString(),
        seconds: Math.round((Date.now() - started) / 1000),
        sample,
        stats: plan.stats,
        written,
        rarity,
      };
      await pool.query(
        `UPSERT INTO ${schema}.meta (key, value, updated_at) VALUES ($1, $2::JSONB, now())`,
        [META_KEY, JSON.stringify(summary)],
      );
      console.log(`\nDone in ${summary.seconds}s; summary stored in ${schema}.meta '${META_KEY}'.`);
    } finally {
      await pool.end();
    }
  });
}
