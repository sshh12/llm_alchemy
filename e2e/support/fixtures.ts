// Typed access to e2e/fixtures.json, which scripts/seed-e2e.ts writes after resetting the
// alchemy_e2e world. Validated once so a contract drift fails with a readable message instead
// of a confusing selector timeout deep inside a test.
import fs from "node:fs";
import { z } from "zod";
import type { Tier } from "../../src/shared/api.ts";
import { FIXTURES_PATH } from "./env.ts";

const tier = z.enum(["easy", "hard", "expert"]);
const name = z.string().min(1);

const recipe = z.object({ ingredients: z.array(name).min(2).max(4), result: name });

const legacyElement = z.object({
  id: z.string().regex(/^\d+$/),
  name: z.string(),
  imgUrl: z.string().nullable().optional(),
  starterElement: z.boolean(),
  createdAt: z.string().optional(),
  createdUserId: z.string().nullable().optional(),
  valid: z.boolean().optional(),
});

const legacyUser = z.object({
  userId: z.string().regex(/^alchemy:[0-9a-f-]{36}$/),
  /** Exactly what the 2023 app kept in localStorage['elements']. */
  elements: z.array(legacyElement.passthrough()).min(1),
  /** Display names that must be in the library after the import. */
  expectPresent: z.array(name).min(1),
  /** Display names of quarantined legacy elements that must NOT show up. */
  expectAbsent: z.array(name),
  /** An element this legacy player discovered first (must stay credited), if any. */
  firstDiscovery: name.optional(),
  /** Legacy challenge completions that must appear in the history. */
  history: z.array(z.object({ day: z.string().regex(/^\d{4}-\d{2}-\d{2}$/), completed: z.array(tier).min(1) })).min(1),
});

const fixturesSchema = z.object({
  schema: z.literal("alchemy_e2e"),
  starters: z.array(name).length(5),
  recipes: z.array(recipe).min(1),
  unknownCombos: z.array(z.array(name).min(2).max(4)).min(8),
  challenge: z.object({
    days: z.array(z.string().regex(/^\d{4}-\d{2}-\d{2}$/)).min(1),
    easy: name,
    hard: name,
    expert: name,
    /** Ordered recipes that make the easy target starting from the starters. */
    easyPath: z.array(recipe).min(1),
  }),
  legacyUsers: z.array(legacyUser).min(1),
});

export type Recipe = z.infer<typeof recipe>;
export type LegacyUser = z.infer<typeof legacyUser>;
export type LegacyElement = z.infer<typeof legacyElement>;
export type Fixtures = z.infer<typeof fixturesSchema> & { challenge: { [K in Tier]: string } };

let cached: Fixtures | null = null;

export function loadFixtures(): Fixtures {
  if (cached) return cached;
  if (!fs.existsSync(FIXTURES_PATH)) {
    throw new Error(`${FIXTURES_PATH} is missing: global setup runs \`npm run db:seed-e2e\`, which must write it`);
  }
  const parsed = fixturesSchema.safeParse(JSON.parse(fs.readFileSync(FIXTURES_PATH, "utf8")));
  if (!parsed.success) {
    throw new Error(`e2e/fixtures.json does not match the contract in e2e/README.md:\n${z.prettifyError(parsed.error)}`);
  }
  cached = parsed.data;
  return cached;
}

/**
 * Shortest list of known recipes that produces `target` from the starters (BFS over the
 * fixture's recipes). Lets a test obtain any intermediate it needs before combining.
 */
export function recipePathTo(fx: Fixtures, target: string): Recipe[] {
  if (fx.starters.includes(target)) return [];
  const have = new Map<string, Recipe[]>(fx.starters.map((s) => [s, []]));
  for (let changed = true; changed && !have.has(target); ) {
    changed = false;
    for (const r of fx.recipes) {
      if (have.has(r.result) || !r.ingredients.every((i) => have.has(i))) continue;
      const path: Recipe[] = [];
      for (const i of new Set(r.ingredients)) for (const step of have.get(i)!) if (!path.includes(step)) path.push(step);
      path.push(r);
      have.set(r.result, path);
      changed = true;
    }
  }
  const path = have.get(target);
  if (!path) throw new Error(`fixtures.json has no recipe path from the starters to ${target}`);
  return path;
}

/**
 * A combination nobody has made yet, distinct per (project, slot) so parallel projects never
 * race for the same "first discovery".
 */
export function unknownCombo(fx: Fixtures, projectIdx: number, slot: number, slotsPerProject = 2): string[] {
  const i = projectIdx * slotsPerProject + slot;
  const combo = fx.unknownCombos[i];
  if (!combo) throw new Error(`fixtures.json needs at least ${i + 1} unknownCombos (has ${fx.unknownCombos.length})`);
  return combo;
}
