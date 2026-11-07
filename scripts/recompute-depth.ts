// Lower stale depth/steps left behind by live play (docs/ARCHITECTURE.md "Data model").
//
//   npm run db:depth                  # dry run (default): print what would be lowered
//   npm run db:depth -- --run         # write the lowered values
//   --schema <name>                   # default: DB_SCHEMA, else "alchemy"
//
// When a combine finds a shorter recipe it lowers only the result's depth/steps; everything made
// from that result keeps its old, too-high values (so rarity and the challenge generator's tiers
// drift). This recomputes both metrics over the live graph (active elements, active recipes whose
// result and every ingredient are active; Knuth fixpoint in scripts/lib/graph.ts) and writes only
// LOWER values. It never raises a value or sets one to NULL: increases belong to `db:purge`.
// Run it periodically (e.g. weekly), but never while `db:purge apply` or `db:purge restore` runs.
import "./lib/env.ts";
import { parseArgs } from "node:util";
import { rarityForDepth } from "../src/shared/rarity.ts";
import { isMain, printTable, runMain } from "./lib/cli.ts";
import { chunk, createPool, fmt, resolveSchema, retrying } from "./lib/db.ts";
import { computeDepthSteps, type GraphRecipe } from "./lib/graph.ts";

const BATCH = 5_000;

export interface DepthElement {
  id: string;
  isStarter: boolean;
  depth: number | null;
  steps: number | null;
}

export interface DepthUpdate {
  id: string;
  /** New values: never above the stored ones (a lower stored value is kept). */
  depth: number;
  steps: number;
  before: { depth: number | null; steps: number | null };
}

/** Elements whose recomputed depth or steps is lower than stored (or stored NULL but reachable). */
export function loweredDepthSteps(elements: readonly DepthElement[], recipes: readonly GraphRecipe[]): DepthUpdate[] {
  const active = new Set(elements.map((e) => e.id));
  const live = recipes.filter((r) => active.has(r.result) && r.ingredients.every((i) => active.has(i)));
  const { depth, steps } = computeDepthSteps(
    elements.filter((e) => e.isStarter).map((e) => e.id),
    live,
  );
  const out: DepthUpdate[] = [];
  for (const e of elements) {
    const d = depth.value.get(e.id);
    const s = steps.value.get(e.id);
    if (d === undefined || s === undefined) continue; // unreachable: leave as is (never NULL)
    const nd = e.depth === null ? d : Math.min(e.depth, d);
    const ns = e.steps === null ? s : Math.min(e.steps, s);
    if (nd !== e.depth || ns !== e.steps) out.push({ id: e.id, depth: nd, steps: ns, before: { depth: e.depth, steps: e.steps } });
  }
  return out;
}

if (isMain(import.meta.url)) {
  runMain(async () => {
    const { values } = parseArgs({ options: { schema: { type: "string" }, run: { type: "boolean" } } });
    const schema = resolveSchema(values.schema);
    const run = values.run ?? false;
    console.warn(`Do not run this while \`npm run db:purge -- apply\` or \`restore\` is running on ${schema}.`);
    const pool = createPool(2);
    try {
      const t0 = performance.now();
      // A follower read is fine: the write is guarded by the values current at write time.
      const aost = "AS OF SYSTEM TIME follower_read_timestamp()";
      const [els, recs] = await Promise.all([
        pool.query<{ id: string; is_starter: boolean; depth: number | null; steps: number | null; name: string }>(
          `SELECT id, name, is_starter, depth, steps FROM ${schema}.elements ${aost} WHERE status = 'active'`,
        ),
        pool.query<{ ingredient_ids: string[]; result_id: string }>(
          `SELECT ingredient_ids, result_id FROM ${schema}.recipes ${aost} WHERE status = 'active'`,
        ),
      ]);
      const elements = els.rows.map((e) => ({ id: e.id, isStarter: e.is_starter, depth: e.depth, steps: e.steps }));
      const updates = loweredDepthSteps(
        elements,
        recs.rows.map((r) => ({ ingredients: r.ingredient_ids, result: r.result_id })),
      );
      const name = new Map(els.rows.map((e) => [e.id, e.name]));
      const depthLowered = updates.filter((u) => u.depth !== u.before.depth).length;
      const stepsLowered = updates.filter((u) => u.steps !== u.before.steps).length;
      const rarityChanged = updates.filter((u) => rarityForDepth(u.depth) !== rarityForDepth(u.before.depth)).length;
      console.log(
        `[${schema}] ${fmt(elements.length)} active elements, ${fmt(recs.rows.length)} active recipes ` +
          `(${((performance.now() - t0) / 1000).toFixed(1)}s): ${fmt(updates.length)} to lower ` +
          `(depth ${fmt(depthLowered)}, steps ${fmt(stepsLowered)}, rarity tier ${fmt(rarityChanged)})`,
      );
      printTable(
        updates.slice(0, 15).map((u) => ({
          name: name.get(u.id) ?? u.id,
          depth: `${u.before.depth ?? "-"} -> ${u.depth}`,
          steps: `${u.before.steps ?? "-"} -> ${u.steps}`,
        })),
      );
      if (!run) {
        console.log("Dry run: nothing written (pass --run to write).");
        return;
      }
      let written = 0;
      for (const batch of chunk(updates, BATCH)) {
        const res = await retrying("depth/steps", () =>
          pool.query(
            `UPDATE ${schema}.elements AS e
                SET depth = LEAST(COALESCE(e.depth, u.d), u.d), steps = LEAST(COALESCE(e.steps, u.s), u.s)
               FROM unnest($1::INT8[], $2::INT4[], $3::INT4[]) AS u(id, d, s)
              WHERE e.id = u.id AND e.status = 'active'
                AND (e.depth IS NULL OR e.depth > u.d OR e.steps IS NULL OR e.steps > u.s)`,
            [batch.map((u) => u.id), batch.map((u) => u.depth), batch.map((u) => u.steps)],
          ),
        );
        written += res.rowCount ?? 0;
      }
      console.log(`[${schema}] lowered depth/steps on ${fmt(written)} element(s).`);
    } finally {
      await pool.end();
    }
  });
}
