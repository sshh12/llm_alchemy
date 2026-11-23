// Daily challenges, generator "pred-v6" (scripts/lib/challenges.ts; model in
// scripts/lib/challengeModel.ts). Picks are made by PREDICTED COMPLETION inside fun and safety
// constraints, and every written day carries meta (features, predictions, experiment arms,
// provenance) when migration 0010 is applied.
//
// Plan / apply (how humans change stored days):
//   npm run db:challenges -- --dry-run --from=auto --days=7 --plan-out=wk.json   # read-only: pick, print, save the plan
//   npm run db:challenges -- --apply-plan=wk.json --reason=jit [--backup-out=bk.json]   # write exactly those rows
// Other modes:
//   npm run db:challenges -- --replace-generated --reason=<code> [--from=..] [--days=N | --only=d1,d2]   # plan + apply in one go
//   npm run db:challenges                       # insert MISSING days only (never touches a stored row)
//   npm run db:challenges -- --missing-only --dry-run
// Offline:
//   --snapshot-out=snap.json   save the read-only inputs (world, stored days, reach counts) after reading them
//   --snapshot-in=snap.json    plan from a saved snapshot, no database (implies --dry-run)
//   --tags-in=tags.json        classifier tags ({id: {appeal, teacher, synonyms}} or [{id, ...}]) over elements.challenge_tags
//
// Days: --from=auto (default for plans) = the first day still unfrozen APPLY_FREEZE_MARGIN_MS from
// now (liveWindow(now + margin).frozenThrough + 1);
// --days=N (default: through the 5-year horizon, CHALLENGE_CUTOVER_DAY + CHALLENGE_GENERATE_YEARS);
// --only=YYYY-MM-DD,... plans exactly those days (check-challenges --fix). A plan re-picks generated
// days in range and fills missing ones; legacy rows are never touched. Every other stored day is a
// fixed neighbour for the repeat and variety rules.
//
// Guards (contract C7): a write refuses, before loading, inside its transaction AND right before
// COMMIT, if any planned day is frozen or freezes within APPLY_FREEZE_MARGIN_MS (on/before
// liveWindow(now + margin).frozenThrough: today somewhere, or tomorrow's teaser), if any planned
// day has a challenge completion, or (apply) if a stored row changed since the plan was made.
// --allow-frozen overrides only the frozen check, and only for a safety failure (an unsafe target
// players would otherwise see; never because a pick is merely dull): it re-picks the WHOLE row,
// including the easy target shown as tomorrow's teaser. Nothing overrides completions.
// --apply-plan re-validates C1, C2, C4, C5, C5b and C8 for every planned target against the
// current world and refuses (it never re-picks): re-run the dry run.
// Meta (refuseWithoutMeta): every write refuses while challenges.meta is missing (migration 0010),
// because a pred-v6 row without meta loses meta.replaced, the holdout's pre-v6 targets and the
// experiment log. --allow-no-meta overrides it, except for a day assigned to the holdout.
//
// Inputs are read in ONE read-only transaction: active elements, every active recipe (steps are
// recomputed: min(stored, live graph), as `npm run db:depth -- --run` would leave them), the stored
// days and the reach counts (scripts/lib/reach.ts, asOf = now). Picks are a deterministic function
// of that snapshot and the code (configHash, gitSha in meta).
import "./lib/env.ts";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import { parseArgs } from "node:util";
import type pg from "pg";
import type { Tier } from "../src/shared/api.ts";
import { addDays, CHALLENGE_CUTOVER_DAY, CHALLENGE_GENERATE_YEARS, isDay, utcDay } from "../src/shared/dates.ts";
import { NEAR_NAME_MIN_REACH, NEAR_NAME_RATIO, SEASONAL, SYNONYM_GROUPS } from "./lib/challengeFeatures.ts";
import { armFor, MODEL_CONFIG, type DayType } from "./lib/challengeModel.ts";
import {
  ABSTRACT_WEIGHT,
  AHA_CAP,
  AHA_FLOOR_NEAR_OPT,
  AHA_SLOPE,
  APPEAL_WEIGHT,
  APPLY_CHECKS,
  buildCandidates,
  buildPools,
  dayRange,
  EASY_DENY_NAMES,
  EASY_SOFT_DENY_NAMES,
  EASY_TWIN_ABS,
  GENERATOR,
  HOLIDAY_GLOOM_EMOJI,
  hardFailures,
  liveWindow,
  makeContext,
  MAX_CANDIDATE_STEPS,
  NO_REPEAT_DAYS,
  planDays,
  repickDeadline,
  SAFE_PATH_SLACK,
  TIERS,
  TWIN_SHARE,
  VARIETY_DAYS,
  WEEKDAY_EXPERT_GAP,
  type CandidateDrops,
  type Ctx,
  type DayMeta,
  type DayTargets,
  type Features,
  type PlannedRow,
  type Pools,
  type StoredRow,
} from "./lib/challenges.ts";
import { isMain, printTable, runMain } from "./lib/cli.ts";
import { chunk, createPool, fmt, resolveSchema, retrying } from "./lib/db.ts";
import type { GraphRecipe } from "./lib/graph.ts";
import { computeReach, loadReachInputs, reachInputsFromJson, reachInputsToJson } from "./lib/reach.ts";
import { CHALLENGE_DENY, compoundHits, DENYLIST, EMOJI_DENY, EMOJI_REVIEW, emojiKey } from "./lib/schoolSafety.ts";
import { applyTags, columnExists, loadWorld, withFreshSteps, worldAsOf, type WorldElement } from "./lib/world.ts";

export function daysBetween(a: string, b: string): number {
  return Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86_400_000);
}

/** Days from `from` to the same calendar date `years` later (1826 for 5 years incl. a leap day). */
export function daysForYears(from: string, years: number): number {
  return daysBetween(from, `${Number(from.slice(0, 4)) + years}${from.slice(4)}`);
}

/** First day after the generation horizon (exclusive end of the default range). */
export const horizonEnd = () => addDays(CHALLENGE_CUTOVER_DAY, daysForYears(CHALLENGE_CUTOVER_DAY, CHALLENGE_GENERATE_YEARS));

// ---------------------------------------------------------------- snapshot (one read-only transaction)

export interface Snapshot {
  kind: "challenge-snapshot";
  v: 1;
  schema: string;
  takenAt: string;
  worldAsOf: string;
  hasMeta: boolean;
  hasTags: boolean;
  /** Active elements as stored (steps are freshened in prepare()). */
  elements: WorldElement[];
  /** Every active recipe (any arity). */
  allRecipes: GraphRecipe[];
  /** Stored days from CHALLENGE_CUTOVER_DAY - NO_REPEAT_DAYS on. */
  stored: StoredRow[];
  reach: ReturnType<typeof reachInputsToJson>;
}

const STORED_SQL = (schema: string, hasMeta: boolean) =>
  `SELECT day::STRING AS day, source, generator, easy_id::STRING AS easy_id, hard_id::STRING AS hard_id, expert_id::STRING AS expert_id${hasMeta ? ", meta" : ""}
     FROM ${schema}.challenges WHERE day >= $1::DATE ORDER BY day`;

type StoredSqlRow = { day: string; source: string; generator: string | null; easy_id: string; hard_id: string; expert_id: string; meta?: DayMeta | null };
const toStored = (r: StoredSqlRow): StoredRow => ({
  day: r.day,
  source: r.source,
  generator: r.generator,
  targets: { easy: r.easy_id, hard: r.hard_id, expert: r.expert_id },
  meta: r.meta ?? null,
});

/** Everything a plan needs, read in ONE read-only transaction (writes are impossible here). */
export async function readSnapshot(pool: pg.Pool, schema: string, now = new Date()): Promise<Snapshot> {
  const db = await pool.connect();
  try {
    await db.query("BEGIN TRANSACTION READ ONLY");
    const world = await loadWorld(db, schema, { allRecipes: true });
    const hasMeta = await columnExists(db, schema, "challenges", "meta");
    const stored = (await db.query<StoredSqlRow>(STORED_SQL(schema, hasMeta), [addDays(CHALLENGE_CUTOVER_DAY, -NO_REPEAT_DAYS)])).rows.map(toStored);
    const reach = await loadReachInputs(db, schema, now);
    const asOf = await worldAsOf(db, schema);
    await db.query("COMMIT");
    return {
      kind: "challenge-snapshot",
      v: 1,
      schema,
      takenAt: now.toISOString(),
      worldAsOf: asOf,
      hasMeta,
      hasTags: world.hasTags,
      elements: world.elements,
      allRecipes: world.allRecipes!,
      stored,
      reach: reachInputsToJson(reach),
    };
  } catch (e) {
    await db.query("ROLLBACK").catch(() => {});
    throw e;
  } finally {
    db.release();
  }
}

/** Below this cohort size reach is noise and the pools empty out (a fresh schema): refuse to plan. */
export const MIN_COHORT = 100;

export interface Prepared {
  ctx: Ctx;
  elements: WorldElement[];
  cands: Map<string, Features>;
  drops: CandidateDrops;
  pools: Pools;
  poolWarnings: string[];
  staleSteps: number;
  tagsApplied: number;
  classifierVersion: string;
  names: Map<string, string>;
}

export type PreparedContext = Pick<Prepared, "ctx" | "elements" | "staleSteps" | "tagsApplied" | "classifierVersion" | "names"> & {
  /** Set when the reach cohort is below MIN_COHORT: predictions are noise (checks still run). */
  smallCohort: string | null;
};

/**
 * Fresh steps, tags, reach and the context from a snapshot: everything checkDays and revalidate
 * need. Never throws on a small cohort or an empty pool, so check-challenges can still list broken
 * days on a fresh schema or after a classifier rerun empties a pool.
 */
export function prepareContext(snap: Snapshot, tagsFile?: unknown): PreparedContext {
  const fresh = withFreshSteps(snap.elements, snap.allRecipes);
  const tagged = tagsFile === undefined ? { elements: fresh.elements, applied: 0 } : applyTags(fresh.elements, tagsFile);
  const elements = tagged.elements;
  const reach = computeReach(reachInputsFromJson(snap.reach));
  const smallCohort =
    reach.cohortN < MIN_COHORT
      ? `reach cohort is ${reach.cohortN} player(s) (< ${MIN_COHORT}): pred-v6 picks by predicted completion and needs v2 players from the last 28 days. ` +
        `A fresh schema has none; seed challenges another way (scripts/seed-e2e.ts) or use bfs-v5 (git show f127142:scripts/lib/challenges.ts).`
      : null;
  const ctx = makeContext({ elements, recipes: snap.allRecipes.filter((r) => r.ingredients.length === 2), allRecipes: snap.allRecipes, reach });
  const versions = new Map<string, number>();
  for (const e of elements) if (e.tags?.v) versions.set(e.tags.v, (versions.get(e.tags.v) ?? 0) + 1);
  const classifierVersion = [...versions].sort((a, b) => b[1] - a[1])[0]?.[0] ?? "none";
  return { ctx, elements, staleSteps: fresh.stale, tagsApplied: tagged.applied, classifierVersion, names: new Map(elements.map((e) => [e.id, e.name])), smallCohort };
}

/** prepareContext plus candidates and pools, for planning: throws on a small cohort or an empty pool. */
export function prepare(snap: Snapshot, tagsFile?: unknown): Prepared {
  const { smallCohort, ...base } = prepareContext(snap, tagsFile);
  if (smallCohort) throw new Error(smallCohort);
  const { cands, drops } = buildCandidates(base.ctx);
  const { pools, warnings } = buildPools(cands);
  return { ...base, cands, drops, pools, poolWarnings: warnings };
}

const sha = (s: string) => createHash("sha256").update(s).digest("hex");

/** Hash of everything that defines the picks besides the inputs (meta.configHash). */
export function configHash(): string {
  return sha(
    JSON.stringify({
      MODEL_CONFIG,
      GENERATOR,
      NO_REPEAT_DAYS,
      VARIETY_DAYS,
      WEEKDAY_EXPERT_GAP,
      AHA_SLOPE,
      AHA_CAP,
      ABSTRACT_WEIGHT,
      APPEAL_WEIGHT,
      EASY_DENY_NAMES,
      EASY_SOFT_DENY_NAMES,
      TWIN_SHARE,
      EASY_TWIN_ABS,
      SAFE_PATH_SLACK,
      AHA_FLOOR_NEAR_OPT,
      HOLIDAY_GLOOM_EMOJI: [...HOLIDAY_GLOOM_EMOJI].sort(),
      NEAR_NAME_RATIO,
      NEAR_NAME_MIN_REACH,
      EMOJI_DENY,
      MAX_CANDIDATE_STEPS,
      SYNONYM_GROUPS,
      SEASONAL: SEASONAL.map((r) => [r.re.source, r.allowed]),
      DENYLIST,
      CHALLENGE_DENY: [...CHALLENGE_DENY].sort(),
    }),
  ).slice(0, 12);
}

export function gitSha(): string {
  try {
    const head = execFileSync("git", ["rev-parse", "--short=12", "HEAD"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
    const dirty = execFileSync("git", ["status", "--porcelain", "--", "scripts"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
    return dirty ? `${head}-dirty` : head;
  } catch {
    return "unknown";
  }
}

// ---------------------------------------------------------------- plans

export interface PlanRow extends PlannedRow {
  names: Record<Tier, string>;
  /** The stored row at plan time (null = missing day); --apply-plan refuses if it changed. */
  prev: { source: string; generator: string | null; targets: DayTargets } | null;
}

export interface PlanFile {
  kind: "challenge-plan";
  v: 1;
  generator: string;
  schema: string;
  createdAt: string;
  snapshotAt: string;
  frozenThroughAtPlan: string;
  configHash: string;
  gitSha: string;
  worldAsOf: string;
  reach: DayMeta["reach"];
  planHash: string;
  fallbacks: Record<string, number>;
  warnings: string[];
  rows: PlanRow[];
}

/** meta.planHash: days, targets and school-basis p of a plan's rows (also used by purge re-picks). */
export const planHashOf = (rows: readonly PlannedRow[]): string =>
  sha(JSON.stringify(rows.map((r) => [r.day, r.targets, TIERS.map((t) => r.meta.tiers[t].p)]))).slice(0, 16);

/** Plan `days` from a prepared snapshot (all other stored days are fixed neighbours). */
export function makePlan(snap: Snapshot, prep: Prepared, days: readonly string[], now = new Date()): PlanFile {
  const pickedAt = now.toISOString();
  const cfg = configHash();
  const git = gitSha();
  const { rows, fallbacks, warnings } = planDays(prep.ctx, prep.cands, prep.pools, {
    days,
    stored: snap.stored,
    provenance: { configHash: cfg, gitSha: git, classifierVersion: prep.classifierVersion, pickedAt, worldAsOf: snap.worldAsOf },
  });
  const planHash = planHashOf(rows);
  const byDay = new Map(snap.stored.map((r) => [r.day, r]));
  const name = (id: string) => prep.names.get(id) ?? `#${id}`;
  return {
    kind: "challenge-plan",
    v: 1,
    generator: GENERATOR,
    schema: snap.schema,
    createdAt: pickedAt,
    snapshotAt: snap.takenAt,
    frozenThroughAtPlan: liveWindow(now).frozenThrough,
    configHash: cfg,
    gitSha: git,
    worldAsOf: snap.worldAsOf,
    reach: prep.ctx.reachInfo,
    planHash,
    fallbacks,
    warnings,
    rows: rows.map((r) => {
      const old = byDay.get(r.day);
      return {
        ...r,
        meta: { ...r.meta, planHash },
        names: { easy: name(r.targets.easy), hard: name(r.targets.hard), expert: name(r.targets.expert) },
        prev: old ? { source: old.source, generator: old.generator, targets: old.targets } : null,
      };
    }),
  };
}

const pct = (x: number, d = 1) => `${(100 * x).toFixed(d)}%`;
const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : NaN);
const quantile = (xs: number[], q: number) => {
  if (!xs.length) return NaN;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.floor(q * (s.length - 1))]!;
};

export function printPools(prep: Prepared) {
  const d = prep.drops;
  console.log(
    `Candidates (active, solvable, steps 1-${MAX_CANDIDATE_STEPS}, name ok, emoji, art not blocked, recognizable): ${fmt(d.universe)}; ` +
      `dropped: unsafe ${fmt(d.unsafe)} (C5 name/emoji), unsafe route ${fmt(d.unsafePath)} (C5b), CHALLENGE_DENY/teacher ${fmt(d.challengeDeny)} (C5), spelling twin ${fmt(d.twinTrap)} (C8); ` +
      `kept ${fmt(prep.cands.size)}. Not recognizable: ${fmt(d.notRecognizable)}; not classified yet: ${fmt(d.unclassified)}.`,
  );
  const u = prep.pools.school.upperDrops;
  console.log(
    `Hard/expert/explore candidates dropped before the bands: synonym trap ${u.synonym} (C9), twin >= ${100 * TWIN_SHARE.upper}% ${u.twinNear} (C8b), ` +
      `near-name trap ${u.nearName} (C12), aha floor ${u.ahaFloor} (C12), art not ready ${u.artNotReady} (C4). ` +
      `Easy: twin >= ${100 * TWIN_SHARE.easy}% or >= ${100 * EASY_TWIN_ABS}% of players ${prep.pools.school.easyTwinDrops} (C8b).`,
  );
  if (prep.staleSteps) console.log(`Steps: ${fmt(prep.staleSteps)} element(s) have stored steps above the live graph; using min(stored, live) (run npm run db:depth -- --run so the app matches).`);
  if (prep.tagsApplied) console.log(`--tags-in: tags for ${fmt(prep.tagsApplied)} element(s).`);
  console.log(`Classifier version: ${prep.classifierVersion}; reach ${prep.ctx.reachInfo.mode} as of ${prep.ctx.reachInfo.asOf}, cohort N ${prep.ctx.reachInfo.cohortN} (N7 ${prep.ctx.reachInfo.cohortN7}).\n`);
  const rows: Record<string, string | number>[] = [];
  for (const dt of ["school", "mon", "off"] as DayType[]) {
    const P = prep.pools[dt];
    for (const [label, pool, tier] of [
      ["easy", P.easy, "easy"],
      ["hard", P.hard, "hard"],
      ["expert", P.expert, "expert"],
      ["explore", P.explore, "expert"],
    ] as const) {
      if (!pool) {
        if (dt !== "off") rows.push({ day_type: dt, tier: label, n: 0, note: "explore arm skipped" });
        continue;
      }
      const members = pool.ids.map((id) => prep.cands.get(id)!);
      rows.push({
        day_type: dt,
        tier: label,
        n: pool.ids.length,
        steps: pool.band.steps.join("-"),
        band: `${pct(pool.band.lo)}-${pool.band.hi >= 1 ? "100%" : pct(pool.band.hi)}`,
        lo_eff: pct(pool.lo, 2),
        widened: pool.widened,
        mean_p: pct(mean(members.map((c) => c.p[tier])), 2),
        name_link: pct(mean(members.map((c) => Number(c.nameLink))), 0),
        seasonal: members.filter((c) => c.seasonal).length,
        repeats: pool.ids.length < NO_REPEAT_DAYS ? "LRU spacing" : "avoided",
        note:
          label === "expert" && dt === "off"
            ? `appeal floor ${P.appealFloor === "vacuous" ? "vacuous (no tags)" : P.appealFloor}`
            : label === "easy"
              ? `soft deny ${P.easySoftDeny}`
              : "",
      });
    }
  }
  printTable(rows);
  for (const w of prep.poolWarnings) console.warn(`WARNING: ${w}`);
}

export interface PlanStats {
  days: number;
  byType: Record<string, { days: number } & Record<Tier, { meanP: number; p10P: number; meanPExp: number }>>;
}

/** A tier picked by v6 (not a realized holdout tier). */
export const isV6Tier = (r: PlannedRow, tier: Tier) => tier === "easy" || r.meta.exp[tier].realized !== "holdout";

export function planStats(rows: readonly PlannedRow[]): PlanStats {
  const groups = new Map<string, PlannedRow[]>();
  for (const r of rows) {
    const k = r.meta.dayType === "off" ? "off" : "weekday";
    groups.set(k, [...(groups.get(k) ?? []), r]);
    if (k === "weekday") groups.set("weekday-v6", [...(groups.get("weekday-v6") ?? []), r]);
  }
  const byType: PlanStats["byType"] = {};
  for (const [k, rs] of groups) {
    const t = { days: rs.length } as PlanStats["byType"][string];
    for (const tier of TIERS) {
      const sel = k === "weekday-v6" ? rs.filter((r) => isV6Tier(r, tier)) : rs;
      const ps = sel.map((r) => r.meta.tiers[tier].p);
      t[tier] = { meanP: mean(ps), p10P: quantile(ps, 0.1), meanPExp: mean(sel.map((r) => r.meta.tiers[tier].pExp)) };
    }
    byType[k] = t;
  }
  return { days: rows.length, byType };
}

function printPlan(plan: PlanFile, prep: Prepared, show: number) {
  const rows = plan.rows;
  const first90 = rows.slice(0, 90);
  for (const [label, rs] of [["next 90 days", first90], ["whole plan", rows]] as const) {
    const s = planStats(rs);
    console.log(`\nPredicted completion, ${label} (${s.days} days; school basis p / day basis pExp; weekday-v6 excludes holdout tiers):`);
    printTable(
      Object.entries(s.byType).map(([k, v]) => ({
        days: `${k} (${v.days})`,
        ...Object.fromEntries(TIERS.map((t) => [t, `mean ${pct(v[t].meanP, 2)}  p10 ${pct(v[t].p10P, 2)}  exp ${pct(v[t].meanPExp, 2)}`])),
      })),
    );
  }
  const fb = Object.entries(plan.fallbacks).sort();
  if (fb.length) console.log(`\nFallbacks: ${fb.map(([k, v]) => `${k} ${v}`).join(", ")}`);
  for (const w of plan.warnings.slice(0, 20)) console.warn(`WARNING: ${w}`);
  if (plan.warnings.length > 20) console.warn(`WARNING: ... and ${plan.warnings.length - 20} more`);
  console.log(`\nFirst ${Math.min(show, rows.length)} planned days (name steps p; arms):`);
  printTable(
    rows.slice(0, show).map((r) => {
      const cell = (t: Tier) => `${r.names[t]} ${r.meta.tiers[t].steps ?? "?"} ${pct(r.meta.tiers[t].p)}`;
      const e = r.meta.exp;
      return {
        day: r.day,
        type: r.meta.dayType,
        easy: cell("easy"),
        hard: cell("hard"),
        expert: cell("expert"),
        arms: `h${e.hard.realized ?? "-"} x${e.expert.realized ?? "-"}`,
        was: r.prev ? `${r.prev.generator ?? r.prev.source}` : "missing",
      };
    }),
  );
  // Review list (§9.1): the names by day are above; plus what a human should eyeball.
  const inRange = prep.elements.filter((e) => e.steps != null && e.steps >= 1 && e.steps <= MAX_CANDIDATE_STEPS && e.recognizable === true);
  const teacher = inRange.filter((e) => e.tags?.teacher === true).map((e) => e.name);
  const poolIds = new Set(Object.values(prep.pools).flatMap((P) => [P.easy, P.hard, P.expert, P.explore].flatMap((p) => p?.ids ?? [])));
  const compounds = [...poolIds].map((id) => prep.names.get(id)!).filter((n) => compoundHits(n).length > 0).sort();
  console.log(`\nReview: in-range recognizable names left out by the teacher flag (${teacher.length}): ${teacher.slice(0, 60).join(", ") || "-"}${teacher.length > 60 ? ", ..." : ""}`);
  console.log(`Review: pool names with a denied word inside a longer word (${compounds.length}; add a real hit to DENYLIST): ${compounds.join(", ") || "-"}`);
  const planned = new Set(rows.flatMap((r) => TIERS.map((t) => r.targets[t])));
  const emo = [...planned]
    .map((id) => prep.ctx.byId.get(id)!)
    .filter((e) => e.emoji && EMOJI_REVIEW.has(emojiKey(e.emoji)))
    .map((e) => `${e.name} ${e.emoji}`)
    .sort();
  console.log(`Review: planned names with a review emoji (${emo.length}; deny a real hit by name): ${emo.join(", ") || "-"}`);
  const noArt = [...planned].map((id) => prep.ctx.byId.get(id)!).filter((e) => e.imageStatus !== "ready").map((e) => e.name);
  if (noArt.length) console.log(`Review: planned names without art (${noArt.length}; generate and look at it before applying): ${noArt.sort().join(", ")}`);
}

// ---------------------------------------------------------------- writes

export async function completionsOn(db: pg.Pool | pg.PoolClient, schema: string, days: readonly string[]): Promise<Map<string, number>> {
  if (days.length === 0) return new Map();
  const res = await db.query<{ day: string; n: string }>(
    `SELECT day::STRING AS day, count(*) AS n FROM ${schema}.challenge_completions WHERE day = ANY($1::DATE[]) GROUP BY day`,
    [[...days]],
  );
  return new Map(res.rows.map((r) => [r.day, Number(r.n)]));
}

/** Kept for scripts/purge-elements.ts: completions on/after `from`. */
export async function completionsFrom(db: pg.Pool | pg.PoolClient, schema: string, from: string): Promise<number> {
  const res = await db.query<{ n: string }>(`SELECT count(*) AS n FROM ${schema}.challenge_completions WHERE day >= $1::DATE`, [from]);
  return Number(res.rows[0]!.n);
}

/** meta.replaced after replacing `old`: the pre-v6 entry stays first forever, then the last 3. */
export function nextReplaced(old: StoredRow | null, reason: string, at: string): DayMeta["replaced"] {
  if (!old) return undefined;
  const prior = old.meta?.replaced ?? [];
  const entry = { generator: old.generator, targets: old.targets, reason, at };
  if (prior.length === 0) return [entry];
  return [prior[0]!, ...[...prior.slice(1), entry].slice(-3)];
}

/** Insert rows (source 'generated', GENERATOR, meta when the column exists). `onConflict` = "nothing" keeps stored rows. */
export async function insertRows(
  db: pg.Pool | pg.PoolClient,
  schema: string,
  rows: readonly { day: string; targets: DayTargets; steps: Record<Tier, number | null>; meta: DayMeta | null }[],
  { hasMeta, onConflict }: { hasMeta: boolean; onConflict: "nothing" | "error" },
): Promise<number> {
  let inserted = 0;
  for (const batch of chunk([...rows], 200)) {
    const params: unknown[] = [
      batch.map((r) => r.day),
      batch.map((r) => r.targets.easy),
      batch.map((r) => r.targets.hard),
      batch.map((r) => r.targets.expert),
      batch.map((r) => r.steps.easy),
      batch.map((r) => r.steps.hard),
      batch.map((r) => r.steps.expert),
      GENERATOR,
    ];
    if (hasMeta) params.push(batch.map((r) => (r.meta ? JSON.stringify(r.meta) : null)));
    const res = await db.query(
      `INSERT INTO ${schema}.challenges (day, easy_id, hard_id, expert_id, easy_steps, hard_steps, expert_steps, source, generator${hasMeta ? ", meta" : ""})
       SELECT u.day, u.e, u.h, u.x, u.es, u.hs, u.xs, 'generated', $8${hasMeta ? ", u.m::JSONB" : ""}
       FROM unnest($1::DATE[], $2::INT8[], $3::INT8[], $4::INT8[], $5::INT4[], $6::INT4[], $7::INT4[]${hasMeta ? ", $9::STRING[]" : ""})
         AS u(day, e, h, x, es, hs, xs${hasMeta ? ", m" : ""})
       ${onConflict === "nothing" ? "ON CONFLICT (day) DO NOTHING" : ""}`,
      params,
    );
    inserted += res.rowCount ?? 0;
  }
  return inserted;
}

/** The plan's targets that fail C1, C2, C4, C5 or C8 in `ctx` (apply re-validation). */
export function revalidate(plan: PlanFile, ctx: Ctx): string[] {
  const out: string[] = [];
  for (const r of plan.rows) {
    for (const t of TIERS) {
      const fails = hardFailures(ctx, r.targets[t]).filter((f) => APPLY_CHECKS.has(f.code));
      if (fails.length) out.push(`${r.day} ${t} ${r.names[t]}: ${fails.map((f) => `${f.code} (${f.detail})`).join("; ")}`);
    }
  }
  return out;
}

/**
 * A write treats a day as frozen this long before its freeze instant (D-2 10:00 UTC), so a long
 * transaction (the 5-year rollout) cannot commit after a planned day froze. --from=auto uses the
 * same margin.
 */
export const APPLY_FREEZE_MARGIN_MS = 30 * 60_000;

/** frozenThrough as a write sees it at `now` (APPLY_FREEZE_MARGIN_MS ahead). */
export const writeFrozenThrough = (now: Date) => liveWindow(new Date(now.getTime() + APPLY_FREEZE_MARGIN_MS)).frozenThrough;

export function refuseFrozen(days: readonly string[], now: Date, allowFrozen: boolean, when: string) {
  const frozenThrough = writeFrozenThrough(now);
  const frozen = days.filter((d) => d <= frozenThrough);
  if (frozen.length === 0) return;
  if (allowFrozen) {
    console.warn(`WARNING: --allow-frozen: writing ${frozen.length} frozen day(s) players may have seen: ${frozen.join(", ")}`);
    return;
  }
  throw new Error(
    `refused: ${frozen.length} planned day(s) on/before ${frozenThrough} are frozen or freeze within ${APPLY_FREEZE_MARGIN_MS / 60_000} min ` +
      `(live or tomorrow's teaser; ${when}): ${frozen.slice(0, 10).join(", ")}${frozen.length > 10 ? ", ..." : ""}. Re-plan with --from=auto.`,
  );
}

/**
 * Refuse a pred-v6 write while challenges.meta is missing (migration 0010): such a row loses
 * meta.replaced, so a later plan can no longer find the holdout's pre-v6 targets, and the
 * experiment log. `allowNoMeta` (--allow-no-meta) overrides it, except when a day is assigned to
 * the holdout, whose pre-v6 targets would be lost for good.
 */
export function refuseWithoutMeta(days: readonly string[], hasMeta: boolean, allowNoMeta: boolean, what: string) {
  if (hasMeta || days.length === 0) return;
  const holdout = days.filter((d) => armFor(d).holdout.assigned);
  if (holdout.length) {
    throw new Error(
      `refused: challenges.meta is missing (apply migration 0010 first) and ${holdout.length} day(s) of this ${what} are assigned to the holdout ` +
        `(${holdout.slice(0, 6).join(", ")}${holdout.length > 6 ? ", ..." : ""}): writing them without meta would lose their pre-v6 targets for good. --allow-no-meta does not override this.`,
    );
  }
  if (!allowNoMeta) {
    throw new Error(
      `refused: challenges.meta is missing (apply migration 0010 first): ${days.length} pred-v6 row(s) of this ${what} would be written without meta ` +
        `(no meta.replaced, features, predictions or arms). Pass --allow-no-meta to write them anyway.`,
    );
  }
  console.warn(`WARNING: --allow-no-meta: writing ${days.length} pred-v6 row(s) WITHOUT meta (no meta.replaced, features, predictions or arms).`);
}

/**
 * Write exactly the plan's rows in ONE transaction: refuse frozen days, completions on planned
 * days and rows that changed since the plan; delete the generated rows on those days and insert
 * the planned ones with meta.replaced. Never touches a non-generated row.
 */
/** Write the full stored rows of `days` (all columns, read-only) to a JSON backup file. */
export async function backupRows(db: pg.Pool | pg.PoolClient, schema: string, days: readonly string[], file: string): Promise<number> {
  const hasMeta = await columnExists(db, schema, "challenges", "meta");
  const rows = (
    await db.query(
      `SELECT day::STRING AS day, easy_id::STRING AS easy_id, hard_id::STRING AS hard_id, expert_id::STRING AS expert_id,
              easy_steps, hard_steps, expert_steps, source, generator, created_at::STRING AS created_at${hasMeta ? ", meta" : ""}
         FROM ${schema}.challenges WHERE day = ANY($1::DATE[]) ORDER BY day`,
      [[...days]],
    )
  ).rows;
  fs.writeFileSync(file, JSON.stringify({ kind: "challenge-backup", schema, takenAt: new Date().toISOString(), days: days.length, rows }, null, 1));
  return rows.length;
}

export async function applyPlan(
  pool: pg.Pool,
  schema: string,
  plan: PlanFile,
  { reason, allowFrozen, allowNoMeta = false, backupOut }: { reason: string; allowFrozen: boolean; allowNoMeta?: boolean; backupOut?: string },
) {
  const days = plan.rows.map((r) => r.day);
  if (backupOut) {
    const n = await backupRows(pool, schema, days, backupOut);
    console.log(`Backed up ${fmt(n)} stored row(s) of the ${fmt(days.length)} planned day(s) to ${backupOut} (the apply refuses if any of them changes before it commits).`);
  }
  return retrying("apply challenge plan", async () => {
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const now = new Date();
      refuseFrozen(days, now, allowFrozen, "checked in the transaction");
      const done = await completionsOn(client, schema, days);
      if (done.size) throw new Error(`refused: challenge completions exist on planned day(s) ${[...done.keys()].sort().join(", ")} (checked in the transaction)`);
      const hasMeta = await columnExists(client, schema, "challenges", "meta");
      refuseWithoutMeta(days, hasMeta, allowNoMeta, "plan (checked in the transaction)");
      const current = new Map(
        (
          await client.query<StoredSqlRow>(
            `SELECT day::STRING AS day, source, generator, easy_id::STRING AS easy_id, hard_id::STRING AS hard_id, expert_id::STRING AS expert_id${hasMeta ? ", meta" : ""}
               FROM ${schema}.challenges WHERE day = ANY($1::DATE[]) FOR UPDATE`,
            [days],
          )
        ).rows.map((r) => [r.day, toStored(r)]),
      );
      const changed: string[] = [];
      for (const r of plan.rows) {
        const cur = current.get(r.day) ?? null;
        const same =
          (cur === null && r.prev === null) ||
          (cur !== null &&
            r.prev !== null &&
            cur.source === r.prev.source &&
            cur.generator === r.prev.generator &&
            TIERS.every((t) => cur.targets[t] === r.prev!.targets[t]));
        if (!same) changed.push(r.day);
        if (cur && cur.source !== "generated") changed.push(`${r.day} (source ${cur.source}: never replaced)`);
      }
      if (changed.length) throw new Error(`refused: stored row(s) changed since the plan was made: ${changed.slice(0, 10).join(", ")}; re-run the dry run`);
      const at = now.toISOString();
      const toWrite = plan.rows.map((r) => ({ ...r, meta: { ...r.meta, replaced: nextReplaced(current.get(r.day) ?? null, reason, at) } }));
      const del = await client.query(`DELETE FROM ${schema}.challenges WHERE source = 'generated' AND day = ANY($1::DATE[])`, [days]);
      const ins = await insertRows(client, schema, toWrite, { hasMeta, onConflict: "error" });
      if (ins !== plan.rows.length) throw new Error(`expected to insert ${plan.rows.length} day(s), inserted ${ins}; rolled back`);
      refuseFrozen(days, new Date(), allowFrozen, "re-checked right before COMMIT; rolled back");
      await client.query("COMMIT");
      return { deleted: del.rowCount ?? 0, inserted: ins, hasMeta };
    } catch (e) {
      await client.query("ROLLBACK").catch(() => {});
      throw e;
    } finally {
      client.release();
    }
  });
}

// ---------------------------------------------------------------- CLI

function resolveDays(
  values: { from?: string; days?: string; only?: string },
  stored: readonly StoredRow[],
  mode: "replace" | "missing",
  now: Date,
): string[] {
  const byDay = new Map(stored.map((r) => [r.day, r]));
  let range: string[];
  if (values.only) {
    range = [...new Set(values.only.split(",").map((s) => s.trim()))].sort();
    for (const d of range) if (!isDay(d)) throw new Error(`--only: bad day ${d}`);
  } else {
    const fromFlag = values.from ?? (mode === "missing" ? CHALLENGE_CUTOVER_DAY : "auto");
    const from = fromFlag === "auto" ? addDays(writeFrozenThrough(now), 1) : fromFlag;
    if (!isDay(from) || from < CHALLENGE_CUTOVER_DAY) throw new Error(`--from must be auto or a day on/after ${CHALLENGE_CUTOVER_DAY}`);
    const end = values.days ? addDays(from, Number.parseInt(values.days, 10)) : horizonEnd();
    if (!(end > from)) throw new Error("--days must be positive (and --from before the horizon)");
    range = dayRange(from, daysBetween(from, end));
  }
  if (mode === "missing") return range.filter((d) => !byDay.has(d));
  const legacy = range.filter((d) => byDay.get(d) && byDay.get(d)!.source !== "generated");
  if (legacy.length) throw new Error(`refused: ${legacy.length} day(s) in range are not generated rows (never replaced): ${legacy.slice(0, 5).join(", ")}`);
  return range;
}

if (isMain(import.meta.url)) {
  runMain(async () => {
    const { values } = parseArgs({
      options: {
        schema: { type: "string" },
        from: { type: "string" },
        days: { type: "string" },
        only: { type: "string" },
        show: { type: "string" },
        reason: { type: "string" },
        "dry-run": { type: "boolean" },
        "missing-only": { type: "boolean" },
        "replace-generated": { type: "boolean" },
        "plan-out": { type: "string" },
        "apply-plan": { type: "string" },
        "allow-frozen": { type: "boolean" },
        "allow-no-meta": { type: "boolean" },
        "snapshot-in": { type: "string" },
        "snapshot-out": { type: "string" },
        "tags-in": { type: "string" },
        "backup-out": { type: "string" },
      },
    });
    const schema = resolveSchema(values.schema);
    const show = values.show ? Number.parseInt(values.show, 10) : 21;
    const allowFrozen = values["allow-frozen"] ?? false;
    const allowNoMeta = values["allow-no-meta"] ?? false;
    const now = new Date();
    const frozenThrough = writeFrozenThrough(now);
    const tagsFile = values["tags-in"] ? JSON.parse(fs.readFileSync(values["tags-in"], "utf8")) : undefined;

    // ---- apply a reviewed plan
    if (values["apply-plan"]) {
      const reason = values.reason;
      if (!reason) throw new Error("--apply-plan needs --reason=<code> (e.g. jit, v6-rollout)");
      const plan = JSON.parse(fs.readFileSync(values["apply-plan"], "utf8")) as PlanFile;
      if (plan.kind !== "challenge-plan" || plan.generator !== GENERATOR) throw new Error(`not a ${GENERATOR} plan file`);
      if (plan.schema !== schema) throw new Error(`plan is for schema ${plan.schema}, not ${schema}`);
      const days = plan.rows.map((r) => r.day);
      console.log(
        `Plan ${plan.planHash}: ${days.length} day(s) ${days[0]}..${days.at(-1)}, made ${plan.createdAt} (config ${plan.configHash}, git ${plan.gitSha}); ` +
          `frozen through ${frozenThrough} now (incl. the ${APPLY_FREEZE_MARGIN_MS / 60_000} min write margin).`,
      );
      if (plan.configHash !== configHash()) console.warn(`WARNING: the plan was made with config ${plan.configHash}; this code is ${configHash()} (rows are written exactly as planned).`);
      refuseFrozen(days, now, allowFrozen, "checked at start");
      const pool = createPool(2);
      try {
        const snap = await readSnapshot(pool, schema, now);
        refuseWithoutMeta(days, snap.hasMeta, allowNoMeta, "plan");
        const prep = prepareContext(snap, tagsFile);
        const failures = revalidate(plan, prep.ctx);
        if (failures.length) throw new Error(`refused: ${failures.length} planned target(s) fail C1/C2/C4/C5/C5b/C8 now; nothing written. Re-run the dry run.\n  ${failures.join("\n  ")}`);
        const { deleted, inserted, hasMeta } = await applyPlan(pool, schema, plan, { reason, allowFrozen, allowNoMeta, backupOut: values["backup-out"] });
        console.log(`Applied: deleted ${fmt(deleted)} generated day(s), inserted ${fmt(inserted)} (one transaction; reason ${reason}).`);
        if (!hasMeta) console.warn("WARNING: --allow-no-meta: rows were written WITHOUT meta (no meta.replaced or experiment log for them).");
        console.log(`Next: npm run db:check-challenges -- --days=${Math.max(9, daysBetween(utcDay(now), days.at(-1)!) + 1)}`);
      } finally {
        await pool.end();
      }
      return;
    }

    const replace = values["replace-generated"] ?? false;
    const missingOnly = values["missing-only"] ?? (!replace && !values["dry-run"] && !values["plan-out"]);
    const mode = missingOnly ? "missing" : "replace";
    const dryRun = (values["dry-run"] ?? false) || !!values["snapshot-in"] || (!replace && !missingOnly);
    if (replace && values["snapshot-in"]) throw new Error("--snapshot-in is offline: it cannot be combined with --replace-generated");

    let snap: Snapshot;
    const pool = values["snapshot-in"] ? null : createPool(2);
    try {
      if (values["snapshot-in"]) {
        snap = JSON.parse(fs.readFileSync(values["snapshot-in"], "utf8")) as Snapshot;
        if (snap.kind !== "challenge-snapshot") throw new Error("not a challenge snapshot file");
        console.log(`Snapshot ${values["snapshot-in"]} taken ${snap.takenAt} (schema ${snap.schema}); offline dry run.`);
      } else {
        snap = await readSnapshot(pool!, schema, now);
        if (values["snapshot-out"]) {
          fs.writeFileSync(values["snapshot-out"], JSON.stringify(snap));
          console.log(`Saved the snapshot to ${values["snapshot-out"]}.`);
        }
      }
      const t0 = performance.now();
      const prep = prepare(snap, tagsFile);
      console.log(
        `Schema "${snap.schema}": ${fmt(snap.elements.length)} active elements, ${fmt(snap.allRecipes.length)} active recipes; ` +
          `${snap.hasMeta ? "challenges.meta present" : "challenges.meta MISSING (migration 0010): writes refuse until it is applied"}; ` +
          `${snap.hasTags ? "elements.challenge_tags present" : "no elements.challenge_tags (classifier tags unavailable: appeal/teacher/synonyms off)"}.\n`,
      );
      printPools(prep);

      const days = resolveDays(values, snap.stored, mode, now);
      if (days.length === 0) {
        console.log(`\nNothing to plan (${mode === "missing" ? "no missing days in range" : "empty range"}).`);
        return;
      }
      const frozenDays = days.filter((d) => d <= frozenThrough);
      console.log(
        `\nPlanning ${fmt(days.length)} day(s) ${days[0]}..${days.at(-1)} (${mode === "missing" ? "missing days only" : "re-pick generated + fill missing"}); ` +
          `frozen through ${frozenThrough} now; the first day freezes at ${repickDeadline(days[0]!).toISOString().slice(0, 16).replace("T", " ")} UTC.`,
      );
      if (frozenDays.length && mode === "replace") {
        if (dryRun) console.warn(`WARNING: ${frozenDays.length} planned day(s) are already frozen (${frozenDays.slice(0, 5).join(", ")}): an apply would refuse them.`);
        else refuseFrozen(days, now, allowFrozen, "checked at start");
      }
      const plan = makePlan(snap, prep, days, now);
      console.log(`Planned in ${Math.round(performance.now() - t0)} ms; plan ${plan.planHash}, config ${plan.configHash}, git ${plan.gitSha}.`);
      printPlan(plan, prep, show);
      if (values["plan-out"]) {
        fs.writeFileSync(values["plan-out"], JSON.stringify(plan, null, 1));
        console.log(`\nWrote the plan to ${values["plan-out"]} (${plan.rows.length} rows). Apply with: npm run db:challenges -- --apply-plan=${values["plan-out"]} --reason=<code>`);
      }
      if (dryRun) {
        console.log("\nDry run: nothing written.");
        return;
      }

      refuseWithoutMeta(days, snap.hasMeta, allowNoMeta, mode === "missing" ? "insert" : "re-pick");
      if (mode === "missing") {
        const inserted = await insertRows(pool!, schema, plan.rows, { hasMeta: snap.hasMeta, onConflict: "nothing" });
        console.log(`\nInserted ${fmt(inserted)} missing challenge day(s) into ${schema}.challenges (existing days untouched).`);
        return;
      }
      const reason = values.reason ?? "replace-generated";
      const done = await completionsOn(pool!, schema, days);
      if (done.size) throw new Error(`refused: challenge completions exist on planned day(s) ${[...done.keys()].sort().join(", ")}`);
      const { deleted, inserted, hasMeta } = await applyPlan(pool!, schema, plan, { reason, allowFrozen, allowNoMeta, backupOut: values["backup-out"] });
      console.log(`\nReplaced: deleted ${fmt(deleted)} generated day(s) and inserted ${fmt(inserted)} into ${schema}.challenges (one transaction; reason ${reason}).`);
      if (!hasMeta) console.warn("WARNING: --allow-no-meta: rows were written WITHOUT meta.");
    } finally {
      await pool?.end();
    }
  });
}

