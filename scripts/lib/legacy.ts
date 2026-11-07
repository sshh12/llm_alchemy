// Legacy (2023-2026) data access and the pure legacy -> v2 transformation used by
// scripts/backfill-legacy.ts. Legacy tables public."Alchemy*" are only ever read, with
// AS OF SYSTEM TIME so the reads never contend with anything else.
import type pg from "pg";
import { MAX_INGREDIENTS, MIN_INGREDIENTS, type Tier } from "../../src/shared/api.ts";
import { CHALLENGE_CUTOVER_DAY } from "../../src/shared/dates.ts";
import { checkName, foldKey, nameKey, titleCase } from "../../src/shared/names.ts";
import { computeDepthSteps, derivationClosure, sortIds, type GraphRecipe } from "./graph.ts";

/**
 * Valid legacy user ids: 'alchemy:' + lowercase UUID, or a bare UUID for the earliest
 * players (the app added the prefix on 2023-05-23; existing players kept their bare id).
 * Everything else is junk.
 */
export const LEGACY_USER_RE = /^(?:alchemy:)?[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export const STARTER_EMOJI: Record<string, string> = { earth: "🌍", water: "💧", air: "💨", fire: "🔥", time: "⏳" };

const UNIQUE_ROWID_EPOCH_MS = Date.UTC(2015, 0, 1);

/** Creation time encoded in a CockroachDB unique_rowid(): (10µs ticks since 2015-01-01) << 15 | node. */
export function uniqueRowidTime(id: string): Date {
  return new Date(UNIQUE_ROWID_EPOCH_MS + Number((BigInt(id) >> 15n) / 100n));
}

/** Legacy recipe names are 'recipe:<id>,<id>,...' (string-sorted multiset). */
export function parseRecipeName(name: string): string[] | null {
  const m = /^recipe:(\d+(?:,\d+)*)$/.exec(name);
  return m ? m[1]!.split(",") : null;
}

/** Noon UTC of a challenge day: the completion time recorded for legacy completions. */
export const dayNoon = (day: string) => new Date(`${day}T12:00:00Z`);

// ------------------------------------------------------------------ reading

export interface LegacyElement {
  id: string;
  name: string;
  starter: boolean;
  createdAt: Date;
  creator: string;
}
export interface LegacyRecipe {
  id: string;
  name: string;
  resultId: string;
  createdAt: Date;
}
export interface LegacyChallenge {
  day: string;
  easy: string;
  hard: string;
  expert: string;
}
export interface LegacyCompletion {
  userId: string;
  day: string;
  easy: boolean;
  hard: boolean;
  expert: boolean;
}
export interface LegacyCredit {
  id: string;
  userId: string;
}
export interface LegacySnapshot {
  asOf: string;
  elements: LegacyElement[];
  recipes: LegacyRecipe[];
  challenges: LegacyChallenge[];
  completions: LegacyCompletion[];
  credits: LegacyCredit[];
}

async function readPaged<R extends { id: string }>(
  pool: pg.Pool,
  sqlFor: (limit: number) => string,
  pageSize: number,
): Promise<R[]> {
  // Keyset paging on the INT8 id. Select `id` uncast (pg already returns INT8 as a string):
  // an `id::STRING AS id` alias would make ORDER BY sort lexicographically and skip rows.
  const out: R[] = [];
  let after = "0";
  for (;;) {
    const { rows } = await pool.query<R>(sqlFor(pageSize), [after]);
    out.push(...rows);
    if (rows.length < pageSize) return out;
    after = rows[rows.length - 1]!.id;
  }
}

/** Read every legacy table needed by the backfill at one consistent follower-read snapshot. */
export async function readLegacy(pool: pg.Pool, log: (msg: string) => void = console.log): Promise<LegacySnapshot> {
  // Pin one snapshot (a decimal HLC timestamp) so all tables are read at the same instant.
  const { rows } = await pool.query<{ ts: string }>(
    `SELECT (extract(epoch FROM follower_read_timestamp())::DECIMAL * 1000000000)::INT8::STRING AS ts`,
  );
  const asOf = rows[0]!.ts;
  if (!/^\d+$/.test(asOf)) throw new Error(`unexpected snapshot ${asOf}`);
  const aost = `AS OF SYSTEM TIME '${asOf}'`;
  const t0 = performance.now();
  const lap = (what: string, n: number) => log(`  read ${what}: ${n.toLocaleString("en-US")} rows (${((performance.now() - t0) / 1000).toFixed(1)}s)`);

  const elements = (
    await readPaged<{ id: string; name: string; starter: boolean; created_at: Date; creator: string }>(
      pool,
      (n) => `SELECT id, name, "starterElement" AS starter, "createdAt" AS created_at, "createdUserId" AS creator
              FROM "AlchemyElement" ${aost} WHERE id > $1::INT8 ORDER BY id LIMIT ${n}`,
      20_000,
    )
  ).map((r) => ({ id: r.id, name: r.name, starter: r.starter, createdAt: r.created_at, creator: r.creator }));
  lap("AlchemyElement", elements.length);

  const recipes = (
    await readPaged<{ id: string; name: string; result_id: string; created_at: Date }>(
      pool,
      (n) => `SELECT id, name, "resultElementId"::STRING AS result_id, "createdAt" AS created_at
              FROM "AlchemyRecipe" ${aost} WHERE id > $1::INT8 ORDER BY id LIMIT ${n}`,
      50_000,
    )
  ).map((r) => ({ id: r.id, name: r.name, resultId: r.result_id, createdAt: r.created_at }));
  lap("AlchemyRecipe", recipes.length);

  const challenges = (
    await pool.query<{ day: string; easy: string; hard: string; expert: string }>(
      `SELECT date AS day, "elementEasyId"::STRING AS easy, "elementHardId"::STRING AS hard, "elementExpertId"::STRING AS expert
       FROM "AlchemyDailyChallenge" ${aost} ORDER BY date`,
    )
  ).rows;
  lap("AlchemyDailyChallenge", challenges.length);

  // OR-merge duplicate (user, day) rows server-side; visit-only rows are skipped.
  const completions = (
    await pool.query<LegacyCompletion>(
      `SELECT c."userId" AS "userId", ch.date AS day,
              bool_or(d."completedEasy") AS easy, bool_or(d."completedHard") AS hard, bool_or(d."completedExpert") AS expert
       FROM "AlchemyDailyChallengeOnCredits" AS d
         JOIN "AlchemyCredits" AS c ON c.id = d."creditsId"
         JOIN "AlchemyDailyChallenge" AS ch ON ch.id = d."challengeId"
       ${aost}
       WHERE d."completedEasy" OR d."completedHard" OR d."completedExpert"
       GROUP BY 1, 2`,
    )
  ).rows;
  lap("AlchemyDailyChallengeOnCredits (completions)", completions.length);

  // Only id + userId: credits balances and emails are deliberately not read.
  const credits = await readPaged<LegacyCredit>(
    pool,
    (n) => `SELECT id, "userId" AS "userId" FROM "AlchemyCredits" ${aost} WHERE id > $1::INT8 ORDER BY id LIMIT ${n}`,
    50_000,
  );
  lap("AlchemyCredits", credits.length);

  return { asOf, elements, recipes, challenges, completions, credits };
}

// ------------------------------------------------------------------ transformation

export type Status = "active" | "quarantined";

export interface PlanElement {
  id: string;
  name: string;
  nameKey: string;
  foldKey: string;
  status: Status;
  isStarter: boolean;
  emoji: string | null;
  createdAt: Date;
  /** Valid legacy user id of the creator (becomes discovered_by). */
  creator: string | null;
}
export interface PlanMapRow {
  legacyId: string;
  elementId: string;
  disposition: Status | "alias";
}
export interface PlanRecipe {
  id: string;
  ingredientIds: string[];
  resultId: string;
  status: Status;
  protected: boolean;
  createdAt: Date;
}
export interface PlanPlayer {
  legacyUserId: string;
  createdAt: Date;
}
export interface PlanDiscovery {
  legacyUserId: string;
  elementId: string;
  discoveredAt: Date;
}
export interface PlanCompletion {
  legacyUserId: string;
  day: string;
  tier: Tier;
}
export interface PlanChallenge {
  day: string;
  ids: Record<Tier, string>;
  steps: Record<Tier, number | null>;
}
export interface Plan {
  elements: PlanElement[];
  map: PlanMapRow[];
  recipes: PlanRecipe[];
  depth: Map<string, number>;
  steps: Map<string, number>;
  players: PlanPlayer[];
  discoveries: PlanDiscovery[];
  completions: PlanCompletion[];
  challenges: PlanChallenge[];
  /** Counts for every inclusion/exclusion bucket (printed and stored in meta). */
  stats: Record<string, number>;
}

const TIERS: Tier[] = ["easy", "hard", "expert"];
const cmpId = (a: string, b: string) => {
  const x = BigInt(a);
  const y = BigInt(b);
  return x < y ? -1 : x > y ? 1 : 0;
};

/**
 * Turn a legacy snapshot into v2 rows. Pure and deterministic.
 *
 * Elements: grouped by nameKey (whitespace twins share a key). A group is active if any member
 * is a starter, protected, or passes checkName(); its canonical row (starter > protected >
 * checkName-ok > clean raw name > oldest id) keeps its legacy id as the v2 id, the rest alias it;
 * the row's date and discoverer come from the group's earliest spelling.
 * Protected = targets of legacy challenge days before the cutover, plus (only for targets that
 * would otherwise be unreachable) the elements on their shortest derivation in the full graph.
 */
export function buildPlan(snap: LegacySnapshot): Plan {
  const stats: Record<string, number> = {};
  const bump = (k: string, n = 1) => {
    stats[k] = (stats[k] ?? 0) + n;
  };

  // ---- element groups
  const byId = new Map(snap.elements.map((e) => [e.id, e]));
  const keyOf = new Map<string, string>();
  const nameOk = new Set<string>();
  const groups = new Map<string, LegacyElement[]>();
  for (const e of snap.elements) {
    // An empty key can't be a real identity; give it a sentinel no real key can equal.
    const key = nameKey(e.name) || `~legacy:${e.id}`;
    keyOf.set(e.id, key);
    if (checkName(e.name).ok) nameOk.add(e.id);
    const g = groups.get(key);
    if (g) g.push(e);
    else groups.set(key, [e]);
  }
  const starters = snap.elements.filter((e) => e.starter);
  const unexpected = starters.map((s) => keyOf.get(s.id)!).filter((k) => !(k in STARTER_EMOJI));
  if (starters.length !== 5 || unexpected.length) throw new Error(`unexpected legacy starters: ${starters.map((s) => s.name).join(", ")}`);

  const pastChallenges = snap.challenges.filter((c) => c.day < CHALLENGE_CUTOVER_DAY);
  const targetLegacyIds = new Set<string>();
  for (const c of pastChallenges) for (const t of TIERS) if (byId.has(c[t])) targetLegacyIds.add(c[t]);

  const parsed = snap.recipes.map((r) => ({ r, tokens: parseRecipeName(r.name) }));

  const resolve = (protectedIds: ReadonlySet<string>) => {
    const canonOf = new Map<string, string>();
    const status = new Map<string, Status>();
    const qualifies = (e: LegacyElement) => e.starter || protectedIds.has(e.id) || nameOk.has(e.id);
    const clean = (e: LegacyElement) => e.name === e.name.trim() && !/\s{2,}/.test(e.name);
    for (const members of groups.values()) {
      const rank = (e: LegacyElement) => [e.starter, protectedIds.has(e.id), nameOk.has(e.id), clean(e)].map((b) => (b ? 0 : 1));
      const canon = [...members].sort((a, b) => {
        const ra = rank(a);
        const rb = rank(b);
        for (let i = 0; i < ra.length; i++) if (ra[i] !== rb[i]) return ra[i]! - rb[i]!;
        return cmpId(a.id, b.id);
      })[0]!;
      status.set(canon.id, members.some(qualifies) ? "active" : "quarantined");
      for (const m of members) canonOf.set(m.id, canon.id);
    }
    return { canonOf, status };
  };

  /** Map, filter and de-collide legacy recipes; `buckets` counts every exclusion. */
  const buildRecipes = (
    canonOf: ReadonlyMap<string, string>,
    status: ReadonlyMap<string, Status> | null,
    protectedCanon: ReadonlySet<string>,
  ) => {
    const buckets: Record<string, number> = {};
    const count = (k: string) => {
      buckets[k] = (buckets[k] ?? 0) + 1;
    };
    const byKey = new Map<string, { id: string; ingredientIds: string[]; resultId: string; createdAt: Date }>();
    for (const { r, tokens } of parsed) {
      if (!tokens) {
        count("recipes.dropped.unparseable");
        continue;
      }
      if (tokens.length < MIN_INGREDIENTS) {
        count("recipes.dropped.arity_below_2");
        continue;
      }
      if (tokens.length > MAX_INGREDIENTS) {
        count("recipes.dropped.arity_above_4");
        continue;
      }
      const ings = tokens.map((t) => canonOf.get(t));
      const resultId = canonOf.get(r.resultId);
      if (ings.some((x) => x === undefined)) {
        count("recipes.dropped.purged_ingredient");
        continue;
      }
      if (resultId === undefined) {
        count("recipes.dropped.purged_result");
        continue;
      }
      if (status && ings.some((x) => status.get(x!) !== "active")) {
        count("recipes.dropped.quarantined_ingredient");
        continue;
      }
      const ingredientIds = sortIds(ings as string[]);
      const key = ingredientIds.join(",");
      const cand = { id: r.id, ingredientIds, resultId, createdAt: r.createdAt };
      const prev = byKey.get(key);
      if (!prev) {
        byKey.set(key, cand);
        continue;
      }
      // Collision after aliasing: protected result first, then the oldest legacy recipe.
      const score = (x: typeof cand) => (protectedCanon.has(x.resultId) ? 0 : 1);
      const winner = score(cand) < score(prev) || (score(cand) === score(prev) && cmpId(cand.id, prev.id) < 0) ? cand : prev;
      const loser = winner === cand ? prev : cand;
      count(loser.resultId === winner.resultId ? "recipes.dropped.collision_same_result" : "recipes.dropped.collision_other_result");
      byKey.set(key, winner);
    }
    return { recipes: [...byKey.values()], buckets };
  };
  type BuiltRecipe = ReturnType<typeof buildRecipes>["recipes"][number];

  const starterIds = starters.map((s) => s.id);
  const activeGraph = (recipes: BuiltRecipe[], status: ReadonlyMap<string, Status>): GraphRecipe[] =>
    recipes.filter((r) => status.get(r.resultId) === "active").map((r) => ({ ingredients: r.ingredientIds, result: r.resultId }));

  // ---- pass 1 protects the targets; later passes also protect the shortest derivation (in the
  // unfiltered graph) of any target that is unreachable through active elements alone.
  const protectedIds = new Set(targetLegacyIds);
  const build = () => {
    const r = resolve(protectedIds);
    const protectedCanon = new Set([...protectedIds].map((id) => r.canonOf.get(id)!));
    const canonTargets = new Set([...targetLegacyIds].map((id) => r.canonOf.get(id)!));
    return { ...r, canonTargets, ...buildRecipes(r.canonOf, r.status, protectedCanon) };
  };
  let built = build();
  for (let pass = 0; pass < 4; pass++) {
    const { steps } = computeDepthSteps(starterIds, activeGraph(built.recipes, built.status));
    const unreachable = [...built.canonTargets].filter((t) => !steps.value.has(t));
    if (unreachable.length === 0) break;
    const full = buildRecipes(built.canonOf, null, built.canonTargets).recipes.map((r) => ({
      ingredients: r.ingredientIds,
      result: r.resultId,
    }));
    const closure = derivationClosure(unreachable, full, computeDepthSteps(starterIds, full).steps);
    const before = protectedIds.size;
    for (const e of closure.elements) if (built.status.get(e) !== "active") protectedIds.add(e);
    if (protectedIds.size === before) break; // unreachable even in the full graph
    built = build();
  }
  const { canonOf, status, canonTargets, recipes } = built;
  Object.assign(stats, built.buckets);
  stats["elements.protected.targets"] = targetLegacyIds.size;
  stats["elements.protected.path_additions"] = protectedIds.size - targetLegacyIds.size;

  // ---- depth / steps over active recipes; protected recipes = derivations of the targets
  const graph = activeGraph(recipes, status);
  const { depth, steps } = computeDepthSteps(starterIds, graph);
  const activeRecipes = recipes.filter((r) => status.get(r.resultId) === "active");
  const protectedRecipeIdx = derivationClosure(canonTargets, graph, steps).recipes;
  const protectedRecipeIds = new Set([...protectedRecipeIdx].map((i) => activeRecipes[i]!.id));
  stats["challenges.targets_unreachable"] = [...canonTargets].filter((t) => !steps.value.has(t)).length;

  const planRecipes: PlanRecipe[] = recipes
    .map((r) => {
      const active = status.get(r.resultId) === "active";
      bump(active ? "recipes.kept.active" : "recipes.kept.quarantined_result");
      return {
        id: r.id,
        ingredientIds: r.ingredientIds,
        resultId: r.resultId,
        status: (active ? "active" : "quarantined") as Status,
        protected: protectedRecipeIds.has(r.id),
        createdAt: r.createdAt,
      };
    })
    .sort((a, b) => cmpId(a.id, b.id));
  stats["recipes.protected"] = protectedRecipeIds.size;

  // ---- element rows + id map. The canonical spelling gives the id and name; the date and the
  // first-discovery credit come from the EARLIEST spelling of the group (createdAt, then id), so
  // a later whitespace twin never takes a first away. An anonymous earliest spelling means no credit.
  const elements: PlanElement[] = [];
  const map: PlanMapRow[] = [];
  const earliestOf = (key: string) =>
    groups.get(key)!.reduce((a, b) => (b.createdAt < a.createdAt || (+b.createdAt === +a.createdAt && cmpId(b.id, a.id) < 0) ? b : a));
  for (const e of snap.elements) {
    const canon = canonOf.get(e.id)!;
    const st = status.get(canon)!;
    if (canon === e.id) {
      const key = keyOf.get(e.id)!;
      const real = !key.startsWith("~");
      const first = earliestOf(key);
      elements.push({
        id: e.id,
        name: real ? titleCase(key) : e.name,
        nameKey: key,
        foldKey: real ? foldKey(key) : key,
        status: st,
        isStarter: e.starter,
        emoji: e.starter ? STARTER_EMOJI[key]! : null,
        createdAt: first.createdAt,
        creator: LEGACY_USER_RE.test(first.creator) ? first.creator : null,
      });
      map.push({ legacyId: e.id, elementId: e.id, disposition: st });
      bump(`elements.${st}`);
    } else {
      map.push({ legacyId: e.id, elementId: canon, disposition: "alias" });
      bump(st === "active" ? "elements.alias_to_active" : "elements.alias_to_quarantined");
    }
    if (!nameOk.has(e.id) && st === "active" && canon === e.id && !e.starter) bump("elements.active_by_protection");
  }
  elements.sort((a, b) => cmpId(a.id, b.id));
  map.sort((a, b) => cmpId(a.legacyId, b.legacyId));
  stats["elements.active.reachable"] = elements.filter((e) => e.status === "active" && depth.value.has(e.id)).length;

  // ---- players: valid ids from credits ∪ element creators (completion owners ⊂ credits).
  // created_at = the earlier of the credits row and the first element they made: the earliest
  // (bare-uuid) players got their credits row long after they started (some only in 2026-10).
  const playerCreated = new Map<string, Date>();
  for (const c of snap.credits) {
    if (!LEGACY_USER_RE.test(c.userId)) {
      bump("players.skipped.junk_credit_user");
      continue;
    }
    const at = uniqueRowidTime(c.id);
    const prev = playerCreated.get(c.userId);
    if (!prev || at < prev) playerCreated.set(c.userId, at);
  }
  stats["players.from_credits"] = playerCreated.size;
  const fromCredits = new Set(playerCreated.keys());
  const creatorOnly = new Set<string>();
  for (const e of snap.elements) {
    if (!e.creator) continue;
    if (!LEGACY_USER_RE.test(e.creator)) {
      bump("elements.creator_junk");
      continue;
    }
    if (!fromCredits.has(e.creator)) creatorOnly.add(e.creator);
    const prev = playerCreated.get(e.creator);
    if (!prev || e.createdAt < prev) playerCreated.set(e.creator, e.createdAt);
  }
  stats["players.creators_without_credits"] = creatorOnly.size;
  const players = [...playerCreated.entries()]
    .map(([legacyUserId, createdAt]) => ({ legacyUserId, createdAt }))
    .sort((a, b) => (a.legacyUserId < b.legacyUserId ? -1 : 1));

  // ---- challenges (days before the cutover; later legacy days are regenerated)
  const challenges: PlanChallenge[] = [];
  const challengeByDay = new Map<string, PlanChallenge>();
  stats["challenges.legacy_days_after_cutover_dropped"] = snap.challenges.length - pastChallenges.length;
  for (const c of pastChallenges) {
    const ids = {} as Record<Tier, string>;
    const st = {} as Record<Tier, number | null>;
    let ok = true;
    for (const t of TIERS) {
      const id = canonOf.get(c[t]);
      if (!id) ok = false;
      else {
        ids[t] = id;
        st[t] = steps.value.get(id) ?? null;
      }
    }
    if (!ok) {
      bump("challenges.dropped.missing_target");
      continue;
    }
    const row = { day: c.day, ids, steps: st };
    challenges.push(row);
    challengeByDay.set(c.day, row);
  }

  // ---- completions: one row per completed tier
  const completions: PlanCompletion[] = [];
  for (const c of snap.completions) {
    if (!LEGACY_USER_RE.test(c.userId)) {
      bump("completions.dropped.junk_user");
      continue;
    }
    if (!challengeByDay.has(c.day)) {
      bump(c.day >= CHALLENGE_CUTOVER_DAY ? "completions.dropped.on_or_after_cutover" : "completions.dropped.no_challenge");
      continue;
    }
    for (const t of TIERS) {
      if (!c[t]) continue;
      completions.push({ legacyUserId: c.userId, day: c.day, tier: t });
      bump(`completions.${t}`);
    }
  }

  // ---- discoveries: active non-starter elements a player created first + completed targets
  const disc = new Map<string, PlanDiscovery>();
  const addDiscovery = (legacyUserId: string, elementId: string, at: Date, bucket: string) => {
    const el = status.get(elementId);
    if (el !== "active" || starterIds.includes(elementId)) return;
    const k = `${legacyUserId} ${elementId}`;
    const prev = disc.get(k);
    if (!prev) bump(bucket);
    if (!prev || at < prev.discoveredAt) disc.set(k, { legacyUserId, elementId, discoveredAt: at });
  };
  for (const e of snap.elements) {
    if (LEGACY_USER_RE.test(e.creator)) addDiscovery(e.creator, canonOf.get(e.id)!, e.createdAt, "discoveries.from_creations");
  }
  for (const c of completions) {
    addDiscovery(c.legacyUserId, challengeByDay.get(c.day)!.ids[c.tier], dayNoon(c.day), "discoveries.from_challenges_only");
  }
  const discoveries = [...disc.values()];

  return { elements, map, recipes: planRecipes, depth: depth.value, steps: steps.value, players, discoveries, completions, challenges, stats };
}
