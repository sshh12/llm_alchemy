// Load the active element/recipe world that the challenge pools are built from
// (shared by scripts/generate-challenges.ts and scripts/classify-recognizable.ts).
// Needs migration 0003 (elements.recognizable).
import type pg from "pg";
import type { PoolElement } from "./challenges.ts";
import type { GraphRecipe } from "./graph.ts";

export interface WorldElement extends PoolElement {
  steps: number | null;
}

export async function loadWorld(pool: pg.Pool, schema: string): Promise<{ elements: WorldElement[]; recipes: GraphRecipe[] }> {
  const elements = (
    await pool.query<{ id: string; name: string; is_starter: boolean; steps: number | null; recognizable: boolean | null }>(
      `SELECT id, name, is_starter, steps, recognizable FROM ${schema}.elements WHERE status = 'active'`,
    )
  ).rows.map((e) => ({ id: e.id, name: e.name, isStarter: e.is_starter, steps: e.steps, recognizable: e.recognizable }));
  const recipes = (
    await pool.query<{ ingredient_ids: string[]; result_id: string }>(
      `SELECT ingredient_ids, result_id FROM ${schema}.recipes WHERE status = 'active' AND arity = 2`,
    )
  ).rows.map((r) => ({ ingredients: r.ingredient_ids, result: r.result_id }));
  return { elements, recipes };
}
