// Load the active element/recipe world that the challenge pools are built from
// (shared by scripts/generate-challenges.ts, scripts/check-challenges.ts,
// scripts/classify-recognizable.ts and scripts/build-pages.ts).
// Needs migration 0003 (elements.recognizable).
import type pg from "pg";
import type { PoolElement } from "./challenges.ts";
import type { GraphRecipe } from "./graph.ts";

export interface WorldElement extends PoolElement {
  steps: number | null;
  depth: number | null;
  imageStatus: string;
}

/** `db` may be a client inside a (read-only) transaction, so a check sees one snapshot. */
export async function loadWorld(db: pg.Pool | pg.PoolClient, schema: string): Promise<{ elements: WorldElement[]; recipes: GraphRecipe[] }> {
  const elements = (
    await db.query<{ id: string; name: string; is_starter: boolean; steps: number | null; depth: number | null; image_status: string; recognizable: boolean | null }>(
      `SELECT id, name, is_starter, steps, depth, image_status, recognizable FROM ${schema}.elements WHERE status = 'active'`,
    )
  ).rows.map((e) => ({
    id: e.id,
    name: e.name,
    isStarter: e.is_starter,
    steps: e.steps,
    depth: e.depth,
    imageStatus: e.image_status,
    recognizable: e.recognizable,
  }));
  const recipes = (
    await db.query<{ ingredient_ids: string[]; result_id: string }>(
      `SELECT ingredient_ids, result_id FROM ${schema}.recipes WHERE status = 'active' AND arity = 2`,
    )
  ).rows.map((r) => ({ ingredients: r.ingredient_ids, result: r.result_id }));
  return { elements, recipes };
}
