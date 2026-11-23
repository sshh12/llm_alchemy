// Soft-purge junk elements (garbled 2023-2025 names like "Doublepanoramajungle") after a two-pass
// review by small models. See docs/ARCHITECTURE.md "Element purge". Needs migration 0004.
//
//   npm run db:purge -- export --out <dir> [--batch-size 1000] [--pass verify]   # read-only
//   npm run db:purge -- stage --pass review|verify --batch <n> --file <verdicts.json> [--manifest <dir>/manifest.json]
//   npm run db:purge -- status [--manifest <dir>/manifest.json]                   # read-only
//   npm run db:purge -- plan [--out <file>] [--review-only]                       # read-only
//   npm run db:purge -- apply --plan <file> [--dry-run]
//   npm run db:purge -- restore --run <id> [--dry-run]
//   Every subcommand takes --schema <name> (default: DB_SCHEMA, else "alchemy") and --help.
//
// Semantics (implemented in scripts/lib/purge.ts):
// - Purge = soft delete: elements.status = 'quarantined', quarantine_reason = 'review', purge_run = <run id>.
// - Never purged: starters, the target of any challenge day, the shortest derivations of the
//   targets of every day that is "today" somewhere or is tomorrow's teaser (plus a 2 h margin;
//   repickCutoff), protected recipes' elements.
// - Recipes whose result is removed -> 'quarantined' unless protected (the next combine re-rolls
//   them: the existing heal path). Recipes that use a removed element -> 'quarantined' (dormant).
// - Leaf cascade: active non-starter elements that were reachable from the starters before and
//   are not after are quarantined with reason 'orphaned' (until stable). Elements that were
//   already unreachable are left alone. depth/steps are recomputed for everything still reachable.
//   Never-purge elements are never orphaned; if one becomes unreachable it is reported.
// - Generated challenge days after tomorrow's teaser day (repickCutoff) that the purge BREAKS
//   (check-challenges' broken definition, pred-v6: inactive, unreachable, tier-order, twin-trap,
//   p-order, ...; never because pool membership moved) are re-picked with the same pools and
//   picker as db:challenges (zero-completions check, one transaction, meta.replaced). Today, the
//   teaser day and the past are never touched. After an apply: npm run db:depth -- --run, then
//   npm run db:check-challenges -- --days=9 --fix (a purge raises steps).
// - Each apply run gets an id (purge-YYYYMMDD-HHMMSS) in elements/recipes.purge_run and a summary
//   in meta 'purge:<id>'. `restore --run <id>` reverses it (re-picked challenge days stay).
//   If apply fails midway, `restore --run <id>` and then plan/apply again.
import "./lib/env.ts";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { parseArgs, type ParseArgsConfig } from "node:util";
import type pg from "pg";
import type { Tier } from "../src/shared/api.ts";
import { utcDay } from "../src/shared/dates.ts";
import { completionsOn, configHash, gitSha, insertRows, nextReplaced, planHashOf, refuseWithoutMeta } from "./generate-challenges.ts";
import {
  buildCandidates,
  buildPools,
  checkDays,
  liveWindow,
  makeContext,
  planDays,
  TIERS,
  type ChallengeTags,
  type DayMeta,
  type DayTargets,
  type PlannedRow,
  type PoolElement,
  type StoredRow,
} from "./lib/challenges.ts";
import { isMain, printTable } from "./lib/cli.ts";
import { chunk, createPool, fmt, resolveSchema, retrying, withTx } from "./lib/db.ts";
import { depthOf, knuthFixpoint, stepsOf, type Metric } from "./lib/graph.ts";
import { computeReach, loadReachInputs, type Reach } from "./lib/reach.ts";
import { columnExists, worldAsOf } from "./lib/world.ts";
import {
  challengeWindow,
  checkVerdicts,
  computePurge,
  depthStepsUpdates,
  liveRecipes,
  madeFromIndex,
  makeRunId,
  neverPurge,
  parseVerdictFile,
  PASSES,
  REASON,
  recipeLabel,
  RUN_ID_RE,
  type ChallengeDay,
  type NeverPurgeKind,
  type Pass,
  type PurgeEffect,
  type PurgeElement,
  type PurgeRecipe,
} from "./lib/purge.ts";

const PLAN_VERSION = 1;
const ELEMENT_TX = 500;
const RECIPE_TX = 2_000;
const DEPTH_TX = 1_000;

/** A user mistake: printed as "ERROR: ..." without a stack trace. */
class UsageError extends Error {}

// ---------------------------------------------------------------- usage

const STAGE_USAGE = `Usage:
  cd C:/dev/llm_alchemy && npm run --silent db:purge -- stage --pass <review|verify> --batch <n> --file <verdicts.json> [--manifest <manifest.json>] [--schema <name>]

Records verdicts for one batch in <schema>.purge_review (default schema: alchemy). Re-running with
the same ids overwrites the earlier verdicts, so it is always safe to fix the file and run again.

verdicts.json is a JSON array (JSON Lines also accepted), one object per element of the batch:
  [{"id": "1083333177628557313", "verdict": "purge", "reason": "garbled compound"},
   {"id": "1083333177628557999", "verdict": "keep", "reason": "real animal"}]
  id       the element id from the batch file, as a STRING in quotes, copied exactly
  verdict  "purge" (junk: garbled, glued-together or nonsense name) or "keep"
  reason   short text (optional but wanted for "purge"; cut at 200 characters)
  name     optional: the element name; if given it must match the id's name (catches copy slips)

Rules: every id must be an existing active element. --pass verify accepts only ids whose review
verdict is "purge". With --manifest, every id must belong to batch <n>.
If anything is wrong NOTHING is written and every problem is listed; fix the file and re-run.
On success it prints exactly one line starting with "OK".`;

const USAGE: Record<string, string> = {
  export: `Usage: npm run db:purge -- export --out <dir> [--batch-size 1000] [--pass review|verify] [--overwrite] [--schema <name>]

Read-only. Writes <dir>/batch-NNN.jsonl (one line per ACTIVE non-starter, non-protected element,
ordered by id: {"id","name","depth","made_from"}) and <dir>/manifest.json {batches:[{n,file,count}]}.
--pass verify exports only elements whose review verdict is "purge" (adds "review_reason").
--overwrite replaces an earlier export's batch-*.jsonl / manifest.json in <dir>.`,
  stage: STAGE_USAGE,
  status: `Usage: npm run db:purge -- status [--manifest <manifest.json>] [--schema <name>]

Read-only. Staged verdict counts per pass and batch; with --manifest also the batches whose
verdicts are missing or incomplete.`,
  plan: `Usage: npm run db:purge -- plan [--out <file>] [--review-only] [--no-cascade] [--sample 40] [--schema <name>]

Read-only. Final purge set = review "purge" AND verify "purge", minus the never-purge set.
Computes the full effect (direct purges, cascade orphans, recipes quarantined, protected
collisions, challenge days to re-pick, player libraries affected), writes a JSON plan (default:
<tmp>/purge-plan-<time>.json) and prints a report with random samples.
--review-only previews using review verdicts alone (apply refuses such a plan).
--no-cascade keeps elements that only junk made reachable active (players keep them); they
become unreachable (depth/steps NULL) instead of being quarantined as orphans.`,
  apply: `Usage: npm run db:purge -- apply --plan <file> [--dry-run] [--max-fraction 0.75] [--allow-no-meta] [--schema <name>]

Re-validates the plan against the current database (verdicts, never-purge set, cascade), then
quarantines in batched transactions, re-picks affected future challenge days, records meta
'purge:<run id>' and prints verification queries. --dry-run stops after the re-validation.
Refuses to purge more than --max-fraction of the active non-starter elements. Refuses, before
any write, when days need a re-pick and challenges.meta is missing (migration 0010), unless
--allow-no-meta; never when one of them is assigned to the challenge holdout.`,
  restore: `Usage: npm run db:purge -- restore --run <purge-YYYYMMDD-HHMMSS> [--dry-run] [--schema <name>]

Reverses an apply run: its elements back to active, its recipes back to active where the result
and every ingredient are active again, depth/steps recomputed. Re-picked challenge days stay.`,
};

const GENERAL_USAGE = `Element purge (soft delete of junk elements). Subcommands:
  export   write review batches (read-only)
  stage    record reviewer verdicts for one batch
  status   staged verdict progress (read-only)
  plan     compute the effect of purging the agreed verdicts (read-only)
  apply    execute a plan
  restore  reverse an apply run
Run "npm run db:purge -- <subcommand> --help" for details.

${STAGE_USAGE}`;

type Options = NonNullable<ParseArgsConfig["options"]>;

function parse<O extends Options>(cmd: string, args: string[], options: O) {
  if (args.includes("--help") || args.includes("-h")) {
    console.log(USAGE[cmd]);
    process.exit(0);
  }
  try {
    return parseArgs({ args, options: { ...options, schema: { type: "string" } }, strict: true, allowPositionals: false }).values as {
      [K in keyof O]?: O[K]["type"] extends "boolean" ? boolean : string;
    } & { schema?: string };
  } catch (e) {
    throw new UsageError(`${(e as Error).message}\n\n${USAGE[cmd]}`);
  }
}

function positiveInt(flag: string, v: string | undefined, fallback?: number): number {
  if (v === undefined) {
    if (fallback !== undefined) return fallback;
    throw new UsageError(`missing --${flag}`);
  }
  const n = Number(v);
  if (!/^\d+$/.test(v.trim()) || !Number.isSafeInteger(n) || n < 1) throw new UsageError(`--${flag} must be a positive integer, got ${JSON.stringify(v)}`);
  return n;
}

// ---------------------------------------------------------------- loading

interface DbElement {
  id: string;
  name: string;
  status: string;
  is_starter: boolean;
  depth: number | null;
  steps: number | null;
  recognizable: boolean | null;
  image_status: string | null;
  emoji: string | null;
  notable: boolean;
  challenge_tags?: ChallengeTags | null;
}

/**
 * The last day a purge may not re-pick (and whose targets' paths it protects): liveWindow's
 * frozenThrough, the day after the last day that is "today" anywhere, because its easy target is
 * already shown as tomorrow's teaser (contract C7), taken 2 h ahead (challengeWindow's margin) so
 * a day cannot freeze while a run is going. Always challengeWindow().last + 1.
 */
function repickCutoff(now = new Date()): string {
  return liveWindow(new Date(now.getTime() + 2 * 3_600_000)).frozenThrough;
}

interface State {
  /** Every element, any status. */
  all: Map<string, DbElement>;
  active: PurgeElement[];
  activeIds: Set<string>;
  /** Recipes with status 'active' (any arity). */
  recipes: PurgeRecipe[];
  /** Live recipes (result and ingredients active) and the metrics over them. */
  graph: PurgeRecipe[];
  before: { depth: Metric; steps: Metric };
  challenges: ChallengeDay[];
  /** The same days with generator and meta (pred-v6 checks and re-picks). */
  stored: StoredRow[];
  hasMeta: boolean;
  /** Reach as of loading (scripts/lib/reach.ts); null unless loadState was asked for it (plan, apply). */
  reach: Reach | null;
  /** Max recipe created_at (meta.worldAsOf of re-picked days); "" unless loaded with reach. */
  worldAsOf: string;
  window: { first: string; last: string };
  protect: Map<string, NeverPurgeKind[]>;
  /** Database clock when loading started. */
  loadedAt: Date;
}

/**
 * Load the purge state. `reach` (plan and apply only: the commands that call analyze) also reads
 * the reach counts as of loadedAt and the world's max recipe created_at, in ONE read-only
 * transaction on its own connection; the reach queries filter everything by `< loadedAt`, so they
 * describe the same instant as the other reads.
 */
async function loadState(pool: pg.Pool, schema: string, { follower, reach: withReach = false }: { follower: boolean; reach?: boolean }): Promise<State> {
  const aost = follower ? "AS OF SYSTEM TIME follower_read_timestamp()" : "";
  const t0 = performance.now();
  const loadedAt = (await pool.query<{ now: Date }>("SELECT now() AS now")).rows[0]!.now;
  const [hasTags, hasMeta] = await Promise.all([columnExists(pool, schema, "elements", "challenge_tags"), columnExists(pool, schema, "challenges", "meta")]);
  const [els, recs, chs, reachInputs] = await Promise.all([
    pool.query<DbElement>(
      `SELECT id, name, status, is_starter, depth, steps, recognizable, image_status, emoji, notable${hasTags ? ", challenge_tags" : ""} FROM ${schema}.elements ${aost}`,
    ),
    pool.query<{ id: string; ingredient_ids: string[]; result_id: string; protected: boolean }>(
      `SELECT id, ingredient_ids, result_id, protected FROM ${schema}.recipes ${aost} WHERE status = 'active'`,
    ),
    pool.query<{ day: string; easy_id: string; hard_id: string; expert_id: string; source: string; generator: string | null; meta?: DayMeta | null }>(
      `SELECT day::STRING AS day, easy_id::STRING AS easy_id, hard_id::STRING AS hard_id, expert_id::STRING AS expert_id, source, generator${hasMeta ? ", meta" : ""}
         FROM ${schema}.challenges ${aost} ORDER BY day`,
    ),
    withReach ? loadReachSnapshot(pool, schema, loadedAt) : Promise.resolve(null),
  ]);
  const all = new Map(els.rows.map((e) => [e.id, e]));
  const active: PurgeElement[] = els.rows
    .filter((e) => e.status === "active")
    .map((e) => ({ id: e.id, name: e.name, isStarter: e.is_starter, depth: e.depth, steps: e.steps, recognizable: e.recognizable }));
  const activeIds = new Set(active.map((e) => e.id));
  const recipes: PurgeRecipe[] = recs.rows.map((r) => ({ id: r.id, ingredients: r.ingredient_ids, result: r.result_id, protected: r.protected }));
  const graph = liveRecipes(recipes, activeIds);
  const starters = active.filter((e) => e.isStarter).map((e) => e.id);
  const before = { depth: knuthFixpoint(starters, graph, depthOf), steps: knuthFixpoint(starters, graph, stepsOf) };
  const challenges: ChallengeDay[] = chs.rows.map((c) => ({ day: c.day, source: c.source, targets: { easy: c.easy_id, hard: c.hard_id, expert: c.expert_id } }));
  const stored: StoredRow[] = chs.rows.map((c) => ({ day: c.day, source: c.source, generator: c.generator, targets: { easy: c.easy_id, hard: c.hard_id, expert: c.expert_id }, meta: c.meta ?? null }));
  const reach = reachInputs ? computeReach(reachInputs.inputs) : null;
  const window = { first: challengeWindow().first, last: repickCutoff() };
  const protect = neverPurge({ elements: active, recipes, challenges, window, graph, metrics: before });
  console.log(
    `[${schema}] loaded ${fmt(all.size)} elements (${fmt(active.length)} active, ${fmt(before.depth.value.size)} reachable), ` +
      `${fmt(recipes.length)} active recipes (${fmt(graph.length)} live), ${fmt(challenges.length)} challenge days ` +
      `in ${((performance.now() - t0) / 1000).toFixed(1)}s${follower ? " (follower read)" : ""}`,
  );
  return { all, active, activeIds, recipes, graph, before, challenges, stored, hasMeta, reach, worldAsOf: reachInputs?.worldAsOf ?? "", window, protect, loadedAt };
}

async function loadReachSnapshot(pool: pg.Pool, schema: string, asOf: Date): Promise<{ inputs: Awaited<ReturnType<typeof loadReachInputs>>; worldAsOf: string }> {
  const db = await pool.connect();
  try {
    await db.query("BEGIN TRANSACTION READ ONLY");
    const inputs = await loadReachInputs(db, schema, asOf);
    const asOfWorld = await worldAsOf(db, schema);
    await db.query("COMMIT");
    return { inputs, worldAsOf: asOfWorld };
  } catch (e) {
    await db.query("ROLLBACK").catch(() => {});
    throw e;
  } finally {
    db.release();
  }
}

async function requirePurgeSchema(pool: pg.Pool, schema: string): Promise<void> {
  const r = await pool.query(`SELECT 1 FROM ${schema}.schema_migrations WHERE version = '0004_purge'`).catch(() => ({ rowCount: 0 }));
  if (!r.rowCount) throw new UsageError(`schema ${schema} does not have migration 0004_purge yet; run: npm run db:migrate -- --schema=${schema}`);
}

interface VerdictRow {
  element_id: string;
  pass: Pass;
  verdict: string;
  reason: string | null;
  batch: number;
}

async function loadVerdicts(pool: pg.Pool, schema: string, follower: boolean) {
  const aost = follower ? "AS OF SYSTEM TIME follower_read_timestamp()" : "";
  const rows = (await pool.query<VerdictRow>(`SELECT element_id, pass, verdict, reason, batch FROM ${schema}.purge_review ${aost}`)).rows;
  const review = new Map<string, VerdictRow>();
  const verify = new Map<string, VerdictRow>();
  for (const r of rows) (r.pass === "review" ? review : verify).set(r.element_id, r);
  return { rows, review, verify };
}

const kindsOf = (s: State, id: string) => s.protect.get(id)?.join(",") ?? "";
const nameOf = (s: State) => (id: string) => s.all.get(id)?.name;

function shuffled<T>(items: readonly T[]): T[] {
  const a = [...items];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j]!, a[i]!];
  }
  return a;
}

// ---------------------------------------------------------------- export

async function cmdExport(args: string[]) {
  const v = parse("export", args, {
    out: { type: "string" },
    "batch-size": { type: "string" },
    pass: { type: "string" },
    overwrite: { type: "boolean" },
  });
  if (!v.out) throw new UsageError(`missing --out <dir>\n\n${USAGE.export}`);
  const size = positiveInt("batch-size", v["batch-size"], 1000);
  const pass = (v.pass ?? "review") as Pass;
  if (!PASSES.includes(pass)) throw new UsageError(`--pass must be review or verify, got ${JSON.stringify(v.pass)}`);
  const schema = resolveSchema(v.schema);
  const dir = path.resolve(v.out);
  fs.mkdirSync(dir, { recursive: true });
  const stale = fs.readdirSync(dir).filter((f) => /^batch-\d+\.jsonl$/.test(f) || f === "manifest.json");
  if (stale.length && !v.overwrite) throw new UsageError(`${dir} already holds an export (${stale.length} file(s)); pass --overwrite to replace it`);
  for (const f of stale) fs.rmSync(path.join(dir, f));

  const pool = createPool(3);
  try {
    const s = await loadState(pool, schema, { follower: true });
    let reviewReason: Map<string, string> | null = null;
    if (pass === "verify") {
      await requirePurgeSchema(pool, schema);
      const { review } = await loadVerdicts(pool, schema, true);
      reviewReason = new Map([...review.values()].filter((r) => r.verdict === "purge").map((r) => [r.element_id, r.reason ?? ""]));
    }
    const made = madeFromIndex(s.recipes, s.graph, s.before.steps, s.activeIds);
    const name = nameOf(s);
    const ids = s.active
      .filter((e) => !e.isStarter && !s.protect.has(e.id) && (!reviewReason || reviewReason.has(e.id)))
      .map((e) => e.id)
      .sort((a, b) => (BigInt(a) < BigInt(b) ? -1 : 1));
    const batches = chunk(ids, size).map((batchIds, i) => {
      const n = i + 1;
      const file = `batch-${String(n).padStart(3, "0")}.jsonl`;
      const lines = batchIds.map((id) => {
        const r = made.get(id);
        return JSON.stringify({
          id,
          name: name(id),
          depth: s.before.depth.value.get(id) ?? null,
          made_from: r ? recipeLabel(r, name) : null,
          ...(reviewReason ? { review_reason: reviewReason.get(id) } : {}),
        });
      });
      fs.writeFileSync(path.join(dir, file), `${lines.join("\n")}\n`);
      return { n, file, count: batchIds.length, first_id: batchIds[0], last_id: batchIds.at(-1) };
    });
    const manifest = {
      schema,
      pass,
      exported_at: new Date().toISOString(),
      total: ids.length,
      batch_size: size,
      excluded_never_purge: s.active.filter((e) => !e.isStarter && s.protect.has(e.id)).length,
      stage: `npm run --silent db:purge -- stage --pass ${pass} --batch <n> --file <verdicts.json> --manifest ${path.join(dir, "manifest.json").replaceAll("\\", "/")}`,
      batches,
    };
    fs.writeFileSync(path.join(dir, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
    console.log(
      `Exported ${fmt(ids.length)} element(s) in ${batches.length} batch(es) of <= ${size} to ${dir} ` +
        `(${fmt(manifest.excluded_never_purge)} never-purge element(s) and the starters excluded).\nManifest: ${path.join(dir, "manifest.json")}`,
    );
  } finally {
    await pool.end();
  }
}

// ---------------------------------------------------------------- stage

interface Manifest {
  schema?: string;
  pass?: string;
  batches: { n: number; file: string; count: number }[];
}

function readManifest(file: string): { manifest: Manifest; dir: string } {
  let manifest: Manifest;
  try {
    manifest = JSON.parse(fs.readFileSync(file, "utf8")) as Manifest;
  } catch (e) {
    throw new UsageError(`cannot read manifest ${file}: ${(e as Error).message}`);
  }
  if (!Array.isArray(manifest?.batches)) throw new UsageError(`${file} is not an export manifest (no "batches" array)`);
  return { manifest, dir: path.dirname(path.resolve(file)) };
}

function batchIdsFromManifest(file: string, batch: number): Set<string> {
  const { manifest, dir } = readManifest(file);
  const entry = manifest.batches.find((b) => b.n === batch);
  if (!entry) throw new UsageError(`batch ${batch} is not in ${file} (batches 1..${manifest.batches.length})`);
  const ids = new Set<string>();
  for (const line of fs.readFileSync(path.join(dir, entry.file), "utf8").split(/\r?\n/)) {
    if (line.trim()) ids.add((JSON.parse(line) as { id: string }).id);
  }
  return ids;
}

async function cmdStage(args: string[]) {
  const v = parse("stage", args, { pass: { type: "string" }, batch: { type: "string" }, file: { type: "string" }, manifest: { type: "string" } });
  const missing = (["pass", "batch", "file"] as const).filter((k) => !v[k]);
  if (missing.length) throw new UsageError(`missing ${missing.map((k) => `--${k}`).join(", ")}\n\n${STAGE_USAGE}`);
  const pass = v.pass!.trim().toLowerCase() as Pass;
  if (!PASSES.includes(pass)) throw new UsageError(`--pass must be "review" or "verify", got ${JSON.stringify(v.pass)}`);
  const batch = positiveInt("batch", v.batch);
  const file = path.resolve(v.file!);
  if (!fs.existsSync(file)) throw new UsageError(`--file ${file} does not exist`);
  const parsed = parseVerdictFile(fs.readFileSync(file, "utf8"));
  const fail = (problems: string[]) => {
    const shown = problems.slice(0, 50);
    throw new UsageError(
      `nothing was staged: ${problems.length} problem(s) in ${file}:\n` +
        shown.map((p) => `  - ${p}`).join("\n") +
        (problems.length > shown.length ? `\n  ... and ${problems.length - shown.length} more` : "") +
        `\nFix the file and run the same command again (run with --help for the format).`,
    );
  };
  if (!parsed.ok) fail(parsed.errors);
  const items = (parsed as Extract<typeof parsed, { ok: true }>).items;
  const warnings = (parsed as Extract<typeof parsed, { ok: true }>).warnings;
  const batchIds = v.manifest ? batchIdsFromManifest(v.manifest, batch) : undefined;
  const schema = resolveSchema(v.schema);

  const pool = createPool(1);
  try {
    await requirePurgeSchema(pool, schema);
    const ids = items.map((i) => i.id);
    const rows = await retrying("stage lookup", () =>
      pool.query<{ id: string; name: string; status: string }>(`SELECT id, name, status FROM ${schema}.elements WHERE id = ANY($1::INT8[])`, [ids]),
    );
    const elements = new Map(rows.rows.map((r) => [r.id, r]));
    let reviewPurge: Set<string> | undefined;
    if (pass === "verify") {
      const r = await pool.query<{ element_id: string }>(
        `SELECT element_id FROM ${schema}.purge_review WHERE pass = 'review' AND verdict = 'purge' AND element_id = ANY($1::INT8[])`,
        [ids],
      );
      reviewPurge = new Set(r.rows.map((x) => x.element_id));
    }
    const problems = checkVerdicts(items, { pass, elements, reviewPurge, batchIds, batch });
    if (problems.length) fail(problems);

    await withTx(pool, "stage verdicts", async (c) => {
      for (const part of chunk(items, 1_000)) {
        await c.query(
          `INSERT INTO ${schema}.purge_review (element_id, pass, batch, verdict, reason, reviewed_at)
           SELECT u.id, $2, $3, u.verdict, u.reason, now()
             FROM unnest($1::INT8[], $4::STRING[], $5::STRING[]) AS u(id, verdict, reason)
           ON CONFLICT (element_id, pass) DO UPDATE
             SET batch = excluded.batch, verdict = excluded.verdict, reason = excluded.reason, reviewed_at = excluded.reviewed_at`,
          [part.map((i) => i.id), pass, batch, part.map((i) => i.verdict), part.map((i) => i.reason || null)],
        );
      }
    });
    const purge = items.filter((i) => i.verdict === "purge").length;
    let coverage = "";
    if (batchIds) {
      const r = await pool.query<{ n: string }>(`SELECT count(*) AS n FROM ${schema}.purge_review WHERE pass = $1 AND element_id = ANY($2::INT8[])`, [
        pass,
        [...batchIds],
      ]);
      coverage = `; batch ${batch} now has ${r.rows[0]!.n}/${batchIds.size} ${pass} verdicts`;
    }
    console.log(
      `OK staged ${items.length} ${pass} verdict(s) for batch ${batch} into ${schema}.purge_review: ${purge} purge, ${items.length - purge} keep${coverage}` +
        `${warnings.length ? ` (${warnings.length} duplicate id(s) merged)` : ""}`,
    );
  } finally {
    await pool.end();
  }
}

// ---------------------------------------------------------------- status

async function cmdStatus(args: string[]) {
  const v = parse("status", args, { manifest: { type: "string" } });
  const schema = resolveSchema(v.schema);
  const pool = createPool(1);
  try {
    await requirePurgeSchema(pool, schema);
    const totals = await pool.query<{ pass: string; verdict: string; n: string }>(
      `SELECT pass, verdict, count(*) AS n FROM ${schema}.purge_review GROUP BY 1, 2 ORDER BY 1, 2`,
    );
    console.log(`[${schema}] staged verdicts:`);
    printTable(totals.rows.map((r) => ({ pass: r.pass, verdict: r.verdict, count: fmt(Number(r.n)) })));
    const agreed = await pool.query<{ n: string }>(
      `SELECT count(*) AS n FROM ${schema}.purge_review r JOIN ${schema}.purge_review v ON v.element_id = r.element_id AND v.pass = 'verify'
        WHERE r.pass = 'review' AND r.verdict = 'purge' AND v.verdict = 'purge'`,
    );
    const awaiting = await pool.query<{ n: string }>(
      `SELECT count(*) AS n FROM ${schema}.purge_review r LEFT JOIN ${schema}.purge_review v ON v.element_id = r.element_id AND v.pass = 'verify'
        WHERE r.pass = 'review' AND r.verdict = 'purge' AND v.element_id IS NULL`,
    );
    console.log(`\nAgreed purge (review + verify): ${fmt(Number(agreed.rows[0]!.n))}; review "purge" awaiting verify: ${fmt(Number(awaiting.rows[0]!.n))}`);
    const perBatch = await pool.query<{ pass: string; batch: number; n: string; purge: string }>(
      `SELECT pass, batch, count(*) AS n, count(*) FILTER (WHERE verdict = 'purge') AS purge FROM ${schema}.purge_review GROUP BY 1, 2 ORDER BY 1, 2`,
    );
    if (v.manifest) {
      const { manifest } = readManifest(v.manifest);
      const pass = manifest.pass ?? "review";
      const got = new Map(perBatch.rows.filter((r) => r.pass === pass).map((r) => [r.batch, Number(r.n)]));
      const incomplete = manifest.batches.filter((b) => (got.get(b.n) ?? 0) < b.count);
      console.log(
        `\nManifest ${v.manifest} (pass ${pass}): ${manifest.batches.length - incomplete.length}/${manifest.batches.length} batch(es) complete.` +
          (incomplete.length ? `\nIncomplete: ${incomplete.map((b) => `${b.n} (${got.get(b.n) ?? 0}/${b.count})`).join(", ")}` : ""),
      );
    } else if (perBatch.rows.length) {
      console.log("\nPer batch:");
      printTable(perBatch.rows.map((r) => ({ pass: r.pass, batch: r.batch, verdicts: Number(r.n), purge: Number(r.purge) })));
    }
  } finally {
    await pool.end();
  }
}

// ---------------------------------------------------------------- plan

interface RegenDay {
  day: string;
  /** The tiers this purge breaks (check-challenges broken problems that were not broken before). */
  tiers: { tier: Tier; id: string; why: string }[];
  old: DayTargets;
  new: DayTargets | null;
}

interface Analysis {
  effect: PurgeEffect;
  cutoff: string;
  regen: RegenDay[];
  /** The re-picked rows (with meta) behind `regen` (not written to the plan file). */
  planned: PlannedRow[];
  /** Future generated days that were already broken before this purge (left alone). */
  preexistingBroken: number;
  regenError: string | null;
  stepsAfter: Map<string, number | null>;
}

/**
 * The generator's world on one side of the purge: active elements with depth/steps from that
 * side's metrics (purges raise steps), live 2-ingredient recipes, the live recipes of every arity
 * (C5b safe routes), and reach as loaded.
 */
function v6Context(s: State, elements: readonly PurgeElement[], metrics: { depth: Metric; steps: Metric }, pairs: readonly PurgeRecipe[], live: readonly PurgeRecipe[]) {
  if (!s.reach) throw new Error("internal: loadState was called without reach");
  const pool: PoolElement[] = elements.map((e) => {
    const db = s.all.get(e.id);
    return {
      id: e.id,
      name: e.name,
      isStarter: e.isStarter,
      recognizable: e.recognizable,
      depth: metrics.depth.value.get(e.id) ?? null,
      steps: metrics.steps.value.get(e.id) ?? null,
      imageStatus: db?.image_status ?? null,
      emoji: db?.emoji ?? null,
      notable: db?.notable ?? false,
      tags: db?.challenge_tags ?? null,
    };
  });
  return makeContext({ elements: pool, recipes: pairs, allRecipes: live, reach: s.reach });
}

/** Cascade + challenge consequences of purging `direct` from the loaded state. */
function analyze(s: State, direct: Iterable<string>, cascade = true): Analysis {
  const effect = computePurge({ elements: s.active, recipes: s.recipes, direct, protect: s.protect, cascade });
  const afterEls = s.active.filter((e) => !effect.removed.has(e.id));
  const afterIds = new Set(afterEls.map((e) => e.id));
  const cutoff = repickCutoff();
  const today = utcDay();
  const liveAfter = s.graph.filter((r) => afterIds.has(r.result) && r.ingredients.every((i) => afterIds.has(i)));
  const pairsBefore = s.graph.filter((r) => r.ingredients.length === 2);
  const pairsAfter = liveAfter.filter((r) => r.ingredients.length === 2);
  const ctxBefore = v6Context(s, s.active, s.before, pairsBefore, s.graph);
  const ctxAfter = v6Context(s, afterEls, effect.after, pairsAfter, liveAfter);
  const future = s.stored.filter((c) => c.source === "generated" && c.day > cutoff);
  const brokenKeys = (issues: ReturnType<typeof checkDays>) => new Set(issues.filter((i) => i.severity === "broken").map((i) => `${i.day}:${i.tier}`));
  const before = brokenKeys(checkDays(future, ctxBefore, { today }));
  const afterIssues = checkDays(future, ctxAfter, { today }).filter((i) => i.severity === "broken" && !before.has(`${i.day}:${i.tier}`));
  const byDay = new Map<string, RegenDay["tiers"]>();
  for (const i of afterIssues) {
    const list = byDay.get(i.day) ?? [];
    if (!list.some((t) => t.tier === i.tier)) list.push({ tier: i.tier, id: i.id, why: i.problem });
    byDay.set(i.day, list);
  }
  const broken = [...byDay].sort((a, b) => (a[0] < b[0] ? -1 : 1));
  const preexistingBroken = new Set([...before].map((k) => k.slice(0, 10))).size;
  const stepsAfter = new Map<string, number | null>([...effect.after.steps.value]);
  const oldOf = (day: string) => s.stored.find((c) => c.day === day)!.targets;
  let regen: RegenDay[] = broken.map(([day, tiers]) => ({ day, tiers, old: oldOf(day), new: null }));
  let planned: PlannedRow[] = [];
  let regenError: string | null = null;
  if (broken.length) {
    try {
      const { cands } = buildCandidates(ctxAfter);
      const { pools } = buildPools(cands);
      const versions = new Map<string, number>();
      for (const e of s.all.values()) if (e.challenge_tags?.v) versions.set(e.challenge_tags.v, (versions.get(e.challenge_tags.v) ?? 0) + 1);
      const rows = planDays(ctxAfter, cands, pools, {
        days: broken.map(([d]) => d),
        stored: s.stored,
        provenance: {
          configHash: configHash(),
          gitSha: gitSha(),
          classifierVersion: [...versions].sort((a, b) => b[1] - a[1])[0]?.[0] ?? "none",
          pickedAt: new Date().toISOString(),
          worldAsOf: s.worldAsOf || s.loadedAt.toISOString(),
        },
      }).rows;
      // The same plan hash generate-challenges makePlan writes (days, targets, school-basis p).
      const planHash = planHashOf(rows);
      planned = rows.map((r) => ({ ...r, meta: { ...r.meta, planHash } }));
      const byPlan = new Map(planned.map((r) => [r.day, r.targets]));
      regen = regen.map((r) => ({ ...r, new: byPlan.get(r.day) ?? null }));
    } catch (e) {
      regenError = (e as Error).message;
    }
  }
  return { effect, cutoff, regen, planned, preexistingBroken, regenError, stepsAfter };
}

interface Libraries {
  discovery_rows: number;
  players: number;
  top_owned: { id: string; name: string; set: "direct" | "orphan"; owners: number }[];
}

async function libraryImpact(pool: pg.Pool, schema: string, s: State, effect: PurgeEffect, follower: boolean): Promise<Libraries> {
  const ids = [...effect.removed];
  if (ids.length === 0) return { discovery_rows: 0, players: 0, top_owned: [] };
  const aost = follower ? "AS OF SYSTEM TIME follower_read_timestamp()" : "";
  const [tot, per] = await Promise.all([
    pool.query<{ n: string; players: string }>(
      `SELECT count(*) AS n, count(DISTINCT player_id) AS players FROM ${schema}.discoveries ${aost} WHERE element_id = ANY($1::INT8[])`,
      [ids],
    ),
    pool.query<{ element_id: string; owners: string }>(
      `SELECT element_id, count(*) AS owners FROM ${schema}.discoveries ${aost} WHERE element_id = ANY($1::INT8[])
        GROUP BY element_id ORDER BY owners DESC, element_id LIMIT 50`,
      [ids],
    ),
  ]);
  const orphanSet = new Set(effect.orphans);
  return {
    discovery_rows: Number(tot.rows[0]!.n),
    players: Number(tot.rows[0]!.players),
    top_owned: per.rows.map((r) => ({ id: r.element_id, name: s.all.get(r.element_id)?.name ?? "?", set: orphanSet.has(r.element_id) ? "orphan" : "direct", owners: Number(r.owners) })),
  };
}

function summarize(s: State, a: Analysis) {
  const e = a.effect;
  const collisionKinds = new Map<string, number>();
  for (const id of e.collisions) for (const k of s.protect.get(id) ?? []) collisionKinds.set(k, (collisionKinds.get(k) ?? 0) + 1);
  return {
    active_before: s.active.length,
    reachable_before: e.reachableBefore,
    reachable_after: e.reachableAfter,
    unreachable_before_left_alone: e.unreachableBefore,
    direct: e.direct.length,
    orphans: e.orphans.length,
    cascade_rounds: e.rounds,
    active_after: s.active.length - e.removed.size,
    recipes_by_result: e.recipesByResult.length,
    recipes_by_ingredient: e.recipesByIngredient.length,
    protected_recipe_hits: e.protectedHits.length,
    protected_collisions: e.collisions.length,
    protected_collisions_by_kind: Object.fromEntries(collisionKinds),
    depth_steps_updates: e.updates.length,
    challenge_days_to_repick: a.regen.length,
    skipped_never_purge: e.skipped.filter((x) => x.why === "never-purge").length,
    skipped_not_active: e.skipped.filter((x) => x.why === "not-active").length,
  };
}

function printReport(s: State, a: Analysis, libs: Libraries, verdictInfo: Record<string, number>, sampleN: number, reasons: Map<string, string>) {
  const e = a.effect;
  const name = nameOf(s);
  const made = madeFromIndex(s.recipes, s.graph, s.before.steps, s.activeIds);
  const label = (id: string) => {
    const r = made.get(id);
    return r ? recipeLabel(r, name) : "-";
  };
  console.log("\nVerdicts:");
  printTable(Object.entries(verdictInfo).map(([k, n]) => ({ verdicts: k, count: fmt(n) })));
  console.log("\nEffect:");
  printTable(
    Object.entries(summarize(s, a))
      .filter(([, v]) => typeof v === "number")
      .map(([k, v]) => ({ metric: k, value: fmt(v as number) })),
  );
  console.log(
    `\nNever-purge set: ${fmt(s.protect.size)} element(s) (window ${s.window.first} .. ${s.window.last}): ` +
      (["starter", "challenge-target", "live-path", "protected-recipe"] as const)
        .map((k) => `${k} ${fmt([...s.protect.values()].filter((v) => v.includes(k)).length)}`)
        .join(", "),
  );
  if (e.collisions.length) {
    console.log(
      `\n!!!!! WARNING: ${e.collisions.length} never-purge element(s) become UNREACHABLE from the starters (kept active, their recipes kept):`,
    );
    printTable(e.collisions.slice(0, 60).map((id) => ({ id, name: name(id) ?? "?", kinds: kindsOf(s, id), made_from: label(id) })));
    if (e.collisions.length > 60) console.log(`  ... and ${e.collisions.length - 60} more (see the plan file)`);
  }
  if (e.protectedHits.length) console.log(`\n!!!!! WARNING: ${e.protectedHits.length} protected recipe(s) touch a removed element; they are NOT quarantined.`);
  console.log(
    `\nChallenge days after ${a.cutoff} to re-pick: ${a.regen.length}` +
      (a.preexistingBroken ? ` (${a.preexistingBroken} future day(s) were already broken before this purge: left as they are; see db:check-challenges)` : ""),
  );
  if (a.regenError) console.log(`!!!!! WARNING: cannot re-pick: ${a.regenError}`);
  if (a.regen.length) {
    printTable(
      a.regen.slice(0, 30).map((r) => ({
        day: r.day,
        broken: r.tiers.map((t) => `${t.tier}:${name(t.id) ?? t.id} (${t.why})`).join("; "),
        new: r.new ? TIERS.map((t) => name(r.new![t]) ?? r.new![t]).join(" / ") : "?",
      })),
    );
    if (a.regen.length > 30) console.log(`  ... and ${a.regen.length - 30} more`);
  }
  console.log(`\nPlayer libraries: ${fmt(libs.discovery_rows)} discovery row(s) of ${fmt(libs.players)} player(s) touch removed elements.`);
  if (libs.top_owned.length) {
    console.log("Most-owned removed elements:");
    printTable(libs.top_owned.map((t) => ({ name: t.name, set: t.set, owners: t.owners, made_from: label(t.id) })));
  }
  console.log(`\n${Math.min(sampleN, e.direct.length)} random direct purges:`);
  printTable(shuffled(e.direct).slice(0, sampleN).map((id) => ({ name: name(id) ?? "?", depth: s.before.depth.value.get(id) ?? "-", made_from: label(id), reason: reasons.get(id) ?? "" })));
  console.log(`\n${Math.min(sampleN, e.orphans.length)} random orphans (reachable only through purged elements):`);
  printTable(shuffled(e.orphans).slice(0, sampleN).map((id) => ({ name: name(id) ?? "?", depth: s.before.depth.value.get(id) ?? "-", made_from: label(id) })));
}

function agreedSet(v: Awaited<ReturnType<typeof loadVerdicts>>, reviewOnly: boolean): Set<string> {
  const out = new Set<string>();
  for (const [id, r] of v.review) if (r.verdict === "purge" && (reviewOnly || v.verify.get(id)?.verdict === "purge")) out.add(id);
  return out;
}

function verdictStats(v: Awaited<ReturnType<typeof loadVerdicts>>): Record<string, number> {
  const count = (m: Map<string, VerdictRow>, verdict: string) => [...m.values()].filter((r) => r.verdict === verdict).length;
  let awaiting = 0;
  let agreed = 0;
  for (const [id, r] of v.review) {
    if (r.verdict !== "purge") continue;
    const w = v.verify.get(id);
    if (!w) awaiting++;
    else if (w.verdict === "purge") agreed++;
  }
  return {
    "review purge": count(v.review, "purge"),
    "review keep": count(v.review, "keep"),
    "verify purge": count(v.verify, "purge"),
    "verify keep": count(v.verify, "keep"),
    "review purge awaiting verify": awaiting,
    "agreed purge (review + verify)": agreed,
  };
}

const reasonsOf = (v: Awaited<ReturnType<typeof loadVerdicts>>) => {
  const m = new Map<string, string>();
  for (const [id, r] of v.review) {
    const w = v.verify.get(id);
    m.set(id, [r.reason, w?.reason].filter(Boolean).join(" | "));
  }
  return m;
};

async function cmdPlan(args: string[]) {
  const v = parse("plan", args, { out: { type: "string" }, "review-only": { type: "boolean" }, "no-cascade": { type: "boolean" }, sample: { type: "string" } });
  const cascade = !(v["no-cascade"] ?? false);
  const schema = resolveSchema(v.schema);
  const reviewOnly = v["review-only"] ?? false;
  const sampleN = positiveInt("sample", v.sample, 40);
  const out = path.resolve(v.out ?? path.join(os.tmpdir(), `purge-plan-${makeRunId().slice(6)}.json`));
  const pool = createPool(3);
  try {
    await requirePurgeSchema(pool, schema);
    // Fresh reads (not follower reads): verdicts staged seconds ago must be in the plan.
    const s = await loadState(pool, schema, { follower: false, reach: true });
    const verdicts = await loadVerdicts(pool, schema, false);
    const agreed = agreedSet(verdicts, reviewOnly);
    const a = analyze(s, agreed, cascade);
    const libs = await libraryImpact(pool, schema, s, a.effect, false);
    const reasons = reasonsOf(verdicts);
    const name = nameOf(s);
    const made = madeFromIndex(s.recipes, s.graph, s.before.steps, s.activeIds);
    const label = (id: string) => {
      const r = made.get(id);
      return r ? recipeLabel(r, name) : null;
    };
    const plan = {
      version: PLAN_VERSION,
      schema,
      preview: reviewOnly,
      cascade,
      created_at: new Date().toISOString(),
      window: s.window,
      verdicts: verdictStats(verdicts),
      summary: summarize(s, a),
      never_purge: Object.fromEntries(
        (["starter", "challenge-target", "live-path", "protected-recipe"] as const).map((k) => [k, [...s.protect.values()].filter((x) => x.includes(k)).length]),
      ),
      direct: a.effect.direct.map((id) => ({ id, name: name(id), reason: reasons.get(id) ?? "", made_from: label(id) })),
      orphans: a.effect.orphans.map((id) => ({ id, name: name(id), made_from: label(id) })),
      collisions: a.effect.collisions.map((id) => ({ id, name: name(id), kinds: s.protect.get(id) ?? [], made_from: label(id) })),
      skipped: a.effect.skipped,
      recipes: {
        by_result: a.effect.recipesByResult.length,
        by_ingredient: a.effect.recipesByIngredient.length,
        protected_hits: a.effect.protectedHits.map((r) => r.id),
      },
      challenges: { cutoff: a.cutoff, preexisting_broken: a.preexistingBroken, error: a.regenError, repick: a.regen },
      libraries: libs,
    };
    fs.mkdirSync(path.dirname(out), { recursive: true });
    fs.writeFileSync(out, `${JSON.stringify(plan, null, 1)}\n`);
    printReport(s, a, libs, plan.verdicts, sampleN, reasons);
    console.log(`\nPlan written to ${out}${reviewOnly ? " (PREVIEW from review verdicts only; apply refuses it)" : ""}`);
    if (!reviewOnly) console.log(`Next: npm run db:purge -- apply --plan ${out.replaceAll("\\", "/")} --dry-run`);
  } finally {
    await pool.end();
  }
}

// ---------------------------------------------------------------- apply

interface PlanFile {
  version: number;
  schema: string;
  preview: boolean;
  /** Absent in older plans (= true). */
  cascade?: boolean;
  created_at: string;
  summary: ReturnType<typeof summarize>;
  direct: { id: string; name: string }[];
  skipped?: { id: string; why: string }[];
}

async function writeMeta(pool: pg.Pool, schema: string, key: string, value: unknown, merge = false) {
  await retrying("meta", () =>
    pool.query(
      merge
        ? `INSERT INTO ${schema}.meta (key, value, updated_at) VALUES ($1, $2::JSONB, now())
           ON CONFLICT (key) DO UPDATE SET value = ${schema}.meta.value || excluded.value, updated_at = now()`
        : `UPSERT INTO ${schema}.meta (key, value, updated_at) VALUES ($1, $2::JSONB, now())`,
      [key, JSON.stringify(value)],
    ),
  );
}

async function refreshKnownCount(pool: pg.Pool, schema: string) {
  await pool.query(
    `UPSERT INTO ${schema}.meta (key, value, updated_at) SELECT 'known_count', to_jsonb(count(*)), now() FROM ${schema}.elements WHERE status = 'active'`,
  );
}

/** Run `rows` through `fn` in batched transactions; returns the total of the returned counts. */
async function batched<T>(pool: pg.Pool, label: string, rows: T[], size: number, fn: (c: pg.PoolClient, batch: T[]) => Promise<number>): Promise<number> {
  let total = 0;
  const batches = chunk(rows, size);
  for (const [i, batch] of batches.entries()) {
    total += await withTx(pool, `${label} ${i + 1}/${batches.length}`, (c) => fn(c, batch));
    if ((i + 1) % 10 === 0 || i + 1 === batches.length) console.log(`  ${label}: ${fmt(Math.min((i + 1) * size, rows.length))}/${fmt(rows.length)}`);
  }
  return total;
}

async function quarantineRecipes(pool: pg.Pool, schema: string, run: string, label: string, recipes: PurgeRecipe[]): Promise<number> {
  // Guarded by the expected result: a recipe healed (re-rolled) meanwhile is left alone.
  return batched(pool, label, recipes, RECIPE_TX, async (c, b) => {
    const r = await c.query(
      `UPDATE ${schema}.recipes AS r SET status = 'quarantined', purge_run = $3
         FROM unnest($1::INT8[], $2::INT8[]) AS u(id, result_id)
        WHERE r.id = u.id AND r.result_id = u.result_id AND r.status = 'active' AND NOT r.protected`,
      [b.map((x) => x.id), b.map((x) => x.result), run],
    );
    return r.rowCount ?? 0;
  });
}

async function writeDepthSteps(pool: pg.Pool, schema: string, updates: { id: string; depth: number | null; steps: number | null }[]): Promise<number> {
  return batched(pool, "depth/steps", updates, DEPTH_TX, async (c, b) => {
    const r = await c.query(
      `UPDATE ${schema}.elements AS e SET depth = u.d, steps = u.s
         FROM unnest($1::INT8[], $2::INT4[], $3::INT4[]) AS u(id, d, s)
        WHERE e.id = u.id AND e.status = 'active'`,
      [b.map((x) => x.id), b.map((x) => x.depth), b.map((x) => x.steps)],
    );
    return r.rowCount ?? 0;
  });
}

async function cmdApply(args: string[]) {
  const v = parse("apply", args, { plan: { type: "string" }, "dry-run": { type: "boolean" }, "max-fraction": { type: "string" }, "allow-no-meta": { type: "boolean" } });
  if (!v.plan) throw new UsageError(`missing --plan <file>\n\n${USAGE.apply}`);
  const maxFraction = v["max-fraction"] === undefined ? 0.75 : Number(v["max-fraction"]);
  if (!(maxFraction > 0 && maxFraction <= 1)) throw new UsageError("--max-fraction must be in (0, 1]");
  let plan: PlanFile;
  try {
    plan = JSON.parse(fs.readFileSync(path.resolve(v.plan), "utf8")) as PlanFile;
  } catch (e) {
    throw new UsageError(`cannot read plan ${v.plan}: ${(e as Error).message}`);
  }
  if (plan.version !== PLAN_VERSION || !Array.isArray(plan.direct)) throw new UsageError(`${v.plan} is not a purge plan (version ${PLAN_VERSION})`);
  if (plan.preview) throw new UsageError(`${v.plan} is a --review-only preview; run plan without --review-only after the verify pass`);
  const schema = resolveSchema(v.schema ?? plan.schema);
  if (schema !== plan.schema) throw new UsageError(`the plan is for schema ${plan.schema}, not ${schema}`);
  const dryRun = v["dry-run"] ?? false;

  const pool = createPool(3);
  try {
    await requirePurgeSchema(pool, schema);
    // ---- re-validate against the current database
    const s = await loadState(pool, schema, { follower: false, reach: true });
    const verdicts = await loadVerdicts(pool, schema, false);
    const agreed = agreedSet(verdicts, false);
    const planned = new Set(plan.direct.map((d) => d.id));
    const candidates = [...planned].filter((id) => agreed.has(id));
    const lostVerdict = planned.size - candidates.length;
    const planSkipped = new Set((plan.skipped ?? []).map((x) => x.id));
    const newSincePlan = [...agreed].filter((id) => !planned.has(id) && !planSkipped.has(id) && s.activeIds.has(id)).length;
    const a = analyze(s, candidates, plan.cascade ?? true);
    const e = a.effect;
    const now = summarize(s, a);
    console.log(`\nRe-validated plan ${v.plan} (created ${plan.created_at}):`);
    printTable(
      (Object.keys(now) as (keyof typeof now)[])
        .filter((k) => typeof now[k] === "number" && !k.startsWith("skipped_")) // apply only considers the plan's direct ids
        .map((k) => ({ metric: k, plan: fmt(Number(plan.summary?.[k] ?? 0)), now: fmt(now[k] as number) })),
    );
    if (lostVerdict) console.warn(`  ${lostVerdict} planned id(s) no longer have agreed purge verdicts: dropped.`);
    if (newSincePlan) console.warn(`  ${newSincePlan} agreed id(s) are not in this plan (staged after it): ignored; run plan again to include them.`);
    if (e.collisions.length) console.warn(`  !!!!! ${e.collisions.length} never-purge element(s) become unreachable (kept active); see the plan report.`);
    if (a.regenError) throw new Error(`cannot re-pick the affected challenge days: ${a.regenError}`);
    if (e.protectedHits.length) throw new Error(`${e.protectedHits.length} protected recipe(s) touch removed elements; refusing (bug in the never-purge set?)`);
    const nonStarters = s.active.filter((x) => !x.isStarter).length;
    if (e.removed.size > maxFraction * nonStarters) {
      throw new Error(`refusing: ${fmt(e.removed.size)} of ${fmt(nonStarters)} active elements would be removed (> --max-fraction ${maxFraction})`);
    }
    if (e.removed.size === 0) {
      console.log("\nNothing to purge.");
      return;
    }
    // Before any write: a re-pick without challenges.meta would lose meta.replaced (and a holdout
    // day's pre-v6 targets); refuse the whole apply rather than purge and leave broken days.
    try {
      refuseWithoutMeta(
        a.regen.filter((r) => r.new).map((r) => r.day),
        s.hasMeta,
        v["allow-no-meta"] ?? false,
        "purge's challenge re-pick",
      );
    } catch (err) {
      if (!dryRun) throw err;
      console.warn(`  the apply would refuse: ${(err as Error).message}`);
    }
    if (dryRun) {
      console.log(`\nDry run: nothing written. Would quarantine ${fmt(e.direct.length)} + ${fmt(e.orphans.length)} orphan(s), ${fmt(e.recipesByResult.length + e.recipesByIngredient.length)} recipe(s), re-pick ${a.regen.length} day(s).`);
      return;
    }

    // ---- execute
    const run = makeRunId();
    const key = `purge:${run}`;
    const t0 = performance.now();
    console.log(`\nApplying run ${run} to ${schema} ...`);
    await writeMeta(pool, schema, key, { run, schema, status: "started", plan_file: path.resolve(v.plan), plan_created_at: plan.created_at, started_at: new Date().toISOString(), summary: now });

    const quarantine = (ids: string[], reason: string, label: string) =>
      batched(pool, label, ids, ELEMENT_TX, async (c, b) => {
        const r = await c.query(
          `UPDATE ${schema}.elements SET status = 'quarantined', quarantine_reason = $2, purge_run = $3
                  ${reason === REASON.orphaned ? ", depth = NULL, steps = NULL" : ""}
            WHERE id = ANY($1::INT8[]) AND status = 'active' AND NOT is_starter`,
          [b, reason, run],
        );
        return r.rowCount ?? 0;
      });
    // Elements first: a recipe must never be quarantined while its result is still active (the
    // next combine would re-roll a recipe whose result is fine).
    const directDone = await quarantine(e.direct, REASON.review, "elements (review)");
    const orphansDone = await quarantine(e.orphans, REASON.orphaned, "elements (orphaned)");
    const byResult = await quarantineRecipes(pool, schema, run, "recipes (by result)", e.recipesByResult);
    const byIngredient = await quarantineRecipes(pool, schema, run, "recipes (by ingredient)", e.recipesByIngredient);
    // Recipes created by players while this ran (a removed element was still combinable).
    const late = (
      await pool.query<{ id: string; ingredient_ids: string[]; result_id: string; protected: boolean }>(
        `SELECT id, ingredient_ids, result_id, protected FROM ${schema}.recipes WHERE status = 'active' AND created_at >= $1`,
        [s.loadedAt],
      )
    ).rows
      .map((r) => ({ id: r.id, ingredients: r.ingredient_ids, result: r.result_id, protected: r.protected }))
      .filter((r) => !r.protected && (e.removed.has(r.result) || r.ingredients.some((i) => e.removed.has(i))));
    const lateDone = late.length ? await quarantineRecipes(pool, schema, run, "recipes (created during the run)", late) : 0;
    const depthDone = await writeDepthSteps(pool, schema, e.updates);

    // ---- re-pick affected future challenge days (cutoff re-checked now: never today, the teaser day or the past)
    const cutoff = repickCutoff();
    const regen = a.regen.filter((r) => r.day > cutoff && r.new);
    if (regen.length < a.regen.length) console.warn(`  ${a.regen.length - regen.length} affected day(s) entered the live window during the run and were NOT re-picked`);
    let regenerated = 0;
    if (regen.length) {
      const days = regen.map((r) => r.day);
      const rows = a.planned.filter((r) => days.includes(r.day));
      const at = new Date().toISOString();
      regenerated = await withTx(pool, "re-pick challenge days", async (c) => {
        // The generator's safety checks: no completions on these days, generated rows only.
        const done = await completionsOn(c, schema, days);
        if (done.size) throw new Error(`refusing to re-pick: challenge completion(s) on ${[...done.keys()].join(", ")}`);
        const del = await c.query(`DELETE FROM ${schema}.challenges WHERE source = 'generated' AND day = ANY($1::DATE[]) AND day > $2::DATE`, [days, cutoff]);
        if ((del.rowCount ?? 0) !== days.length) throw new Error(`expected to delete ${days.length} generated day(s), deleted ${del.rowCount}; rolled back`);
        const old = new Map(s.stored.map((x) => [x.day, x]));
        const toWrite = rows.map((r) => ({ ...r, meta: { ...r.meta, replaced: nextReplaced(old.get(r.day) ?? null, `purge:${run}`, at) } }));
        const ins = await insertRows(c, schema, toWrite, { hasMeta: s.hasMeta, onConflict: "error" });
        if (ins !== days.length) throw new Error(`expected to insert ${days.length} day(s), inserted ${ins}; rolled back`);
        return ins;
      });
    }
    await refreshKnownCount(pool, schema);
    const counts = {
      direct: directDone,
      orphans: orphansDone,
      recipes_by_result: byResult,
      recipes_by_ingredient: byIngredient,
      recipes_late: lateDone,
      depth_steps_updates: depthDone,
      challenge_days_repicked: regenerated,
      collisions: e.collisions.length,
    };
    await writeMeta(
      pool,
      schema,
      key,
      {
        status: "applied",
        applied_at: new Date().toISOString(),
        seconds: Math.round((performance.now() - t0) / 1000),
        counts,
        collisions: e.collisions.map((id) => ({ id, name: s.all.get(id)?.name, kinds: s.protect.get(id) })),
        repicked: regen.map((r) => ({ day: r.day, old: r.old, new: r.new })),
        sample_direct: e.direct.slice(0, 50).map((id) => s.all.get(id)?.name),
      },
      true,
    );
    console.log(`\nApplied ${run} in ${((performance.now() - t0) / 1000).toFixed(0)}s:`);
    printTable(Object.entries(counts).map(([k, n]) => ({ step: k, rows: fmt(n) })));
    await verify(pool, schema, run, [...e.removed]);
    console.log(`\nUndo with: npm run db:purge -- restore --run ${run}${schema !== "alchemy" ? ` --schema ${schema}` : ""}`);
  } finally {
    await pool.end();
  }
}

/** Post-apply checks: counts by status/reason, integrity, today's challenge, a sample library. */
async function verify(pool: pg.Pool, schema: string, run: string, removed: string[]) {
  console.log("\nVerification:");
  const byStatus = await pool.query<{ status: string; reason: string | null; n: string }>(
    `SELECT status, quarantine_reason AS reason, count(*) AS n FROM ${schema}.elements GROUP BY 1, 2 ORDER BY 1, 2`,
  );
  console.log(`-- SELECT status, quarantine_reason, count(*) FROM ${schema}.elements GROUP BY 1, 2;`);
  printTable(byStatus.rows.map((r) => ({ status: r.status, quarantine_reason: r.reason ?? "NULL", count: fmt(Number(r.n)) })));
  const runRecipes = await pool.query<{ status: string; n: string }>(`SELECT status, count(*) AS n FROM ${schema}.recipes WHERE purge_run = $1 GROUP BY 1`, [run]);
  console.log(`\n-- recipes WHERE purge_run = '${run}': ${runRecipes.rows.map((r) => `${r.status} ${fmt(Number(r.n))}`).join(", ") || "none"}`);

  const s = await loadState(pool, schema, { follower: false });
  const resultInactive = s.recipes.filter((r) => !s.activeIds.has(r.result) && !r.protected).length;
  const removedSet = new Set(removed);
  const ingredientInactive = s.recipes.filter((r) => r.ingredients.some((i) => !s.activeIds.has(i))).length;
  const ingredientRemoved = s.recipes.filter((r) => !r.protected && r.ingredients.some((i) => removedSet.has(i) && !s.activeIds.has(i))).length;
  const protectedBroken = s.recipes.filter((r) => r.protected && (!s.activeIds.has(r.result) || r.ingredients.some((i) => !s.activeIds.has(i)))).length;
  console.log(
    `-- integrity: active recipes with an inactive result ${resultInactive} (non-protected; healed by the next combine), ` +
      `with an ingredient removed by this run ${ingredientRemoved} (expect 0; any inactive ingredient, incl. older quarantines: ${ingredientInactive}), ` +
      `protected recipes broken ${protectedBroken} (expect 0)`,
  );
  const live = s.challenges.filter((c) => c.day >= s.window.first && c.day <= s.window.last);
  for (const c of live) {
    const cells = TIERS.map((t) => {
      const id = c.targets[t];
      const el = s.all.get(id);
      return `${t}=${el?.name ?? id} [${el?.status ?? "missing"}${s.before.depth.value.has(id) ? ", reachable" : ", UNREACHABLE"}]`;
    });
    console.log(`-- challenge ${c.day}: ${cells.join("  ")}`);
  }
  // A player who owned a removed element: the bootstrap library query (server/game/players.ts).
  const sample = await pool.query<{ player_id: string }>(
    `SELECT player_id FROM ${schema}.discoveries WHERE element_id = ANY($1::INT8[]) GROUP BY player_id ORDER BY count(*) DESC LIMIT 1`,
    [removed],
  );
  const player = sample.rows[0]?.player_id;
  if (player) {
    const lib = await pool.query<{ id: string; status: string }>(
      `SELECT e.id, e.status, e.name, d.discovered_at
         FROM ${schema}.discoveries d
         JOIN ${schema}.elements e ON e.id = d.element_id
        WHERE d.player_id = $1 AND e.status = 'active'
        ORDER BY d.discovered_at, e.id`,
      [player],
    );
    const raw = await pool.query<{ n: string }>(`SELECT count(*) AS n FROM ${schema}.discoveries WHERE player_id = $1`, [player]);
    console.log(
      `-- sample library (player ${player}): ${fmt(Number(raw.rows[0]!.n))} discovery row(s) -> ${fmt(lib.rows.length)} active library entr(ies); ` +
        `removed elements shown: ${lib.rows.filter((r) => removedSet.has(r.id)).length} (expect 0)`,
    );
  }
}

// ---------------------------------------------------------------- restore

async function cmdRestore(args: string[]) {
  const v = parse("restore", args, { run: { type: "string" }, "dry-run": { type: "boolean" } });
  if (!v.run || !RUN_ID_RE.test(v.run)) throw new UsageError(`--run must be a run id like purge-20261106-153000, got ${JSON.stringify(v.run)}\n\n${USAGE.restore}`);
  const run = v.run;
  const schema = resolveSchema(v.schema);
  const pool = createPool(3);
  try {
    await requirePurgeSchema(pool, schema);
    const els = (
      await pool.query<{ id: string; reason: string | null }>(
        `SELECT id, quarantine_reason AS reason FROM ${schema}.elements WHERE purge_run = $1 AND status = 'quarantined'`,
        [run],
      )
    ).rows;
    const recs = (
      await pool.query<{ id: string; ingredient_ids: string[]; result_id: string }>(
        `SELECT id, ingredient_ids, result_id FROM ${schema}.recipes WHERE purge_run = $1 AND status = 'quarantined'`,
        [run],
      )
    ).rows;
    const meta = await pool.query<{ value: { status?: string } }>(`SELECT value FROM ${schema}.meta WHERE key = $1`, [`purge:${run}`]);
    console.log(
      `[${schema}] run ${run} (meta status: ${meta.rows[0]?.value?.status ?? "none"}): ${fmt(els.length)} quarantined element(s) ` +
        `(${fmt(els.filter((x) => x.reason === REASON.review).length)} review, ${fmt(els.filter((x) => x.reason === REASON.orphaned).length)} orphaned), ` +
        `${fmt(recs.length)} quarantined recipe(s)`,
    );
    if (els.length === 0 && recs.length === 0) {
      console.log("Nothing to restore.");
      return;
    }
    if (v["dry-run"]) {
      console.log("Dry run: nothing written.");
      return;
    }
    const restored = await batched(pool, "elements", els.map((x) => x.id), ELEMENT_TX, async (c, b) => {
      const r = await c.query(
        `UPDATE ${schema}.elements SET status = 'active', quarantine_reason = NULL, purge_run = NULL
          WHERE id = ANY($1::INT8[]) AND purge_run = $2 AND status = 'quarantined'`,
        [b, run],
      );
      return r.rowCount ?? 0;
    });
    // Recipes come back where the result and every ingredient are active again.
    const involved = [...new Set(recs.flatMap((r) => [r.result_id, ...r.ingredient_ids]))];
    const activeNow = new Set<string>();
    for (const part of chunk(involved, 10_000)) {
      const r = await pool.query<{ id: string }>(`SELECT id FROM ${schema}.elements WHERE id = ANY($1::INT8[]) AND status = 'active'`, [part]);
      for (const x of r.rows) activeNow.add(x.id);
    }
    const back = recs.filter((r) => activeNow.has(r.result_id) && r.ingredient_ids.every((i) => activeNow.has(i))).map((r) => r.id);
    const recipesRestored = await batched(pool, "recipes", back, RECIPE_TX, async (c, b) => {
      const r = await c.query(
        `UPDATE ${schema}.recipes SET status = 'active', purge_run = NULL WHERE id = ANY($1::INT8[]) AND purge_run = $2 AND status = 'quarantined'`,
        [b, run],
      );
      return r.rowCount ?? 0;
    });
    const s = await loadState(pool, schema, { follower: false });
    const depthDone = await writeDepthSteps(pool, schema, depthStepsUpdates(s.active, s.before.depth, s.before.steps));
    await refreshKnownCount(pool, schema);
    const counts = { elements: restored, recipes: recipesRestored, recipes_left_quarantined: recs.length - recipesRestored, depth_steps_updates: depthDone };
    await writeMeta(pool, schema, `purge:${run}`, { status: "restored", restored_at: new Date().toISOString(), restored: counts }, true);
    console.log(`\nRestored ${run}:`);
    printTable(Object.entries(counts).map(([k, n]) => ({ step: k, rows: fmt(n) })));
    console.log("Challenge days re-picked by the run keep their new targets (old targets are in meta 'purge:" + run + "'.repicked).");
  } finally {
    await pool.end();
  }
}

// ---------------------------------------------------------------- main

const COMMANDS: Record<string, (args: string[]) => Promise<void>> = {
  export: cmdExport,
  stage: cmdStage,
  status: cmdStatus,
  plan: cmdPlan,
  apply: cmdApply,
  restore: cmdRestore,
};

if (isMain(import.meta.url)) {
  const [cmd, ...rest] = process.argv.slice(2);
  const run = cmd ? COMMANDS[cmd] : undefined;
  if (!run) {
    console.log(GENERAL_USAGE);
    process.exit(cmd && cmd !== "--help" && cmd !== "-h" && cmd !== "help" ? 2 : 0);
  }
  run(rest).then(
    () => process.exit(0),
    (e: unknown) => {
      if (e instanceof UsageError) console.error(`ERROR: ${e.message}`);
      else console.error(e instanceof Error ? (e.stack ?? e.message) : e);
      process.exit(e instanceof UsageError ? 2 : 1);
    },
  );
}
