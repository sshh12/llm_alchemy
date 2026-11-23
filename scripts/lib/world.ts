// Load the active element/recipe world that the challenge pools are built from
// (shared by scripts/generate-challenges.ts, scripts/check-challenges.ts,
// scripts/classify-recognizable.ts and scripts/build-pages.ts).
// Needs migration 0003 (elements.recognizable); reads elements.challenge_tags when migration 0010
// is applied (and works without it).
import type pg from "pg";
import type { ChallengeTags, PoolElement } from "./challenges.ts";
import { computeDepthSteps, type GraphRecipe } from "./graph.ts";

export interface WorldElement extends PoolElement {
  steps: number | null;
  depth: number | null;
  imageStatus: string;
  emoji: string | null;
  notable: boolean;
  tags: ChallengeTags | null;
}

/** Whether `schema.table.column` exists (optional migrations: 0010 challenges.meta, elements.challenge_tags). */
export async function columnExists(db: pg.Pool | pg.PoolClient, schema: string, table: string, column: string): Promise<boolean> {
  const r = await db.query(`SELECT 1 FROM information_schema.columns WHERE table_schema = $1 AND table_name = $2 AND column_name = $3`, [schema, table, column]);
  return (r.rowCount ?? 0) > 0;
}

export interface LoadedWorld {
  elements: WorldElement[];
  /** Active 2-ingredient recipes. */
  recipes: GraphRecipe[];
  /** Every active recipe (any arity), only with { allRecipes: true }: for fresh steps (withFreshSteps). */
  allRecipes?: GraphRecipe[];
  /** elements.challenge_tags exists (migration 0010). */
  hasTags: boolean;
}

/** `db` may be a client inside a (read-only) transaction, so a check sees one snapshot. */
export async function loadWorld(db: pg.Pool | pg.PoolClient, schema: string, opts: { allRecipes?: boolean } = {}): Promise<LoadedWorld> {
  const hasTags = await columnExists(db, schema, "elements", "challenge_tags");
  const elements = (
    await db.query<{
      id: string;
      name: string;
      is_starter: boolean;
      steps: number | null;
      depth: number | null;
      image_status: string;
      recognizable: boolean | null;
      emoji: string | null;
      notable: boolean;
      challenge_tags: ChallengeTags | null;
    }>(
      `SELECT id, name, is_starter, steps, depth, image_status, recognizable, emoji, notable${hasTags ? ", challenge_tags" : ", NULL AS challenge_tags"}
         FROM ${schema}.elements WHERE status = 'active'`,
    )
  ).rows.map((e) => ({
    id: e.id,
    name: e.name,
    isStarter: e.is_starter,
    steps: e.steps,
    depth: e.depth,
    imageStatus: e.image_status,
    recognizable: e.recognizable,
    emoji: e.emoji,
    notable: e.notable,
    tags: e.challenge_tags ?? null,
  }));
  const rows = (
    await db.query<{ ingredient_ids: string[]; result_id: string }>(
      `SELECT ingredient_ids, result_id FROM ${schema}.recipes WHERE status = 'active'${opts.allRecipes ? "" : " AND arity = 2"}`,
    )
  ).rows.map((r) => ({ ingredients: r.ingredient_ids, result: r.result_id }));
  const recipes = opts.allRecipes ? rows.filter((r) => r.ingredients.length === 2) : rows;
  return { elements, recipes, ...(opts.allRecipes ? { allRecipes: rows } : {}), hasTags };
}

/**
 * Current steps as `npm run db:depth -- --run` would leave them: min(stored, recomputed over the
 * live graph of every arity), so a plan or check never depends on whether db:depth ran first.
 * Unreachable elements keep their stored value. `stale` = elements whose stored steps are higher.
 */
export function withFreshSteps<E extends { id: string; isStarter: boolean; steps: number | null }>(
  elements: readonly E[],
  allRecipes: readonly GraphRecipe[],
): { elements: E[]; stale: number } {
  const active = new Set(elements.map((e) => e.id));
  const live = allRecipes.filter((r) => active.has(r.result) && r.ingredients.every((i) => active.has(i)));
  const { steps } = computeDepthSteps(
    elements.filter((e) => e.isStarter).map((e) => e.id),
    live,
  );
  let stale = 0;
  const out = elements.map((e) => {
    const s = steps.value.get(e.id);
    if (s === undefined) return e;
    const fresh = e.steps === null ? s : Math.min(e.steps, s);
    if (fresh !== e.steps) stale++;
    return fresh === e.steps ? e : { ...e, steps: fresh };
  });
  return { elements: out, stale };
}

/** Max recipe created_at (meta.worldAsOf). */
export async function worldAsOf(db: pg.Pool | pg.PoolClient, schema: string): Promise<string> {
  const r = await db.query<{ t: string | null }>(`SELECT max(created_at)::STRING AS t FROM ${schema}.recipes`);
  return r.rows[0]?.t ?? "";
}

/** Apply a --tags-in file ({id: tags} or [{id, ...tags}]) over the loaded tags. */
export function applyTags<E extends { id: string; tags?: ChallengeTags | null }>(elements: readonly E[], file: unknown): { elements: E[]; applied: number } {
  const map = new Map<string, ChallengeTags>();
  if (Array.isArray(file)) {
    for (const r of file as ({ id: string } & ChallengeTags)[]) if (r && typeof r.id === "string") map.set(r.id, r);
  } else if (file && typeof file === "object") {
    for (const [id, t] of Object.entries(file as Record<string, ChallengeTags>)) map.set(id, t);
  }
  let applied = 0;
  const out = elements.map((e) => {
    const t = map.get(e.id);
    if (!t) return e;
    applied++;
    return { ...e, tags: { ...(e.tags ?? {}), ...t } };
  });
  return { elements: out, applied };
}
