// Check that every daily challenge from today on is still valid, solvable and up to the
// generator's current rules (pred-v6; scripts/lib/challenges.ts checkDays, spec §9.3):
//   broken (re-picked by --fix): inactive, unreachable (over active 2-ingredient recipes),
//     school-unsafe (name or emoji), unsafe-path (every route within steps + 1 goes through a
//     denied element), art-blocked, tier-order (steps must increase easy < hard < expert),
//     challenge-deny (CHALLENGE_DENY or classifier teacher flag), twin-trap (a spelling twin is at
//     least as widely made), and on pred-v6 rows also not-recognizable, out-of-season and p-order
//     (school-basis predicted completion must fall strictly easy > hard > expert). A tier-order or
//     p-order the planner recorded as its own fallback (meta.tiers[t].fallback) is only a warning:
//     a re-pick lands on the same targets.
//   report-only: p-low / p-high (more than 0.5 logit outside the band the day was picked in).
//   warnings: p-drift (prediction moved > 0.5 logit since the pick), reach-order, gap (weekday
//     expert < hard + 2 steps), steps-range, art-not-ready (easy 3 days out, others 7), appeal-low,
//     twin-near (a twin made by >= 25% as many players for easy, 50% above), near-name (C12).
// Pre-v6 rows (bfs-v3/v4, legacy) are broken only for inactive, unreachable, unsafe, unsafe-path,
// art-blocked, challenge-deny, twin-trap and tier-order; holdout tiers (meta.exp[tier].realized
// "holdout") and the order checks next to them only for the first seven.
//
//   npm run db:check-challenges                    # read-only report, every stored day from today
//   npm run db:check-challenges -- --days=35       # only days before today (UTC) + 35
//   npm run db:check-challenges -- --days=35 --fix # also re-pick broken days after the frozen window
//   npm run db:check-challenges -- --days=35 --fix --fix-from=2026-12-01
//
// The report reads ONE read-only snapshot (the same inputs as generate-challenges: active world,
// fresh steps, reach as of now). The report never needs a planning-sized cohort or full pools
// (prepareContext): on a fresh schema it still lists broken days, with a warning.
// --fix requires --days and challenges.meta (migration 0010), and re-picks only the broken days
// strictly after the write-frozen day (generate-challenges APPLY_FREEZE_MARGIN_MS), in ONE
// generate-challenges --replace-generated --only=... run (one plan + one transaction: it refuses
// frozen days and days with completions, and records the old row in meta.replaced). It re-picks
// the WHOLE row, so good tiers on a broken day change too. Broken days in the frozen window are
// only reported. Back up the affected rows first.
import { execFileSync } from "node:child_process";
import { parseArgs } from "node:util";
import type { Tier } from "../src/shared/api.ts";
import { addDays, isDay, utcDay } from "../src/shared/dates.ts";
import { dayType } from "./lib/challengeModel.ts";
import { brokenDays, checkDays, featuresOf, liveWindow, repickDeadline, splitRepickable, TIERS, type Issue, type Problem, type Severity } from "./lib/challenges.ts";
import { createPool, resolveSchema } from "./lib/db.ts";
import "./lib/env.ts";
import { prepareContext, readSnapshot, writeFrozenThrough } from "./generate-challenges.ts";

const { values } = parseArgs({
  options: { fix: { type: "boolean" }, "fix-from": { type: "string" }, schema: { type: "string" }, days: { type: "string" } },
});
const schema = resolveSchema(values.schema);
const now = new Date();
const today = utcDay(now);
const { firstLive, lastLive, frozenThrough } = liveWindow(now);
const days = values.days === undefined ? null : Number.parseInt(values.days, 10);
if (days !== null && !(days > 0)) throw new Error("--days must be a positive integer");
if (values.fix && days === null) throw new Error("--fix needs --days (e.g. --days=35): it re-picks broken days in that range only");
const until = days === null ? null : addDays(today, days); // exclusive
const fixFrom = values["fix-from"];
if (fixFrom !== undefined && !isDay(fixFrom)) throw new Error("--fix-from must be YYYY-MM-DD");

const pool = createPool(2);
try {
  const snap = await readSnapshot(pool, schema, now);
  const prep = prepareContext(snap);
  if (prep.smallCohort) console.warn(`WARNING: ${prep.smallCohort} The checks below still run; p-based ones are noise.`);
  const rows = snap.stored.filter((r) => r.day >= firstLive && (until === null || r.day < until));
  const name = (id: string) => prep.names.get(id) ?? `#${id}`;

  const missing: string[] = [];
  const last = rows.at(-1)?.day ?? firstLive;
  const byDay = new Set(rows.map((r) => r.day));
  for (let d = firstLive; d <= last; d = addDays(d, 1)) if (!byDay.has(d)) missing.push(d);

  const issues = checkDays(rows, prep.ctx, { today });
  const broken = brokenDays(issues);
  const { fixable, frozen } = splitRepickable(broken, now);
  const count = (p: Problem, s?: Severity) => issues.filter((i) => i.problem === p && (s === undefined || i.severity === s)).length;
  const gens = new Map<string, number>();
  for (const r of rows) gens.set(r.generator ?? r.source, (gens.get(r.generator ?? r.source) ?? 0) + 1);

  console.log(
    `[${schema}] ${rows.length} challenge days from ${firstLive} to ${last}${until ? ` (--days=${days}: before ${until})` : ""}; ` +
      `live window ${firstLive}..${lastLive}, frozen through ${frozenThrough} (teaser day); generators: ${[...gens].map(([g, n]) => `${g} ${n}`).join(", ")}`,
  );
  console.log(`  missing days: ${missing.length}${missing.length ? ` (${missing.slice(0, 10).join(", ")}${missing.length > 10 ? ", ..." : ""})` : ""}`);
  const line = (ps: Problem[]) => ps.map((p) => `${p} ${count(p)}${count(p, "broken") !== count(p) && count(p) ? ` (${count(p, "broken")} broken)` : ""}`).join(", ");
  console.log(`  checks that can break a day: ${line(["inactive", "unreachable", "unsafe", "unsafe-path", "art-blocked", "challenge-deny", "twin-trap", "tier-order", "not-recognizable", "out-of-season", "p-order"])}`);
  console.log(`  warnings: ${line(["p-drift", "reach-order", "gap", "steps-range", "art-not-ready", "appeal-low", "twin-near", "near-name"])}; report-only: ${line(["p-low", "p-high"])}`);
  console.log(`  -> ${broken.length} broken day(s): ${fixable.length} re-pickable (after ${frozenThrough}), ${frozen.length} frozen`);

  // Predicted completion of what is stored (school basis p; day basis via meta when present).
  if (rows.length) {
    console.log(`\n  predicted completion of the stored targets now (school basis, COEF_SELECT):`);
    for (const group of ["weekday", "off"] as const) {
      const rs = rows.filter((r) => (dayType(r.day) === "off") === (group === "off"));
      if (!rs.length) continue;
      const cells = TIERS.map((t) => {
        const ps = rs.map((r) => featuresOf(prep.ctx, r.targets[t])?.p[t]).filter((x): x is number => x !== undefined).sort((a, b) => a - b);
        const mean = ps.reduce((a, b) => a + b, 0) / Math.max(1, ps.length);
        return `${t} mean ${(100 * mean).toFixed(2)}% p10 ${(100 * (ps[Math.floor(0.1 * (ps.length - 1))] ?? 0)).toFixed(2)}%`;
      });
      console.log(`    ${group} (${rs.length}): ${cells.join("; ")}`);
    }
    const arms = new Map<string, number>();
    for (const r of rows) {
      const e = r.meta?.exp;
      if (!e) continue;
      const k = [e.holdout.realized ? "holdout" : null, `hard ${e.hard.realized ?? "skipped"}`, `expert ${e.expert.realized ?? "skipped"}`].filter(Boolean).join(" / ");
      arms.set(k, (arms.get(k) ?? 0) + 1);
    }
    if (arms.size) console.log(`  arms (realized): ${[...arms].sort().map(([k, v]) => `${k}: ${v}`).join("; ")}`);
    const brokenByArm = new Map<string, number>();
    for (const d of broken) {
      const e = rows.find((r) => r.day === d)?.meta?.exp;
      const k = e ? (e.holdout.realized ? "holdout" : `expert ${e.expert.realized ?? "-"}`) : "no meta";
      brokenByArm.set(k, (brokenByArm.get(k) ?? 0) + 1);
    }
    if (brokenByArm.size) console.log(`  broken days by arm: ${[...brokenByArm].map(([k, v]) => `${k} ${v}`).join(", ")}`);
  }

  if (broken.length) console.log(`\n  broken days (re-pick deadline = D-2 10:00 UTC):`);
  for (const day of broken) {
    const why = issues.filter((i) => i.day === day && i.severity === "broken");
    const when = day <= frozenThrough ? "FROZEN" : `fix by ${repickDeadline(day).toISOString().slice(0, 16).replace("T", " ")} UTC`;
    console.log(`    ${day} [${when}] ${why.map((i: Issue) => `${i.tier} ${name(i.id)}: ${i.problem} (${i.detail})`).join("; ")}`);
  }
  const warn = issues.filter((i) => i.severity !== "broken");
  if (warn.length) {
    console.log(`\n  warning sample:`);
    for (const i of warn.slice(0, 12)) console.log(`    ${i.day} ${i.tier as Tier} ${name(i.id)}: ${i.problem} (${i.detail})`);
  }

  if (values.fix) {
    if (frozen.length) console.log(`  NOT fixing ${frozen.length} broken day(s) through ${frozenThrough}: ${frozen.join(", ")}`);
    const writeFrozen = writeFrozenThrough(new Date());
    const late = fixable.filter((d) => d <= writeFrozen);
    if (late.length) console.log(`  NOT fixing ${late.length} broken day(s) that freeze within the write margin: ${late.join(", ")}`);
    const todo = fixable.filter((d) => d > writeFrozen && (!fixFrom || d >= fixFrom));
    if (fixFrom) console.log(`  --fix-from=${fixFrom}: leaving ${fixable.length - late.length - todo.length} re-pickable day(s) before it as they are`);
    if (todo.length && !snap.hasMeta) {
      console.log(
        `  NOT fixing ${todo.length} day(s): challenges.meta is missing (apply migration 0010, then roll out pred-v6 with a reviewed plan; ` +
          `an emergency safety swap: npm run db:challenges -- --replace-generated --only=<days> --reason=safety --allow-no-meta, never on a holdout day).`,
      );
    } else if (todo.length) {
      console.log(`  re-picking ${todo.length} day(s) in one plan: ${todo.join(", ")}`);
      execFileSync(
        process.execPath,
        ["--import", "tsx", "scripts/generate-challenges.ts", "--replace-generated", `--only=${todo.join(",")}`, "--reason=check-fix", "--show=0", "--schema", schema],
        { stdio: ["ignore", "inherit", "inherit"] },
      );
      console.log(`  re-picked ${todo.length} day(s); run again to confirm.`);
    }
  }
  process.exitCode = missing.length || broken.length ? 1 : 0;
} finally {
  await pool.end();
}
