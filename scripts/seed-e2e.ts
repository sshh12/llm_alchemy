// (Re)create the small deterministic world in schema "alchemy_e2e" used by Playwright, and write
// the facts the suites rely on to e2e/fixtures.json (contract: e2e/support/fixtures.ts).
//
//   npm run db:seed-e2e
//
// Always targets alchemy_e2e (never the production schema): migrates it, wipes ONLY its tables,
// then inserts starters + ~30 elements with 1-, 2- and 3-step chains, a few quarantined legacy
// spam elements (one behind a quarantined recipe that the server must "heal"), challenges for
// local today-3 .. today+3 plus legacy history days, and 5 pre-created legacy players (one per
// Playwright project) with legacy ids in legacy_element_map. Unknown combinations are answered
// by the deterministic mock AI (server/ai/mock.ts); the seed picks combos whose mock answers
// are new names, so "first discovery" tests stay honest.
import "./lib/env.ts";
import fs from "node:fs";
import path from "node:path";
import type { Tier } from "../src/shared/api.ts";
import { addDays, localDay } from "../src/shared/dates.ts";
import { checkName, foldKey, nameKey, titleCase } from "../src/shared/names.ts";
import { mockCombine } from "../server/ai/mock.ts";
import { isMain, runMain } from "./lib/cli.ts";
import { createPool } from "./lib/db.ts";
import { REPO_ROOT } from "./lib/env.ts";
import { computeDepthSteps, sortIds } from "./lib/graph.ts";
import { STARTER_EMOJI } from "./lib/legacy.ts";
import { migrate } from "./migrate.ts";

const SCHEMA = "alchemy_e2e";
const FIXTURES = path.join(REPO_ROOT, "e2e", "fixtures.json");
const TABLES = ["discoveries", "challenge_completions", "challenges", "recipes", "legacy_element_map", "elements", "players", "counters", "meta"];

// ---------------------------------------------------------------- the world

interface SeedElement {
  name: string;
  emoji: string;
  description: string;
  notable?: boolean;
}

const STARTERS: SeedElement[] = [
  { name: "Earth", emoji: STARTER_EMOJI.earth!, description: "Solid ground beneath your feet." },
  { name: "Water", emoji: STARTER_EMOJI.water!, description: "The stuff of rivers, rain and life." },
  { name: "Air", emoji: STARTER_EMOJI.air!, description: "An invisible, ever-moving breath." },
  { name: "Fire", emoji: STARTER_EMOJI.fire!, description: "Heat and light, hungry for fuel." },
  { name: "Time", emoji: STARTER_EMOJI.time!, description: "It changes everything, eventually." },
];

/** [ingredient, ingredient, result] by display name; results are defined in ELEMENTS. */
const PAIRS: [string, string, string][] = [
  // 1 step (only four starter pairs are known: the other eleven stay unknown for the mock AI)
  ["Water", "Fire", "Steam"],
  ["Earth", "Water", "Mud"],
  ["Air", "Fire", "Energy"],
  ["Earth", "Fire", "Lava"],
  // 2 steps
  ["Mud", "Fire", "Brick"],
  ["Lava", "Water", "Stone"],
  ["Steam", "Air", "Cloud"],
  ["Steam", "Earth", "Geyser"],
  ["Energy", "Water", "Storm"],
  ["Mud", "Time", "Clay"],
  ["Energy", "Energy", "Plasma"],
  // 3+ steps
  ["Stone", "Fire", "Metal"],
  ["Clay", "Fire", "Pottery"],
  ["Cloud", "Water", "Rain"],
  ["Cloud", "Energy", "Lightning"],
  ["Metal", "Fire", "Sword"],
  ["Brick", "Stone", "House"],
  ["Metal", "Energy", "Robot"],
  ["Rain", "Earth", "Plant"],
  ["Plant", "Time", "Tree"],
  ["Tree", "Energy", "Apple"],
  ["Apple", "Earth", "Isaac Newton"],
  // a long chain so every rarity tier exists
  ["Isaac Newton", "Earth", "Gravity"],
  ["Gravity", "Energy", "Rocket"],
  ["Rocket", "Time", "Space Station"],
  ["Space Station", "Rocket", "Moon Base"],
  ["Moon Base", "Time", "Colony"],
  ["Colony", "Rocket", "Mars"],
  ["Mars", "Time", "Galaxy"],
];

/** Multi-ingredient recipes (exercise arity 3/4; not in fixtures.recipes, whose helpers combine pairs). */
const MULTI: [string[], string][] = [
  [["Earth", "Water", "Fire"], "Planet"],
  [["Earth", "Water", "Air", "Fire"], "Life"],
];

const ELEMENTS: SeedElement[] = [
  { name: "Steam", emoji: "♨️", description: "Hot water vapor rising in clouds." },
  { name: "Mud", emoji: "🟤", description: "Wet, squelchy earth." },
  { name: "Energy", emoji: "⚡", description: "Raw power crackling through the air." },
  { name: "Lava", emoji: "🌋", description: "Molten rock glowing red-hot." },
  { name: "Brick", emoji: "🧱", description: "Baked mud, ready to build with." },
  { name: "Stone", emoji: "🪨", description: "Cooled lava, hard and patient." },
  { name: "Cloud", emoji: "☁️", description: "Steam drifting high above." },
  { name: "Geyser", emoji: "⛲", description: "Boiling water bursting from the ground." },
  { name: "Storm", emoji: "⛈️", description: "Wind, water and fury." },
  { name: "Clay", emoji: "🏺", description: "Earth that remembers its shape." },
  { name: "Plasma", emoji: "🟣", description: "Matter so energetic it glows." },
  { name: "Metal", emoji: "🔩", description: "Stone refined by fire." },
  { name: "Pottery", emoji: "🍶", description: "Fired clay, shaped by hand." },
  { name: "Rain", emoji: "🌧️", description: "Clouds letting go." },
  { name: "Lightning", emoji: "🌩️", description: "A cloud's electric temper." },
  { name: "Sword", emoji: "⚔️", description: "Metal with an edge." },
  { name: "House", emoji: "🏠", description: "Bricks and stone make a home." },
  { name: "Robot", emoji: "🤖", description: "Metal that moves on its own." },
  { name: "Plant", emoji: "🌱", description: "Life sprouting from wet earth." },
  { name: "Tree", emoji: "🌳", description: "A plant given plenty of time." },
  { name: "Apple", emoji: "🍎", description: "The fruit of a sunny tree." },
  { name: "Isaac Newton", emoji: "🧑‍🔬", description: "Watched an apple fall and wondered why.", notable: true },
  { name: "Gravity", emoji: "🪐", description: "What goes up must come down." },
  { name: "Rocket", emoji: "🚀", description: "Defying gravity with fire." },
  { name: "Space Station", emoji: "🛰️", description: "A home in orbit." },
  { name: "Moon Base", emoji: "🌕", description: "The first step to the stars." },
  { name: "Colony", emoji: "🏙️", description: "A settlement far from home." },
  { name: "Mars", emoji: "🔴", description: "The red planet.", notable: true },
  { name: "Galaxy", emoji: "🌌", description: "Billions of suns in a spiral." },
  { name: "Planet", emoji: "🌎", description: "Earth, water and fire in balance." },
  { name: "Life", emoji: "🧬", description: "Everything at once, alive." },
];

/** Legacy spam kept only so legacy ids map somewhere; never shown or combinable. */
const QUARANTINED = ["timetimetime", "headlights  car  vehicle", "mechamechagolem"];
/** A legacy recipe whose stored result is quarantined: the server must re-roll ("heal") it. */
const HEAL: [string, string, string] = ["Steam", "Time", "timetimetime"];

/** Today's targets (for every day today-3..today+3): 1, 2 and 3 combinations from the starters. */
const TODAY: Record<Tier, string> = { easy: "Energy", hard: "Brick", expert: "Metal" };
/** Legacy history days (offset from today) and their targets. */
const LEGACY_DAYS: [number, Record<Tier, string>][] = [
  [-14, { easy: "Steam", hard: "Cloud", expert: "Rain" }],
  [-13, { easy: "Mud", hard: "Clay", expert: "Pottery" }],
  [-12, { easy: "Lava", hard: "Geyser", expert: "Sword" }],
  [-11, { easy: "Energy", hard: "Storm", expert: "Lightning" }],
  [-10, { easy: "Lava", hard: "Plasma", expert: "Metal" }],
  [-9, { easy: "Steam", hard: "Brick", expert: "Robot" }],
  [-8, { easy: "Mud", hard: "Stone", expert: "House" }],
  [-7, { easy: "Energy", hard: "Cloud", expert: "Plant" }],
  [-6, { easy: "Steam", hard: "Geyser", expert: "Rain" }],
  [-5, { easy: "Lava", hard: "Clay", expert: "Pottery" }],
  [-4, { easy: "Mud", hard: "Storm", expert: "Sword" }],
];
/** Every legacy player completed day -10 easy and day -8 hard (2 completions each). */
const LEGACY_COMPLETIONS: [number, Tier][] = [
  [-10, "easy"],
  [-8, "hard"],
];

const legacyTarget = (off: number, tier: Tier) => LEGACY_DAYS.find(([o]) => o === off)![1][tier];

const LEGACY_USERS = [1, 2, 3, 4, 5].map((i) => `alchemy:00000000-0000-4000-8000-00000000e2e${i}`);
/** Each legacy player is the first discoverer of one element. */
const LEGACY_FIRSTS = ["Clay", "Plasma", "Pottery", "Storm", "Sword"];

/** Fake legacy element ids (18 digits, like 2023 ids) and what they map to. */
const LEGACY_IDS: [string, string, "active" | "alias" | "quarantined", string][] = [
  // [legacy id, legacy name as the 2023 app stored it, disposition, v2 element name]
  ["900000000000000001", "earth", "active", "Earth"],
  ["900000000000000002", "water", "active", "Water"],
  ["900000000000000003", "air", "active", "Air"],
  ["900000000000000004", "fire", "active", "Fire"],
  ["900000000000000005", "time", "active", "Time"],
  ["900000000000000006", "steam", "active", "Steam"],
  ["900000000000000007", "mud", "active", "Mud"],
  ["900000000000000008", "brick", "active", "Brick"],
  ["900000000000000009", "cloud", "active", "Cloud"],
  ["900000000000000010", "stone", "active", "Stone"],
  ["900000000000000011", "steam ", "alias", "Steam"],
  ["900000000000000012", "timetimetime", "quarantined", "timetimetime"],
  ["900000000000000013", "headlights  car  vehicle", "quarantined", "headlights  car  vehicle"],
  ["900000000000000014", "mechamechagolem", "quarantined", "mechamechagolem"],
];
/** In localStorage but unknown to the server (must be skipped, not fail the import). */
const UNKNOWN_LEGACY_ID = "900000000000000099";

// Ids: starters get 18-digit ids, everything else 19 digits, so a string sort of a recipe key
// (the 2023 bug) differs from the required numeric sort, e.g. Mud + Fire.
const starterId = (i: number) => `98000000000000000${i + 1}`;
const elementId = (i: number) => String(1000000000000000101n + BigInt(i));
const quarantinedId = (i: number) => String(1000000000000000901n + BigInt(i));
const recipeId = (i: number) => String(1100000000000000001n + BigInt(i));

// ---------------------------------------------------------------- seeding

interface Row {
  id: string;
  name: string;
  key: string;
  emoji: string | null;
  description: string | null;
  notable: boolean;
  status: "active" | "quarantined";
  starter: boolean;
}

function buildWorld() {
  const rows: Row[] = [
    ...STARTERS.map((e, i) => ({ id: starterId(i), name: e.name, key: nameKey(e.name), emoji: e.emoji, description: e.description, notable: false, status: "active" as const, starter: true })),
    ...ELEMENTS.map((e, i) => ({ id: elementId(i), name: e.name, key: nameKey(e.name), emoji: e.emoji, description: e.description, notable: e.notable ?? false, status: "active" as const, starter: false })),
    ...QUARANTINED.map((raw, i) => ({ id: quarantinedId(i), name: titleCase(nameKey(raw)), key: nameKey(raw), emoji: null, description: null, notable: false, status: "quarantined" as const, starter: false })),
  ];
  const byName = new Map(rows.map((r) => [r.name, r]));
  const byRaw = new Map(QUARANTINED.map((raw, i) => [raw, rows[STARTERS.length + ELEMENTS.length + i]!]));
  const get = (name: string) => {
    const r = byName.get(name) ?? byRaw.get(name);
    if (!r) throw new Error(`seed references unknown element ${name}`);
    return r;
  };
  for (const r of rows) if (r.status === "active" && !checkName(r.name, { notable: r.notable }).ok) throw new Error(`bad seed name ${r.name}`);

  const recipes = [
    ...PAIRS.map(([a, b, res]) => ({ ings: [a, b], result: res, status: "active" as const })),
    ...MULTI.map(([ings, res]) => ({ ings, result: res, status: "active" as const })),
    { ings: [HEAL[0], HEAL[1]], result: HEAL[2], status: "quarantined" as const },
  ].map((r, i) => ({ ...r, id: recipeId(i), ids: sortIds(r.ings.map((n) => get(n).id)), resultId: get(r.result).id }));
  const keys = new Set<string>();
  for (const r of recipes) {
    const k = r.ids.join(",");
    if (keys.has(k)) throw new Error(`duplicate seed recipe ${r.ings.join("+")}`);
    keys.add(k);
  }
  const { depth, steps } = computeDepthSteps(
    rows.filter((r) => r.starter).map((r) => r.id),
    recipes.filter((r) => r.status === "active").map((r) => ({ ingredients: r.ids, result: r.resultId })),
  );
  for (const r of rows) if (r.status === "active" && !depth.value.has(r.id)) throw new Error(`${r.name} is unreachable`);
  return { rows, recipes, get, keys, depth: depth.value, steps: steps.value };
}

/**
 * Pairs nobody has made whose mock answers are distinct new names: starter-only pairs first,
 * then a starter with a 1-step element (tests make those ingredients first).
 */
function unknownCombos(world: ReturnType<typeof buildWorld>): string[][] {
  const starters = STARTERS.map((s) => s.name);
  const pairs: string[][] = [];
  starters.forEach((a, i) => starters.slice(i).forEach((b) => pairs.push([a, b])));
  for (const a of ["Steam", "Mud", "Energy", "Lava"]) for (const b of starters) pairs.push([a, b]);
  const taken = new Set(world.rows.map((r) => r.key));
  taken.add(mockCombine([HEAL[0], HEAL[1]]).key); // the healed recipe's answer
  return pairs.filter((pair) => {
    if (world.keys.has(sortIds(pair.map((n) => world.get(n).id)).join(","))) return false;
    const answer = mockCombine(pair).key;
    if (taken.has(answer)) return false;
    taken.add(answer);
    return true;
  });
}

async function seed() {
  if (process.env.DB_SCHEMA && process.env.DB_SCHEMA !== SCHEMA) {
    throw new Error(`seed-e2e only ever writes ${SCHEMA}; refusing to run with DB_SCHEMA=${process.env.DB_SCHEMA}`);
  }
  const world = buildWorld();
  const today = localDay();
  const pool = createPool(2);
  try {
    await migrate(pool, SCHEMA);
    const c = await pool.connect();
    try {
      await c.query("BEGIN");
      for (const table of TABLES) await c.query(`DELETE FROM ${SCHEMA}.${table}`);

      // players (legacy, pre-created by the "backfill"; never seen in v2 yet)
      const players = (
        await c.query<{ id: string; legacy_user_id: string }>(
          `INSERT INTO ${SCHEMA}.players (legacy_user_id, created_at)
           SELECT u, '2024-02-11T12:00:00Z' FROM unnest($1::STRING[]) AS u RETURNING id, legacy_user_id`,
          [LEGACY_USERS],
        )
      ).rows;
      const playerId = new Map(players.map((p) => [p.legacy_user_id, p.id]));
      const firstBy = new Map(LEGACY_FIRSTS.map((name, i) => [name, playerId.get(LEGACY_USERS[i]!)!]));

      // elements, oldest first so the "recent" feed has a stable order
      const base = Date.now() - world.rows.length * 60_000;
      await c.query(
        `INSERT INTO ${SCHEMA}.elements
           (id, name, name_key, fold_key, emoji, description, notable, status, is_starter, depth, steps, discovered_by, source, legacy_id, enriched_at, created_at)
         SELECT u.id, u.name, u.key, u.fold, u.emoji, u.descr, u.notable, u.status, u.starter, u.depth, u.steps, u.by,
                'seed', NULL,
                CASE WHEN u.status = 'active' THEN now() END, u.created_at
         FROM unnest($1::INT8[], $2::STRING[], $3::STRING[], $4::STRING[], $5::STRING[], $6::STRING[], $7::BOOL[], $8::STRING[],
                     $9::BOOL[], $10::INT4[], $11::INT4[], $12::INT8[], $13::TIMESTAMPTZ[])
           AS u(id, name, key, fold, emoji, descr, notable, status, starter, depth, steps, by, created_at)`,
        [
          world.rows.map((r) => r.id),
          world.rows.map((r) => r.name),
          world.rows.map((r) => r.key),
          world.rows.map((r) => foldKey(r.key)),
          world.rows.map((r) => r.emoji),
          world.rows.map((r) => r.description),
          world.rows.map((r) => r.notable),
          world.rows.map((r) => r.status),
          world.rows.map((r) => r.starter),
          world.rows.map((r) => world.depth.get(r.id) ?? null),
          world.rows.map((r) => world.steps.get(r.id) ?? null),
          world.rows.map((r) => firstBy.get(r.name) ?? null),
          world.rows.map((_, i) => new Date(base + i * 60_000).toISOString()),
        ],
      );

      await c.query(
        `INSERT INTO ${SCHEMA}.recipes (id, ingredient_ids, result_id, arity, status, protected, source)
         SELECT u.id, string_to_array(u.ings, ',')::INT8[], u.result_id, cardinality(string_to_array(u.ings, ','))::INT2, u.status, false, 'legacy'
         FROM unnest($1::INT8[], $2::STRING[], $3::INT8[], $4::STRING[]) AS u(id, ings, result_id, status)`,
        [world.recipes.map((r) => r.id), world.recipes.map((r) => r.ids.join(",")), world.recipes.map((r) => r.resultId), world.recipes.map((r) => r.status)],
      );

      await c.query(
        `INSERT INTO ${SCHEMA}.legacy_element_map (legacy_id, element_id, disposition)
         SELECT * FROM unnest($1::INT8[], $2::INT8[], $3::STRING[])`,
        [LEGACY_IDS.map((l) => l[0]), LEGACY_IDS.map((l) => world.get(l[3]).id), LEGACY_IDS.map((l) => l[2])],
      );

      // challenges: legacy history days + today-3 .. today+3
      const days = [
        ...LEGACY_DAYS.map(([off, t]) => ({ day: addDays(today, off), t, source: "legacy", generator: null })),
        ...[-3, -2, -1, 0, 1, 2, 3].map((off) => ({ day: addDays(today, off), t: TODAY, source: "generated", generator: "seed-e2e" })),
      ];
      const tierCol = (tier: Tier, f: (r: Row) => string | number | null) => days.map((d) => f(world.get(d.t[tier])));
      await c.query(
        `INSERT INTO ${SCHEMA}.challenges (day, easy_id, hard_id, expert_id, easy_steps, hard_steps, expert_steps, source, generator)
         SELECT * FROM unnest($1::DATE[], $2::INT8[], $3::INT8[], $4::INT8[], $5::INT4[], $6::INT4[], $7::INT4[], $8::STRING[], $9::STRING[])`,
        [
          days.map((d) => d.day),
          tierCol("easy", (r) => r.id),
          tierCol("hard", (r) => r.id),
          tierCol("expert", (r) => r.id),
          tierCol("easy", (r) => world.steps.get(r.id) ?? null),
          tierCol("hard", (r) => world.steps.get(r.id) ?? null),
          tierCol("expert", (r) => world.steps.get(r.id) ?? null),
          days.map((d) => d.source),
          days.map((d) => d.generator),
        ],
      );

      // legacy completions + the discoveries the backfill would have created (completed targets
      // and first discoveries; starters are added lazily on adoption)
      const completions = LEGACY_USERS.flatMap((u) => LEGACY_COMPLETIONS.map(([off, tier]) => ({ p: playerId.get(u)!, day: addDays(today, off), tier, off })));
      await c.query(
        `INSERT INTO ${SCHEMA}.challenge_completions (player_id, day, tier, completed_at, source)
         SELECT u.p, u.day, u.tier, (u.day::STRING || 'T12:00:00Z')::TIMESTAMPTZ, 'legacy'
         FROM unnest($1::INT8[], $2::DATE[], $3::STRING[]) AS u(p, day, tier)`,
        [completions.map((x) => x.p), completions.map((x) => x.day), completions.map((x) => x.tier)],
      );
      const disc = LEGACY_USERS.flatMap((u, i) => [
        ...LEGACY_COMPLETIONS.map(([off, tier]) => ({ p: playerId.get(u)!, e: world.get(legacyTarget(off, tier)).id })),
        { p: playerId.get(u)!, e: world.get(LEGACY_FIRSTS[i]!).id },
      ]);
      await c.query(
        `INSERT INTO ${SCHEMA}.discoveries (player_id, element_id, discovered_at, source)
         SELECT u.p, u.e, '2024-06-01T12:00:00Z', 'legacy' FROM unnest($1::INT8[], $2::INT8[]) AS u(p, e)
         ON CONFLICT DO NOTHING`,
        [disc.map((d) => d.p), disc.map((d) => d.e)],
      );
      await c.query("COMMIT");
    } catch (e) {
      await c.query("ROLLBACK").catch(() => {});
      throw e;
    } finally {
      c.release();
    }

    // ---------------------------------------------------------------- fixtures.json
    const pairRecipes = PAIRS.map(([a, b, result]) => ({ ingredients: [a, b], result }));
    const starterNames = new Set(STARTERS.map((s) => s.name));
    const legacyElement = (legacyId: string, rawName: string, starter: boolean) => ({
      id: legacyId,
      name: rawName,
      imgUrl: `https://i.imgur.com/e2e${legacyId.slice(-4)}.png`,
      starterElement: starter,
      createdAt: "2023-05-20T18:00:00.000Z",
      createdUserId: "",
      valid: true,
    });
    const fixtures = {
      schema: SCHEMA,
      generatedAt: new Date().toISOString(),
      today,
      starters: STARTERS.map((s) => s.name),
      elements: world.rows.map((r) => ({
        id: r.id,
        name: r.name,
        emoji: r.emoji,
        status: r.status,
        starter: r.starter,
        notable: r.notable,
        depth: world.depth.get(r.id) ?? null,
        steps: world.steps.get(r.id) ?? null,
      })),
      recipes: pairRecipes,
      multiRecipes: MULTI.map(([ingredients, result]) => ({ ingredients, result })),
      /** Known recipe whose stored result is quarantined: combining it must re-roll (mock AI). */
      healCombo: { ingredients: [HEAL[0], HEAL[1]], quarantinedResult: titleCase(nameKey(HEAL[2])) },
      unknownCombos: unknownCombos(world),
      challenge: {
        days: [-3, -2, -1, 0, 1, 2, 3].map((off) => addDays(today, off)),
        ...TODAY,
        steps: { easy: world.steps.get(world.get(TODAY.easy).id), hard: world.steps.get(world.get(TODAY.hard).id), expert: world.steps.get(world.get(TODAY.expert).id) },
        easyPath: [pairRecipes.find((r) => r.result === TODAY.easy)!],
      },
      legacyDays: LEGACY_DAYS.map(([off, t]) => ({ day: addDays(today, off), ...t })),
      legacyMap: LEGACY_IDS.map(([legacyId, rawName, disposition, target]) => ({ legacyId, rawName, disposition, elementId: world.get(target).id })),
      unknownLegacyId: UNKNOWN_LEGACY_ID,
      legacyUsers: LEGACY_USERS.map((userId, i) => {
        const first = LEGACY_FIRSTS[i]!;
        const completedTargets = LEGACY_COMPLETIONS.map(([off, tier]) => legacyTarget(off, tier));
        return {
          userId,
          playerId: null as string | null,
          elements: [
            ...LEGACY_IDS.map(([id, raw, , target]) => legacyElement(id, raw, starterNames.has(target))),
            legacyElement(UNKNOWN_LEGACY_ID, "forgotten thing", false),
          ],
          expectPresent: [...new Set([...STARTERS.map((s) => s.name), "Steam", "Mud", "Brick", "Cloud", "Stone", ...completedTargets, first])],
          expectAbsent: QUARANTINED.map((raw) => titleCase(nameKey(raw))),
          firstDiscovery: first,
          history: LEGACY_COMPLETIONS.map(([off, tier]) => ({ day: addDays(today, off), completed: [tier] })),
        };
      }),
    };
    const ids = await pool.query<{ id: string; legacy_user_id: string }>(`SELECT id, legacy_user_id FROM ${SCHEMA}.players`);
    for (const u of fixtures.legacyUsers) u.playerId = ids.rows.find((r) => r.legacy_user_id === u.userId)?.id ?? null;
    fs.writeFileSync(FIXTURES, `${JSON.stringify(fixtures, null, 2)}\n`);
    const active = world.rows.filter((r) => r.status === "active").length;
    console.log(
      `[${SCHEMA}] seeded ${active} active + ${QUARANTINED.length} quarantined elements, ${world.recipes.length} recipes, ` +
        `${LEGACY_DAYS.length + 7} challenge days, ${LEGACY_USERS.length} legacy players, ${fixtures.unknownCombos.length} unknown combos; wrote ${path.relative(REPO_ROOT, FIXTURES)}`,
    );
  } finally {
    await pool.end();
  }
}

if (isMain(import.meta.url)) runMain(seed);
