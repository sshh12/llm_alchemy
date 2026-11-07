// Pure parts of the element purge (scripts/purge-elements.ts): reviewer verdict validation, the
// never-purge set, the leaf cascade (what becomes unreachable once the junk is gone), depth/steps
// recomputation, and which future challenge days must be re-picked.
import type { Tier } from "../../src/shared/api.ts";
import { utcDay } from "../../src/shared/dates.ts";
import { nameKey } from "../../src/shared/names.ts";
import { TIERS, type TierPool } from "./challenges.ts";
import { depthOf, derivationClosure, knuthFixpoint, stepsOf, type GraphRecipe, type Metric } from "./graph.ts";

export const PASSES = ["review", "verify"] as const;
export type Pass = (typeof PASSES)[number];
export const VERDICTS = ["purge", "keep"] as const;
export type Verdict = (typeof VERDICTS)[number];
/** elements.quarantine_reason values (migration 0004). */
export const REASON = { legacy: "legacy-filter", review: "review", orphaned: "orphaned" } as const;
export const MAX_REASON_CHARS = 200;
export const ID_RE = /^[1-9][0-9]{0,19}$/;
export const RUN_ID_RE = /^purge-\d{8}-\d{6}$/;
const HOUR = 3_600_000;

/** purge-YYYYMMDD-HHMMSS (UTC). */
export function makeRunId(d: Date = new Date()): string {
  const iso = d.toISOString();
  return `purge-${iso.slice(0, 10).replaceAll("-", "")}-${iso.slice(11, 19).replaceAll(":", "")}`;
}

// ---------------------------------------------------------------- verdict files

export interface VerdictItem {
  id: string;
  verdict: Verdict;
  reason: string;
  /** Optional echo of the element name; checked against the database when present. */
  name?: string;
}

export type VerdictParse = { ok: true; items: VerdictItem[]; warnings: string[] } | { ok: false; errors: string[] };

export const VERDICT_EXAMPLE = '[{"id":"1083333177628557313","verdict":"purge","reason":"garbled compound"}]';

/**
 * Parse a reviewer's verdict file: a JSON array of {id, verdict, reason[, name]} or the same
 * objects as JSON Lines. ids must be decimal STRINGS (INT8 ids lose precision as JSON numbers).
 * verdict is case-insensitive "purge" | "keep"; reason is optional and truncated to
 * MAX_REASON_CHARS. Any problem rejects the whole file and every problem is listed.
 */
export function parseVerdictFile(text: string): VerdictParse {
  const body = text.replace(/^﻿/, "").trim();
  if (!body) return { ok: false, errors: [`the file is empty; expected a JSON array like ${VERDICT_EXAMPLE}`] };
  let raw: unknown;
  try {
    raw = JSON.parse(body);
  } catch (e) {
    // Not one JSON document: try JSON Lines (one object per line).
    const lines = body.split(/\r?\n/).filter((l) => l.trim() !== "");
    const parsed: unknown[] = [];
    for (const [i, line] of lines.entries()) {
      try {
        parsed.push(JSON.parse(line));
      } catch {
        return {
          ok: false,
          errors: [`not valid JSON (${(e as Error).message}) and line ${i + 1} is not valid JSON Lines either: ${line.slice(0, 80)}`, `expected a JSON array like ${VERDICT_EXAMPLE}`],
        };
      }
    }
    raw = parsed;
  }
  if (!Array.isArray(raw)) {
    return { ok: false, errors: [`the top level must be a JSON array of verdict objects, got ${raw === null ? "null" : typeof raw}; expected ${VERDICT_EXAMPLE}`] };
  }
  if (raw.length === 0) return { ok: false, errors: ["the array is empty: no verdicts to stage"] };

  const errors: string[] = [];
  const warnings: string[] = [];
  const byId = new Map<string, VerdictItem>();
  raw.forEach((it, i) => {
    const at = `item ${i + 1}`;
    if (typeof it !== "object" || it === null || Array.isArray(it)) {
      errors.push(`${at}: must be an object like {"id":"…","verdict":"purge","reason":"…"}`);
      return;
    }
    const o = it as Record<string, unknown>;
    const idRaw = o.id;
    if (typeof idRaw === "number") {
      errors.push(`${at}: id ${idRaw} is a JSON number; write it as a string in quotes, copied exactly from the batch file (large ids lose digits as numbers)`);
      return;
    }
    if (typeof idRaw !== "string" || !ID_RE.test(idRaw.trim())) {
      errors.push(`${at}: id must be a string of digits like "1083333177628557313", got ${JSON.stringify(idRaw)}`);
      return;
    }
    const id = idRaw.trim();
    const verdict = typeof o.verdict === "string" ? o.verdict.trim().toLowerCase() : o.verdict;
    if (verdict !== "purge" && verdict !== "keep") {
      errors.push(`${at} (id ${id}): verdict must be "purge" or "keep", got ${JSON.stringify(o.verdict)}`);
      return;
    }
    if (o.reason !== undefined && o.reason !== null && typeof o.reason !== "string") {
      errors.push(`${at} (id ${id}): reason must be a string, got ${typeof o.reason}`);
      return;
    }
    if (o.name !== undefined && o.name !== null && typeof o.name !== "string") {
      errors.push(`${at} (id ${id}): name must be a string, got ${typeof o.name}`);
      return;
    }
    let reason = typeof o.reason === "string" ? o.reason.trim().replace(/\s+/g, " ") : "";
    if (reason.length > MAX_REASON_CHARS) reason = reason.slice(0, MAX_REASON_CHARS);
    const item: VerdictItem = { id, verdict, reason, ...(typeof o.name === "string" ? { name: o.name } : {}) };
    const prev = byId.get(id);
    if (prev) {
      if (prev.verdict !== item.verdict) errors.push(`${at}: id ${id} appears twice with different verdicts ("${prev.verdict}" and "${item.verdict}"); keep one`);
      else warnings.push(`id ${id} appears twice with the same verdict; staged once`);
      return;
    }
    byId.set(id, item);
  });
  return errors.length ? { ok: false, errors } : { ok: true, items: [...byId.values()], warnings };
}

const letters = (s: string) => nameKey(s).replace(/[^a-z0-9]/g, "");

/** Levenshtein distance <= 1. */
function withinOneEdit(a: string, b: string): boolean {
  if (a === b) return true;
  if (Math.abs(a.length - b.length) > 1) return false;
  const [s, t] = a.length <= b.length ? [a, b] : [b, a];
  let i = 0;
  while (i < s.length && s[i] === t[i]) i++;
  return s.length === t.length ? s.slice(i + 1) === t.slice(i + 1) : s.slice(i) === t.slice(i + 1);
}

/** An echoed name matches up to case, spacing, punctuation and one typo. */
export const namesMatch = (echo: string, actual: string) => withinOneEdit(letters(echo), letters(actual));

export interface StageContext {
  pass: Pass;
  /** Rows for the ids in the file that exist in the database. */
  elements: ReadonlyMap<string, { name: string; status: string }>;
  /** For pass=verify: ids whose review verdict is 'purge'. */
  reviewPurge?: ReadonlySet<string>;
  /** When a manifest is given: the ids of the batch (from its batch file). */
  batchIds?: ReadonlySet<string>;
  batch: number;
}

/** Database-side checks for parsed verdicts (all-or-nothing). Returns the list of problems. */
export function checkVerdicts(items: readonly VerdictItem[], ctx: StageContext): string[] {
  const errors: string[] = [];
  for (const it of items) {
    const row = ctx.elements.get(it.id);
    if (!row) {
      errors.push(`id ${it.id}: no element has this id (copy the id exactly from the batch file)`);
      continue;
    }
    if (row.status !== "active") {
      errors.push(`id ${it.id} (${row.name}): element is not active (status ${row.status}); remove it from the file`);
      continue;
    }
    if (it.name !== undefined && !namesMatch(it.name, row.name)) {
      errors.push(`id ${it.id}: you wrote name ${JSON.stringify(it.name)} but this id is ${JSON.stringify(row.name)}; the id was probably copied wrong`);
      continue;
    }
    if (ctx.batchIds && !ctx.batchIds.has(it.id)) {
      errors.push(`id ${it.id} (${row.name}): not in batch ${ctx.batch}; stage it with its own batch number`);
      continue;
    }
    if (ctx.pass === "verify" && !ctx.reviewPurge?.has(it.id)) {
      errors.push(`id ${it.id} (${row.name}): --pass verify only accepts ids whose review verdict is "purge"; this one has none`);
    }
  }
  return errors;
}

// ---------------------------------------------------------------- the world

export interface PurgeElement {
  id: string;
  name: string;
  isStarter: boolean;
  depth: number | null;
  steps: number | null;
  recognizable?: boolean | null;
}

export interface PurgeRecipe extends GraphRecipe {
  id: string;
  protected: boolean;
}

export interface ChallengeDay {
  day: string;
  source: string;
  targets: Record<Tier, string>;
}

/** Active recipes whose result and ingredients are all active: the graph reachability runs on. */
export function liveRecipes<R extends GraphRecipe>(recipes: readonly R[], active: { has(id: string): boolean }): R[] {
  return recipes.filter((r) => active.has(r.result) && r.ingredients.every((i) => active.has(i)));
}

/**
 * Days the server may treat as "today" (UTC-12 .. UTC+14, as isPlausibleClientDay), widened by
 * `marginHours` at the late end so a day cannot become live while a purge is running. Days in
 * [first, last] are never re-picked and their targets' derivation paths are never purged.
 */
export function challengeWindow(now: Date = new Date(), marginHours = 2): { first: string; last: string } {
  return { first: utcDay(new Date(now.getTime() - 12 * HOUR)), last: utcDay(new Date(now.getTime() + (14 + marginHours) * HOUR)) };
}

export type NeverPurgeKind = "starter" | "challenge-target" | "live-path" | "protected-recipe";

/**
 * Elements that must never be purged or orphaned: starters; the target of any challenge day
 * (past or future); every element on the shortest derivations (depth and steps) of the targets
 * of the days in `window` (so today's challenge stays solvable); and every ingredient/result of
 * a protected recipe. `graph` must be the live recipe list the metrics were computed on.
 */
export function neverPurge(input: {
  elements: readonly PurgeElement[];
  recipes: readonly PurgeRecipe[];
  challenges: readonly ChallengeDay[];
  window: { first: string; last: string };
  graph: readonly GraphRecipe[];
  metrics: { depth: Metric; steps: Metric };
}): Map<string, NeverPurgeKind[]> {
  const out = new Map<string, NeverPurgeKind[]>();
  const add = (id: string, kind: NeverPurgeKind) => {
    const k = out.get(id);
    if (!k) out.set(id, [kind]);
    else if (!k.includes(kind)) k.push(kind);
  };
  for (const e of input.elements) if (e.isStarter) add(e.id, "starter");
  const live: string[] = [];
  for (const c of input.challenges) {
    for (const tier of TIERS) {
      add(c.targets[tier], "challenge-target");
      if (c.day >= input.window.first && c.day <= input.window.last) live.push(c.targets[tier]);
    }
  }
  for (const m of [input.metrics.depth, input.metrics.steps]) {
    for (const id of derivationClosure(live, input.graph, m).elements) add(id, "live-path");
  }
  for (const r of input.recipes) {
    if (!r.protected) continue;
    add(r.result, "protected-recipe");
    for (const i of r.ingredients) add(i, "protected-recipe");
  }
  return out;
}

// ---------------------------------------------------------------- the cascade

export interface DepthStepsUpdate {
  id: string;
  /** null = no longer reachable from the starters. */
  depth: number | null;
  steps: number | null;
}

/**
 * depth/steps rows to write so every element reachable over `graph` stores its true value.
 * Unreachable elements are left untouched (their stored value, usually NULL, is kept).
 */
export function depthStepsUpdates(elements: readonly PurgeElement[], depth: Metric, steps: Metric, skip?: ReadonlySet<string>): DepthStepsUpdate[] {
  const out: DepthStepsUpdate[] = [];
  for (const e of elements) {
    if (skip?.has(e.id)) continue;
    const d = depth.value.get(e.id);
    if (d === undefined) continue;
    const s = steps.value.get(e.id)!;
    if (e.depth !== d || e.steps !== s) out.push({ id: e.id, depth: d, steps: s });
  }
  return out;
}

export interface PurgeInput {
  /** ACTIVE elements. */
  elements: readonly PurgeElement[];
  /** ACTIVE recipes (any arity), including ones whose result/ingredients are not active. */
  recipes: readonly PurgeRecipe[];
  /** Ids judged junk (both passes said purge). */
  direct: Iterable<string>;
  /** Elements that are never purged nor orphaned (see neverPurge). */
  protect: ReadonlyMap<string, readonly NeverPurgeKind[]> | ReadonlySet<string>;
  /**
   * Quarantine elements that only junk made reachable (default true). With false they stay
   * active (players keep them) and become unreachable: their depth/steps are reset to NULL.
   */
  cascade?: boolean;
}

export interface PurgeEffect {
  /** Ids quarantined with reason 'review' (sorted). */
  direct: string[];
  /** Requested ids that are not purged, and why. */
  skipped: { id: string; why: "not-active" | "never-purge" }[];
  /** Ids quarantined with reason 'orphaned': reachable before, unreachable after (sorted). */
  orphans: string[];
  /** Cascade rounds until no new orphan appeared. */
  rounds: number;
  /** direct ∪ orphans. */
  removed: Set<string>;
  /** Never-purge elements that were reachable before and are not after (kept active). */
  collisions: string[];
  recipesByResult: PurgeRecipe[];
  recipesByIngredient: PurgeRecipe[];
  /** Protected recipes that touch a removed element (must be empty; never quarantined). */
  protectedHits: PurgeRecipe[];
  reachableBefore: number;
  reachableAfter: number;
  /** Active elements that were already unreachable before the purge (left as they are). */
  unreachableBefore: number;
  before: { depth: Metric; steps: Metric };
  after: { depth: Metric; steps: Metric };
  /** depth/steps to write for still-active elements that are reachable after the purge. */
  updates: DepthStepsUpdate[];
}

/**
 * The full effect of purging `direct`:
 *  1. reachability (depth) over the live graph from the starters, before;
 *  2. remove the direct purges, recompute; active non-starter, non-protected elements that were
 *     reachable before and are not now become orphans; repeat until no new orphan appears;
 *  3. recipes whose result is removed are quarantined unless protected; recipes that use a
 *     removed element as an ingredient are quarantined (dormant);
 *  4. depth/steps are recomputed over what is left.
 */
export function computePurge(input: PurgeInput): PurgeEffect {
  const active = new Map(input.elements.map((e) => [e.id, e]));
  const starters = input.elements.filter((e) => e.isStarter).map((e) => e.id);
  const graph = liveRecipes(input.recipes, active);
  const before = { depth: knuthFixpoint(starters, graph, depthOf), steps: knuthFixpoint(starters, graph, stepsOf) };

  const skipped: PurgeEffect["skipped"] = [];
  const removed = new Set<string>();
  for (const id of new Set(input.direct)) {
    const e = active.get(id);
    if (!e) skipped.push({ id, why: "not-active" });
    else if (e.isStarter || input.protect.has(id)) skipped.push({ id, why: "never-purge" });
    else removed.add(id);
  }
  const direct = [...removed];

  const orphans: string[] = [];
  let rounds = 0;
  let afterDepth: Metric;
  for (;;) {
    rounds++;
    const remaining = graph.filter((r) => !removed.has(r.result) && !r.ingredients.some((i) => removed.has(i)));
    afterDepth = knuthFixpoint(starters, remaining, depthOf);
    const fresh = input.elements.filter(
      (e) => !removed.has(e.id) && !e.isStarter && !input.protect.has(e.id) && before.depth.value.has(e.id) && !afterDepth.value.has(e.id),
    );
    if (fresh.length === 0 || input.cascade === false) break;
    for (const e of fresh) {
      removed.add(e.id);
      orphans.push(e.id);
    }
  }
  const remaining = graph.filter((r) => !removed.has(r.result) && !r.ingredients.some((i) => removed.has(i)));
  const after = { depth: afterDepth, steps: knuthFixpoint(starters, remaining, stepsOf) };

  const collisions = input.elements
    .filter((e) => !removed.has(e.id) && input.protect.has(e.id) && before.depth.value.has(e.id) && !after.depth.value.has(e.id))
    .map((e) => e.id);

  const recipesByResult: PurgeRecipe[] = [];
  const recipesByIngredient: PurgeRecipe[] = [];
  const protectedHits: PurgeRecipe[] = [];
  for (const r of input.recipes) {
    const byResult = removed.has(r.result);
    const byIngredient = r.ingredients.some((i) => removed.has(i));
    if (!byResult && !byIngredient) continue;
    if (r.protected) protectedHits.push(r);
    else if (byResult) recipesByResult.push(r);
    else recipesByIngredient.push(r);
  }

  const cmp = (a: string, b: string) => (BigInt(a) < BigInt(b) ? -1 : BigInt(a) > BigInt(b) ? 1 : 0);
  return {
    direct: direct.sort(cmp),
    skipped,
    orphans: orphans.sort(cmp),
    rounds,
    removed,
    collisions: collisions.sort(cmp),
    recipesByResult,
    recipesByIngredient,
    protectedHits,
    reachableBefore: before.depth.value.size,
    reachableAfter: after.depth.value.size,
    unreachableBefore: input.elements.filter((e) => !before.depth.value.has(e.id)).length,
    before,
    after,
    updates: [
      ...depthStepsUpdates(input.elements, after.depth, after.steps, removed),
      // Without the cascade, survivors that lost every path keep playing but are unreachable now.
      ...(input.cascade === false
        ? input.elements
            .filter((e) => !removed.has(e.id) && !input.protect.has(e.id) && before.depth.value.has(e.id) && !after.depth.value.has(e.id))
            .map((e) => ({ id: e.id, depth: null, steps: null }))
        : []),
    ],
  };
}

// ---------------------------------------------------------------- challenges

export interface BrokenDay {
  day: string;
  tiers: { tier: Tier; id: string; why: "inactive" | "out-of-pool" }[];
}

/**
 * Generated days after `cutoff` with a target that is not active (in `active`) or not in its
 * tier's candidate pool (BFS tier + recognizable rules, see buildPools) any more.
 */
export function brokenFutureDays(
  days: readonly ChallengeDay[],
  cutoff: string,
  active: { has(id: string): boolean },
  pools: Record<Tier, TierPool>,
): BrokenDay[] {
  const inPool = Object.fromEntries(TIERS.map((t) => [t, new Set(pools[t].candidates)])) as Record<Tier, Set<string>>;
  const out: BrokenDay[] = [];
  for (const c of days) {
    if (c.source !== "generated" || c.day <= cutoff) continue;
    const tiers: BrokenDay["tiers"] = [];
    for (const tier of TIERS) {
      const id = c.targets[tier];
      if (!active.has(id)) tiers.push({ tier, id, why: "inactive" });
      else if (!inPool[tier].has(id)) tiers.push({ tier, id, why: "out-of-pool" });
    }
    if (tiers.length) out.push({ day: c.day, tiers });
  }
  return out.sort((a, b) => (a.day < b.day ? -1 : 1));
}

/**
 * The days a purge breaks: tiers broken in `after` that were not already broken in `before`
 * (a target can drift out of its BFS tier when players add shorter recipes; the purge does not
 * re-pick those).
 */
export function newlyBroken(before: readonly BrokenDay[], after: readonly BrokenDay[]): BrokenDay[] {
  const pre = new Set(before.flatMap((b) => b.tiers.map((t) => `${b.day}:${t.tier}`)));
  return after.map((b) => ({ day: b.day, tiers: b.tiers.filter((t) => !pre.has(`${b.day}:${t.tier}`)) })).filter((b) => b.tiers.length > 0);
}

// ---------------------------------------------------------------- export helpers

/** "Panorama + Jungle": ingredient names of one recipe (duplicates kept, recipe-key order). */
export function recipeLabel(r: GraphRecipe, name: (id: string) => string | undefined): string {
  return r.ingredients.map((i) => name(i) ?? `#${i}`).join(" + ");
}

/**
 * One recipe that makes each element: the cheapest-derivation (steps) recipe for reachable
 * elements, else the first active recipe with all-active ingredients, else any active recipe.
 */
export function madeFromIndex(
  recipes: readonly PurgeRecipe[],
  graph: readonly PurgeRecipe[],
  steps: Metric,
  active: { has(id: string): boolean },
): Map<string, PurgeRecipe> {
  const out = new Map<string, PurgeRecipe>();
  for (const [id, ri] of steps.via) out.set(id, graph[ri]!);
  const fallback = new Map<string, PurgeRecipe>();
  for (const r of recipes) {
    if (out.has(r.result)) continue;
    if (r.ingredients.every((i) => active.has(i))) {
      if (!out.has(r.result)) out.set(r.result, r);
    } else if (!fallback.has(r.result)) fallback.set(r.result, r);
  }
  for (const [id, r] of fallback) if (!out.has(id)) out.set(id, r);
  return out;
}
