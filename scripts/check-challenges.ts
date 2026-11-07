// Check that every daily challenge from today on is still valid and solvable:
//   - a row exists for every day through the last generated day,
//   - each target is ACTIVE (not purged/quarantined),
//   - each target is reachable from the five starters using only active 2-ingredient recipes
//     (the promise the challenges make), and sits in its intended BFS tier (easy 2 / hard 4 /
//     expert 6; a different tier is reported as drift, still solvable),
//   - generated targets are classified recognizable.
//
//   npm run db:check-challenges                 # read-only report
//   npm run db:check-challenges -- --fix        # also re-pick broken days after the live window
//
// --fix only touches generated days strictly after the latest day that is "today" anywhere on
// Earth, one day at a time, via `generate-challenges --replace-generated` (which refuses if any
// completion exists on/after that day). Broken days inside the live window are only reported.
import { execFileSync } from "node:child_process";
import { parseArgs } from "node:util";
import { addDays, utcDay } from "../src/shared/dates.ts";
import type { Tier } from "../src/shared/api.ts";
import { TIERS, TIER_LEVEL, analyzeWorld } from "./lib/challenges.ts";
import { createPool, resolveSchema } from "./lib/db.ts";
import "./lib/env.ts";
import { loadWorld } from "./lib/world.ts";

type Problem = "inactive" | "unreachable" | "tier-drift" | "not-recognizable";
interface Issue {
  day: string;
  tier: Tier;
  name: string;
  problem: Problem;
  detail: string;
}

const { values } = parseArgs({ options: { fix: { type: "boolean" }, schema: { type: "string" } } });
const schema = resolveSchema(values.schema);
const now = new Date();
const firstLive = utcDay(new Date(now.getTime() - 12 * 3_600_000));
const lastLive = utcDay(new Date(now.getTime() + 14 * 3_600_000));

const pool = createPool(3);
try {
  const { elements, recipes } = await loadWorld(pool, schema);
  const { active, tiers } = analyzeWorld(elements, recipes);
  const rows = (
    await pool.query<{ day: string; source: string; easy_id: string; hard_id: string; expert_id: string }>(
      `SELECT day::STRING AS day, source, easy_id, hard_id, expert_id FROM ${schema}.challenges WHERE day >= $1 ORDER BY day`,
      [firstLive],
    )
  ).rows;
  const names = new Map(
    (
      await pool.query<{ id: string; name: string; status: string }>(
        `SELECT id, name, status FROM ${schema}.elements WHERE id = ANY($1::INT8[])`,
        [[...new Set(rows.flatMap((r) => [r.easy_id, r.hard_id, r.expert_id]))]],
      )
    ).rows.map((r) => [r.id, r]),
  );

  const issues: Issue[] = [];
  const missing: string[] = [];
  const last = rows.at(-1)?.day ?? firstLive;
  const byDay = new Map(rows.map((r) => [r.day, r]));
  for (let d = firstLive; d <= last; d = addDays(d, 1)) if (!byDay.has(d)) missing.push(d);

  for (const r of rows) {
    for (const tier of TIERS) {
      const id = r[`${tier}_id`];
      const name = names.get(id)?.name ?? `#${id}`;
      const add = (problem: Problem, detail: string) => issues.push({ day: r.day, tier, name, problem, detail });
      if (!active.has(id)) {
        add("inactive", `status ${names.get(id)?.status ?? "missing"}`);
        continue;
      }
      const t = tiers.get(id);
      if (t === undefined) add("unreachable", "no path from the starters over active 2-ingredient recipes");
      else if (t !== TIER_LEVEL[tier]) add("tier-drift", `BFS tier ${t}, intended ${TIER_LEVEL[tier]}`);
      if (r.source === "generated" && active.get(id)!.recognizable !== true) add("not-recognizable", `recognizable=${active.get(id)!.recognizable}`);
    }
  }

  const broken = (i: Issue) => i.problem === "inactive" || i.problem === "unreachable";
  const brokenDays = [...new Set(issues.filter(broken).map((i) => i.day))].sort();
  const count = (p: Problem) => issues.filter((i) => i.problem === p).length;
  console.log(`[${schema}] ${rows.length} challenge days from ${firstLive} to ${last} (live window ${firstLive}..${lastLive})`);
  console.log(`  missing days: ${missing.length}${missing.length ? ` (${missing.slice(0, 10).join(", ")}${missing.length > 10 ? ", ..." : ""})` : ""}`);
  console.log(`  targets inactive: ${count("inactive")}, unreachable: ${count("unreachable")}  -> ${brokenDays.length} unsolvable day(s)`);
  console.log(`  tier drift (still solvable): ${count("tier-drift")}, generated targets not recognizable: ${count("not-recognizable")}`);
  for (const i of issues.filter(broken).slice(0, 40)) console.log(`    ${i.day} ${i.tier.padEnd(6)} ${i.name}: ${i.problem} (${i.detail})`);
  const drift = issues.filter((i) => i.problem === "tier-drift");
  if (drift.length) console.log(`  drift sample: ${drift.slice(0, 8).map((i) => `${i.day} ${i.tier} ${i.name} (${i.detail})`).join("; ")}`);

  if (values.fix) {
    const fixable = brokenDays.filter((d) => d > lastLive);
    const live = brokenDays.filter((d) => d <= lastLive);
    if (live.length) console.log(`  NOT fixing ${live.length} broken day(s) inside the live window: ${live.join(", ")}`);
    for (const day of fixable) {
      console.log(`  re-picking ${day} ...`);
      execFileSync(process.execPath, ["--import", "tsx", "scripts/generate-challenges.ts", "--replace-generated", "--from", day, "--days", "1", "--schema", schema], {
        stdio: ["ignore", "ignore", "inherit"],
      });
    }
    if (fixable.length) console.log(`  re-picked ${fixable.length} day(s); run again to confirm.`);
  }
  process.exitCode = missing.length || brokenDays.length ? 1 : 0;
} finally {
  await pool.end();
}
