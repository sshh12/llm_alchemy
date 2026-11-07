// Idempotent repairs of rows the legacy backfill and the first v2 days already wrote, for bugs
// fixed since (each step's comment says which). A fresh backfill gets these right by itself;
// this brings an existing schema to the same state. Every step only lowers a date or replaces a
// value it can prove came from the old code, so a re-run is a no-op.
//
//   npm run db:repair-legacy                                   # dry run: count what each step would change
//   npm run db:repair-legacy -- --run                          # write
//   npm run db:repair-legacy -- --run --steps twin-credit,import-dates
//   --schema <name>                                            # default: DB_SCHEMA, else "alchemy"
//
// Steps (default: all, in this order; players-created-at must precede starter-dates):
//   players-created-at  lower players.created_at to the first legacy element the player made (the
//                       earliest bare-uuid players were dated by a much later credits row)
//   starter-dates       starter rows of legacy players were stamped at adoption (now()); date them
//                       at the player's creation
//   import-dates        library rows imported by bootstrap before the fix were stamped now(); date
//                       them like importLegacy does now (rows on or after the v2 cutover only)
//   twin-credit         a whitespace-twin group takes its date and first-discovery credit from its
//                       EARLIEST spelling, not the canonical one. Credit is replaced only where it
//                       still equals the canonical spelling's creator (what the backfill wrote)
//   image-unblock       one retry for art blocked by name before the generic fallback hint existed
//                       (no art_hint, no description); each element at most once (meta
//                       'repair:image-unblock'). Run it only once the fallback is deployed.
//
// Legacy tables public."Alchemy*" are only read, at a follower-read snapshot.
import "./lib/env.ts";
import { parseArgs } from "node:util";
import type pg from "pg";
import { CHALLENGE_CUTOVER_DAY } from "../src/shared/dates.ts";
import { isMain, printTable, runMain } from "./lib/cli.ts";
import { chunk, createPool, fmt, resolveSchema, retrying } from "./lib/db.ts";
import { LEGACY_USER_RE } from "./lib/legacy.ts";

const BATCH = 5_000;
const AOST = "AS OF SYSTEM TIME follower_read_timestamp()";
const UNBLOCK_META = "repair:image-unblock";
export const STEPS = ["players-created-at", "starter-dates", "import-dates", "twin-credit", "image-unblock"] as const;
type Step = (typeof STEPS)[number];

interface Ctx {
  pool: pg.Pool;
  S: string;
  run: boolean;
}
interface Outcome {
  step: Step;
  what: string;
  planned: number;
  written: number | null;
}

const cmpLegacy = (a: { at: Date; id: string }, b: { at: Date; id: string }) =>
  a.at.getTime() - b.at.getTime() || (BigInt(a.id) < BigInt(b.id) ? -1 : BigInt(a.id) > BigInt(b.id) ? 1 : 0);

/** Run `sql` over `rows` in batches (each statement guarded, so re-running is safe); returns rows changed. */
async function batched<T>(ctx: Ctx, label: string, rows: T[], sql: string, params: (b: T[]) => unknown[]): Promise<number> {
  let n = 0;
  for (const b of chunk(rows, BATCH)) n += (await retrying(label, () => ctx.pool.query(sql, params(b)))).rowCount ?? 0;
  return n;
}

async function playersCreatedAt(ctx: Ctx): Promise<Outcome[]> {
  const { pool, S } = ctx;
  const first = (
    await pool.query<{ u: string; at: Date }>(
      `SELECT "createdUserId" AS u, min("createdAt") AS at FROM public."AlchemyElement" ${AOST}
        WHERE "createdUserId" <> '' GROUP BY 1`,
    )
  ).rows.filter((r) => LEGACY_USER_RE.test(r.u));
  const stale = (
    await pool.query<{ uid: string }>(
      `SELECT p.legacy_user_id AS uid FROM ${S}.players p, unnest($1::STRING[], $2::TIMESTAMPTZ[]) AS u(uid, at)
        WHERE p.legacy_user_id = u.uid AND p.created_at > u.at`,
      [first.map((r) => r.u), first.map((r) => r.at.toISOString())],
    )
  ).rows;
  const wanted = new Set(stale.map((r) => r.uid));
  const rows = first.filter((r) => wanted.has(r.u));
  const written = ctx.run
    ? await batched(
        ctx,
        "players.created_at",
        rows,
        `UPDATE ${S}.players AS p SET created_at = u.at
           FROM unnest($1::STRING[], $2::TIMESTAMPTZ[]) AS u(uid, at)
          WHERE p.legacy_user_id = u.uid AND p.created_at > u.at`,
        (b) => [b.map((r) => r.u), b.map((r) => r.at.toISOString())],
      )
    : null;
  return [{ step: "players-created-at", what: "players.created_at lowered to their first element", planned: rows.length, written }];
}

async function starterDates(ctx: Ctx): Promise<Outcome[]> {
  // Selected first, then updated by key (see importDates).
  const rows = (
    await ctx.pool.query<{ p: string; e: string; at: Date }>(
      `SELECT d.player_id AS p, d.element_id AS e, p.created_at AS at
         FROM ${ctx.S}.discoveries d JOIN ${ctx.S}.players p ON p.id = d.player_id
        WHERE p.legacy_user_id IS NOT NULL AND d.source = 'starter' AND d.discovered_at > p.created_at`,
    )
  ).rows;
  const written = ctx.run
    ? await batched(
        ctx,
        "starter-dates",
        rows,
        `UPDATE ${ctx.S}.discoveries AS d SET discovered_at = u.at
           FROM unnest($1::INT8[], $2::INT8[], $3::TIMESTAMPTZ[]) AS u(p, e, at)
          WHERE d.player_id = u.p AND d.element_id = u.e AND d.source = 'starter' AND d.discovered_at > u.at`,
        (b) => [b.map((r) => r.p), b.map((r) => r.e), b.map((r) => r.at.toISOString())],
      )
    : null;
  return [{ step: "starter-dates", what: "legacy players' starter rows dated at creation", planned: rows.length, written }];
}

async function importDates(ctx: Ctx): Promise<Outcome[]> {
  // Same date as server/game/players.ts importLegacy; only lowers, only rows written since v2 went
  // live. The rows are selected first and then updated by key: an UPDATE ... FROM over players and
  // elements makes CockroachDB plan a cross join of both tables.
  const rows = (
    await ctx.pool.query<{ p: string; e: string; at: Date; cur: Date }>(
      `SELECT d.player_id AS p, d.element_id AS e, d.discovered_at AS cur,
              CASE WHEN p.legacy_user_id IS NOT NULL THEN GREATEST(p.created_at, e.created_at) ELSE e.created_at END AS at
         FROM ${ctx.S}.discoveries d
         JOIN ${ctx.S}.players p ON p.id = d.player_id
         JOIN ${ctx.S}.elements e ON e.id = d.element_id
        WHERE d.source = 'legacy' AND d.discovered_at >= $1::TIMESTAMPTZ`,
      [`${CHALLENGE_CUTOVER_DAY}T00:00:00Z`],
    )
  ).rows.filter((r) => r.at < r.cur);
  const written = ctx.run
    ? await batched(
        ctx,
        "import-dates",
        rows,
        `UPDATE ${ctx.S}.discoveries AS d SET discovered_at = u.at
           FROM unnest($1::INT8[], $2::INT8[], $3::TIMESTAMPTZ[]) AS u(p, e, at)
          WHERE d.player_id = u.p AND d.element_id = u.e AND d.source = 'legacy' AND d.discovered_at > u.at`,
        (b) => [b.map((r) => r.p), b.map((r) => r.e), b.map((r) => r.at.toISOString())],
      )
    : null;
  return [{ step: "import-dates", what: "imported library rows dated by element/player", planned: rows.length, written }];
}

async function twinCredit(ctx: Ctx): Promise<Outcome[]> {
  const { pool, S } = ctx;
  // Every legacy spelling of every element that has at least one alias.
  const members = (
    await pool.query<{ element_id: string; lid: string; at: Date; cu: string }>(
      `SELECT m.element_id, la.id AS lid, la."createdAt" AS at, la."createdUserId" AS cu
         FROM ${S}.legacy_element_map m
         JOIN public."AlchemyElement" la ON la.id = m.legacy_id
         ${AOST}
        WHERE m.element_id IN (SELECT element_id FROM ${S}.legacy_element_map WHERE disposition = 'alias')`,
    )
  ).rows;
  const groups = new Map<string, typeof members>();
  for (const m of members) {
    const g = groups.get(m.element_id);
    if (g) g.push(m);
    else groups.set(m.element_id, [m]);
  }
  const creators = [...new Set(members.map((m) => m.cu).filter((u) => LEGACY_USER_RE.test(u)))];
  const playerOf = new Map(
    (await pool.query<{ id: string; u: string }>(`SELECT id, legacy_user_id AS u FROM ${S}.players WHERE legacy_user_id = ANY($1::STRING[])`, [creators])).rows.map(
      (r) => [r.u, r.id],
    ),
  );
  const ids = [...groups.keys()];
  const current = new Map(
    (await pool.query<{ id: string; created_at: Date; discovered_by: string | null }>(`SELECT id, created_at, discovered_by FROM ${S}.elements WHERE id = ANY($1::INT8[])`, [ids])).rows.map(
      (r) => [r.id, r],
    ),
  );
  const dates: { id: string; at: string }[] = [];
  const credits: { id: string; p: string; old: string | null }[] = [];
  for (const [id, g] of groups) {
    const el = current.get(id);
    if (!el) continue;
    const first = [...g].sort((a, b) => cmpLegacy({ at: a.at, id: a.lid }, { at: b.at, id: b.lid }))[0]!;
    if (first.at < el.created_at) dates.push({ id, at: first.at.toISOString() });
    const credited = LEGACY_USER_RE.test(first.cu) ? playerOf.get(first.cu) : undefined;
    if (!credited || credited === el.discovered_by) continue; // anonymous first spelling: keep the credit
    const canon = g.find((m) => m.lid === id);
    const canonCredit = canon && LEGACY_USER_RE.test(canon.cu) ? (playerOf.get(canon.cu) ?? null) : null;
    // Only replace what the backfill wrote (the canonical spelling's creator, or no credit).
    if (el.discovered_by === canonCredit) credits.push({ id, p: credited, old: canonCredit });
  }
  const writtenDates = ctx.run
    ? await batched(
        ctx,
        "elements.created_at",
        dates,
        `UPDATE ${S}.elements AS e SET created_at = u.at FROM unnest($1::INT8[], $2::TIMESTAMPTZ[]) AS u(id, at)
          WHERE e.id = u.id AND e.created_at > u.at`,
        (b) => [b.map((r) => r.id), b.map((r) => r.at)],
      )
    : null;
  const writtenCredits = ctx.run
    ? await batched(
        ctx,
        "elements.discovered_by",
        credits,
        `UPDATE ${S}.elements AS e SET discovered_by = u.p FROM unnest($1::INT8[], $2::INT8[], $3::INT8[]) AS u(id, p, old)
          WHERE e.id = u.id AND e.discovered_by IS NOT DISTINCT FROM u.old`,
        (b) => [b.map((r) => r.id), b.map((r) => r.p), b.map((r) => r.old)],
      )
    : null;
  return [
    { step: "twin-credit", what: `elements.created_at lowered to the earliest spelling (of ${fmt(groups.size)} twin groups)`, planned: dates.length, written: writtenDates },
    { step: "twin-credit", what: "elements.discovered_by moved to the earliest spelling's creator", planned: credits.length, written: writtenCredits },
  ];
}

async function imageUnblock(ctx: Ctx): Promise<Outcome[]> {
  const { pool, S } = ctx;
  const done = (await pool.query<{ value: { ids?: string[] } }>(`SELECT value FROM ${S}.meta WHERE key = $1`, [UNBLOCK_META])).rows[0]?.value.ids ?? [];
  const rows = (
    await pool.query<{ id: string; name: string }>(
      `SELECT id, name FROM ${S}.elements
        WHERE image_status = 'blocked' AND art_hint IS NULL AND description IS NULL AND NOT (id = ANY($1::INT8[]))`,
      [done],
    )
  ).rows;
  if (rows.length) console.log(`  image-unblock: ${rows.map((r) => r.name).join(", ")}`);
  let written: number | null = null;
  if (ctx.run && rows.length) {
    written =
      (
        await retrying("image-unblock", () =>
          pool.query(
            `UPDATE ${S}.elements SET image_status = 'none', image_attempts = 0, image_lease_until = NULL
              WHERE id = ANY($1::INT8[]) AND image_status = 'blocked' AND art_hint IS NULL AND description IS NULL`,
            [rows.map((r) => r.id)],
          ),
        )
      ).rowCount ?? 0;
    await pool.query(`UPSERT INTO ${S}.meta (key, value, updated_at) VALUES ($1, $2::JSONB, now())`, [
      UNBLOCK_META,
      JSON.stringify({ ids: [...done, ...rows.map((r) => r.id)], at: new Date().toISOString() }),
    ]);
  } else if (ctx.run) written = 0;
  return [{ step: "image-unblock", what: "blocked art without a hint gets one more try", planned: rows.length, written }];
}

const RUNNERS: Record<Step, (ctx: Ctx) => Promise<Outcome[]>> = {
  "players-created-at": playersCreatedAt,
  "starter-dates": starterDates,
  "import-dates": importDates,
  "twin-credit": twinCredit,
  "image-unblock": imageUnblock,
};

if (isMain(import.meta.url)) {
  runMain(async () => {
    const { values } = parseArgs({ options: { schema: { type: "string" }, run: { type: "boolean" }, steps: { type: "string" } } });
    const S = resolveSchema(values.schema);
    const steps = (values.steps ? values.steps.split(",").map((s) => s.trim()) : [...STEPS]) as Step[];
    for (const s of steps) if (!STEPS.includes(s)) throw new Error(`unknown step ${s}; steps: ${STEPS.join(", ")}`);
    const ordered = STEPS.filter((s) => steps.includes(s));
    const pool = createPool(2);
    try {
      const ctx: Ctx = { pool, S, run: values.run ?? false };
      const out: Outcome[] = [];
      for (const step of ordered) {
        console.log(`[${S}] ${step} ...`);
        out.push(...(await RUNNERS[step](ctx)));
      }
      printTable(out.map((o) => ({ step: o.step, change: o.what, planned: fmt(o.planned), written: o.written === null ? "(dry run)" : fmt(o.written) })));
      if (!ctx.run) console.log("Dry run: nothing written (pass --run to write).");
    } finally {
      await pool.end();
    }
  });
}
