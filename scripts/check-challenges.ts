// Check that every daily challenge from today on is still valid, solvable and up to the
// generator's current rules (scripts/lib/challenges.ts checkDays):
//   - a row exists for every day through the last generated day,
//   - each target is ACTIVE (not purged/quarantined),
//   - each target is reachable from the five starters using only active 2-ingredient recipes
//     (the promise the challenges make), and sits in its intended BFS tier (easy 2 / hard 4 /
//     expert 6; a different tier is reported as drift, still solvable),
//   - generated targets are classified recognizable,
//   - easy targets have ≥ 3 shallow paths ("undiscoverable" otherwise), no target has blocked
//     art ("art-blocked") or a school-unsafe name ("unsafe"), and steps increase
//     easy < hard < expert ("tier-order", on current elements.steps).
// Days with inactive, unreachable, undiscoverable, art-blocked, unsafe or tier-order targets
// count as broken; drift and not-recognizable are warnings.
//
//   npm run db:check-challenges                    # read-only report, every stored day
//   npm run db:check-challenges -- --days=90       # only days before today (UTC) + 90
//   npm run db:check-challenges -- --days=90 --fix # also re-pick broken days after the frozen window
//   npm run db:check-challenges -- --days=90 --fix --fix-from=2026-12-01   # ... only days >= 12-01
//
// --fix requires --days: each re-picked day is one generate-challenges run (~18 s: it reloads the
// world and simulates from the cutover), and under the current rules about half of the five
// stored years are broken, so an unbounded --fix would run for hours and rewrite years of days.
//
// The report runs in ONE read-only transaction (writes are impossible without --fix). --fix only
// touches generated days strictly after lastLive + 1 (lastLive = the latest day that is "today"
// anywhere on Earth; the day after it is shown as tomorrow's teaser), one day at a time, via
// `generate-challenges --replace-generated` (which refuses if any completion exists on/after
// that day). It re-picks the WHOLE row, so good tiers on a broken day change too. Broken days in
// the frozen window are only reported. Back up the affected rows before running it.
import { execFileSync } from "node:child_process";
import { parseArgs } from "node:util";
import type pg from "pg";
import { addDays, isDay, utcDay } from "../src/shared/dates.ts";
import { BROKEN_PROBLEMS, analyzeWorld, checkDays, liveWindow, repickDeadline, splitRepickable, type Issue, type Problem } from "./lib/challenges.ts";
import { createPool, resolveSchema } from "./lib/db.ts";
import "./lib/env.ts";
import { loadWorld } from "./lib/world.ts";

const { values } = parseArgs({
  options: { fix: { type: "boolean" }, "fix-from": { type: "string" }, schema: { type: "string" }, days: { type: "string" } },
});
const schema = resolveSchema(values.schema);
const now = new Date();
const { firstLive, lastLive, frozenThrough } = liveWindow(now);
const days = values.days === undefined ? null : Number.parseInt(values.days, 10);
if (days !== null && !(days > 0)) throw new Error("--days must be a positive integer");
if (values.fix && days === null) throw new Error("--fix needs --days (e.g. --days=90): each re-picked day takes one generator run");
const until = days === null ? null : addDays(utcDay(now), days); // exclusive
const fixFrom = values["fix-from"];
if (fixFrom !== undefined && !isDay(fixFrom)) throw new Error("--fix-from must be YYYY-MM-DD");

/** One consistent snapshot, read in a READ ONLY transaction. */
async function readSnapshot(pool: pg.Pool) {
  const db = await pool.connect();
  try {
    await db.query("BEGIN TRANSACTION READ ONLY");
    const { elements, recipes } = await loadWorld(db, schema);
    const rows = (
      await db.query<{ day: string; source: string; easy_id: string; hard_id: string; expert_id: string }>(
        `SELECT day::STRING AS day, source, easy_id, hard_id, expert_id FROM ${schema}.challenges
          WHERE day >= $1::DATE AND ($2::DATE IS NULL OR day < $2::DATE) ORDER BY day`,
        [firstLive, until],
      )
    ).rows;
    const names = new Map(
      (
        await db.query<{ id: string; name: string; status: string }>(`SELECT id, name, status FROM ${schema}.elements WHERE id = ANY($1::INT8[])`, [
          [...new Set(rows.flatMap((r) => [r.easy_id, r.hard_id, r.expert_id]))],
        ])
      ).rows.map((r) => [r.id, r]),
    );
    await db.query("COMMIT");
    return { world: analyzeWorld(elements, recipes), rows, names };
  } catch (e) {
    await db.query("ROLLBACK").catch(() => {});
    throw e;
  } finally {
    db.release();
  }
}

const pool = createPool(3);
try {
  const { world, rows, names } = await readSnapshot(pool);

  const missing: string[] = [];
  const last = rows.at(-1)?.day ?? firstLive;
  const byDay = new Set(rows.map((r) => r.day));
  for (let d = firstLive; d <= last; d = addDays(d, 1)) if (!byDay.has(d)) missing.push(d);

  const issues = checkDays(
    rows.map((r) => ({ day: r.day, source: r.source, targets: { easy: r.easy_id, hard: r.hard_id, expert: r.expert_id } })),
    world,
  );
  const name = (i: Issue) => names.get(i.id)?.name ?? `#${i.id}`;
  for (const i of issues) if (i.problem === "inactive") i.detail = `status ${names.get(i.id)?.status ?? "missing"}`;
  const broken = (i: Issue) => BROKEN_PROBLEMS.has(i.problem);
  const brokenDays = [...new Set(issues.filter(broken).map((i) => i.day))].sort();
  const count = (p: Problem) => issues.filter((i) => i.problem === p).length;
  const { fixable, frozen } = splitRepickable(brokenDays, now);

  console.log(
    `[${schema}] ${rows.length} challenge days from ${firstLive} to ${last}${until ? ` (--days=${days}: before ${until})` : ""}; ` +
      `live window ${firstLive}..${lastLive}, frozen through ${frozenThrough} (teaser day)`,
  );
  console.log(`  missing days: ${missing.length}${missing.length ? ` (${missing.slice(0, 10).join(", ")}${missing.length > 10 ? ", ..." : ""})` : ""}`);
  console.log(`  targets inactive: ${count("inactive")}, unreachable: ${count("unreachable")}`);
  console.log(
    `  easy undiscoverable (< 3 shallow paths): ${count("undiscoverable")}, art blocked: ${count("art-blocked")}, ` +
      `school-unsafe: ${count("unsafe")}, tier order (steps): ${count("tier-order")}`,
  );
  console.log(`  -> ${brokenDays.length} broken day(s): ${fixable.length} re-pickable (after ${frozenThrough}), ${frozen.length} frozen`);
  console.log(`  warnings: tier drift (still solvable): ${count("tier-drift")}, generated targets not recognizable: ${count("not-recognizable")}`);
  if (brokenDays.length) console.log(`\n  broken days (re-pick deadline = D-2 10:00 UTC):`);
  for (const day of brokenDays) {
    const why = issues.filter((i) => i.day === day && broken(i));
    const when = day <= frozenThrough ? "FROZEN" : `fix by ${repickDeadline(day).toISOString().slice(0, 16).replace("T", " ")} UTC`;
    console.log(`    ${day} [${when}] ${why.map((i) => `${i.tier} ${name(i)}: ${i.problem} (${i.detail})`).join("; ")}`);
  }
  const drift = issues.filter((i) => i.problem === "tier-drift");
  if (drift.length) console.log(`\n  drift sample: ${drift.slice(0, 8).map((i) => `${i.day} ${i.tier} ${name(i)} (${i.detail})`).join("; ")}`);
  if (rows.length) {
    const hist = new Map<string, number>();
    for (const r of rows) {
      const p = world.paths.get(r.easy_id) ?? 0;
      const bucket = p >= 5 ? "5+" : String(p);
      hist.set(bucket, (hist.get(bucket) ?? 0) + 1);
    }
    console.log(`\n  easy shallow paths per day: ${[...hist].sort().map(([k, v]) => `${k}: ${v}`).join(", ")} (of ${rows.length} days)`);
  }

  if (values.fix) {
    if (frozen.length) console.log(`  NOT fixing ${frozen.length} broken day(s) through ${frozenThrough}: ${frozen.join(", ")}`);
    const todo = fixable.filter((d) => !fixFrom || d >= fixFrom);
    if (fixFrom) console.log(`  --fix-from=${fixFrom}: leaving ${fixable.length - todo.length} re-pickable day(s) before it as they are`);
    for (const day of todo) {
      // A long run can cross a 10:00 UTC boundary: re-check the guard right before each day.
      if (splitRepickable([day], new Date()).fixable.length === 0) {
        console.log(`  NOT fixing ${day}: it froze during this run`);
        continue;
      }
      console.log(`  re-picking ${day} ...`);
      execFileSync(process.execPath, ["--import", "tsx", "scripts/generate-challenges.ts", "--replace-generated", "--from", day, "--days", "1", "--schema", schema], {
        stdio: ["ignore", "ignore", "inherit"],
      });
    }
    if (todo.length) console.log(`  re-picked up to ${todo.length} day(s); run again to confirm.`);
  }
  process.exitCode = missing.length || brokenDays.length ? 1 : 0;
} finally {
  await pool.end();
}
