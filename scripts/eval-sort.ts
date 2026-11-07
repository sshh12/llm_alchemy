// Offline-first eval of the custom library sort ("Sort by anything", server/ai/jev.ts) against
// the live TypeSafe Jev API. It scores the 286-element eval library in scripts/eval-sort.cases.json
// for every rank and groups case. The requests are exactly what production sends: packChunks,
// then requestBody, imported from jev.ts so they can't drift. Answers are parsed with the real
// parseChunk, ordered and bucketed by the client's own librarySort (orderLibrary, groupOf,
// levelLabel), and scored by the metrics in scripts/lib/evalMetrics.ts.
//
//   npm run eval:sort -- [--split tune|holdout|all] [--cases a,b] [--offline] [--repeat N]
//                        [--budget-usd 0.10] [--json out.json] [--compare scripts/eval-sort.baseline.json]
//                        [--verbose] [--cache-dir DIR]
//
// When to run it: before any SORT_RUBRIC bump, any SORT_MODEL pin change, or any edit to a jev.ts
// string. Tune on `tune`, then confirm once on `holdout` with
// `--compare scripts/eval-sort.baseline.json`. That command exits 1 when a holdout gate fails
// (evalMetrics GATES). After an intended change, regenerate the baseline with
// `--split holdout --json scripts/eval-sort.baseline.json`.
//
// Cost and caching:
// - Every response is cached under .cache/eval-sort/<sha256(body)>.json. For repeats r > 0 the key
//   is sha256(body + "\n#rep=r"); the body sent is unchanged.
// - Reruns and metric changes are free, and --offline never calls Jev.
// - Fresh calls run at most 4 in flight. 408/429/529/5xx and network errors are retried,
//   honoring retry-after. Each call is appended to .cache/eval-sort/ledger.jsonl.
// - A call that could push this run's spend past --budget-usd is not started.
// - A full uncached run is about 1.8M input tokens (≈ $0.08); holdout alone is about $0.04.
//
// Deliberately not a *.test.ts: vitest would then spend money on every `npm test`. The offline
// checks (label sanity, metric fixtures, the runner against a stub fetch) are in
// scripts/eval-sort.test.ts. Reads TYPESAFE_API_KEY from .env and never prints it.
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { SORT_FIT_THRESHOLD, SORT_MATCH_THRESHOLD, SORT_RUBRIC, type ElementId, type SortScore, type SortSpec } from "../src/shared/api.ts";
import { engineId, JEV_URL, packChunks, parseChunk, requestBody, SORT_MODEL, type ScoreItem } from "../server/ai/jev.ts";
import { isMain, runMain } from "./lib/cli.ts";
import {
  averageMetrics,
  compareRuns,
  familyOf,
  groupsCaseMetrics,
  groupsStability,
  isRankCase,
  libraryOf,
  rankCaseMetrics,
  rankStability,
  specOf,
  SPLITS,
  summarize,
  validateCases,
  type CaseResult,
  type EvalCase,
  type EvalCases,
  type GateRow,
  type Metrics,
  type Split,
  type SplitSummary,
} from "./lib/evalMetrics.ts";

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = path.resolve(HERE, "..");
export const CASES_FILE = path.join(HERE, "eval-sort.cases.json");
export const DEFAULT_CACHE_DIR = path.join(REPO_ROOT, ".cache", "eval-sort");
/** jev-1.14.0 input price ($0.042 per 1M tokens; output is not billed). */
export const USD_PER_TOKEN = 0.042 / 1e6;
const MAX_IN_FLIGHT = 4;
const MAX_ATTEMPTS = 6;
const CALL_TIMEOUT_MS = 90_000;
/** A longer retry-after (a daily quota, say) fails the call instead of stalling the run. */
const MAX_RETRY_WAIT_MS = 60_000;
const MAX_REPEAT = 10;
/** Pre-call token estimate for the budget: body chars / 2 (measured 3.1 chars/token for rank, 2.2–2.6 for groups). */
export const estTokens = (body: string): number => Math.ceil(body.length / 2);

export const USAGE = `usage: npm run eval:sort -- [options]
  --split tune|holdout|all   cases to report (default tune; all with --cases)
  --cases a,b                only these case ids (their pair/component cases are scored too)
  --offline                  never call Jev: cases with an uncached request are reported missing
  --repeat N                 N independent runs per case (cache key salted per repeat), metrics averaged
  --budget-usd X             refuse to start a call that could push this run past $X (default 0.10)
  --json FILE                write the summary and per-case metrics (the baseline format)
  --compare FILE             compare holdout with a baseline (--json output); exit 1 when a gate fails
  --verbose, -v              per-case tables and details (top 10, misses, wrong group labels)
  --cache-dir DIR            response cache (default .cache/eval-sort)`;

// ---------------------------------------------------------------- options

export interface EvalOptions {
  split: "tune" | "holdout" | "all";
  cases: string[] | null;
  offline: boolean;
  repeat: number;
  budgetUsd: number;
  json: string | null;
  compare: string | null;
  verbose: boolean;
  cacheDir: string;
  casesFile: string;
}

export function parseArgs(argv: readonly string[]): EvalOptions | "help" {
  let split: string | null = null;
  const o: EvalOptions = {
    split: "tune",
    cases: null,
    offline: false,
    repeat: 1,
    budgetUsd: 0.1,
    json: null,
    compare: null,
    verbose: false,
    cacheDir: DEFAULT_CACHE_DIR,
    casesFile: CASES_FILE,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    const val = () => {
      const v = argv[++i];
      if (v === undefined || v.startsWith("--")) throw new Error(`${a} needs a value\n${USAGE}`);
      return v;
    };
    if (a === "--help" || a === "-h") return "help";
    else if (a === "--split") split = val();
    else if (a === "--cases") o.cases = val().split(",").map((s) => s.trim()).filter(Boolean);
    else if (a === "--offline") o.offline = true;
    else if (a === "--repeat") {
      const n = Number(val());
      if (!Number.isInteger(n) || n < 1 || n > MAX_REPEAT) throw new Error(`--repeat must be an integer 1..${MAX_REPEAT}`);
      o.repeat = n;
    } else if (a === "--budget-usd") {
      const x = Number(val());
      if (!Number.isFinite(x) || x < 0) throw new Error("--budget-usd must be a number ≥ 0");
      o.budgetUsd = x;
    } else if (a === "--json") o.json = path.resolve(val());
    else if (a === "--compare") o.compare = path.resolve(val());
    else if (a === "--verbose" || a === "-v") o.verbose = true;
    else if (a === "--cache-dir") o.cacheDir = path.resolve(val());
    else throw new Error(`unknown argument ${a}\n${USAGE}`);
  }
  split ??= o.cases ? "all" : "tune";
  if (split !== "tune" && split !== "holdout" && split !== "all") throw new Error("--split must be tune, holdout or all");
  o.split = split;
  if (o.cases && !o.cases.length) throw new Error("--cases needs at least one case id");
  return o;
}

export function loadCases(file: string): EvalCases {
  const data = JSON.parse(fs.readFileSync(file, "utf8")) as EvalCases;
  const problems = validateCases(data);
  if (problems.length) throw new Error(`${file}: ${problems.length} label problem(s):\n  ${problems.slice(0, 30).join("\n  ")}`);
  return data;
}

// ---------------------------------------------------------------- requests, cache, ledger

export interface EvalDeps {
  fetch: typeof globalThis.fetch;
  sleep: (ms: number) => Promise<void>;
  /** The Jev key. Called only when a fresh call is needed. */
  key: () => string;
  /** Progress lines (stderr in the CLI). */
  log: (line: string) => void;
  random: () => number;
}

interface Job {
  sha: string;
  body: string;
  label: string;
  est: number;
  questions: number;
}

/** One case at one repeat: the chunks production would send and their request jobs. */
interface RunPlan {
  spec: SortSpec;
  chunks: ScoreItem[][];
  jobs: Job[];
}

const sha256 = (s: string) => crypto.createHash("sha256").update(s).digest("hex");

/** Cache key of one request body: sha256(body), or sha256(body + "\n#rep=r") for repeat r > 0. */
export const cacheKey = (body: string, rep = 0): string => sha256(rep > 0 ? `${body}\n#rep=${rep}` : body);

interface CacheRecord {
  sha: string;
  label: string;
  model?: unknown;
  ms: number;
  attempts: number;
  usage?: { input_tokens?: unknown; output_tokens?: unknown };
  answers: unknown;
  ts: string;
}

const cachePath = (dir: string, sha: string) => path.join(dir, `${sha}.json`);

function readCache(dir: string, sha: string): CacheRecord | null {
  try {
    const rec = JSON.parse(fs.readFileSync(cachePath(dir, sha), "utf8")) as CacheRecord;
    return rec && typeof rec === "object" && rec.answers && typeof rec.answers === "object" ? rec : null;
  } catch {
    return null;
  }
}

function writeCache(dir: string, rec: CacheRecord): void {
  const file = cachePath(dir, rec.sha);
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(rec));
  fs.renameSync(tmp, file);
}

const ledgerPath = (dir: string) => path.join(dir, "ledger.jsonl");

function ledgerTokens(dir: string): number {
  try {
    return fs
      .readFileSync(ledgerPath(dir), "utf8")
      .split("\n")
      .filter(Boolean)
      .reduce((n, line) => n + (Number((JSON.parse(line) as { tokens?: unknown }).tokens) || 0), 0);
  } catch {
    return 0;
  }
}

const tokensOf = (rec: { usage?: { input_tokens?: unknown } }): number => {
  const t = rec.usage?.input_tokens;
  return typeof t === "number" && Number.isFinite(t) ? t : 0;
};

/** `retry-after` as delta-seconds or an HTTP date, in ms; null when absent or unparsable. */
function retryAfterMs(header: string | null): number | null {
  if (!header) return null;
  const secs = Number(header);
  if (Number.isFinite(secs) && secs >= 0) return secs * 1000;
  const at = Date.parse(header);
  return Number.isFinite(at) ? Math.max(0, at - Date.now()) : null;
}

/** One request with retries (408, 429, 529, 5xx, network), honoring retry-after. Errors never carry the key. */
async function callJev(body: string, key: string, d: EvalDeps): Promise<{ json: Record<string, unknown>; ms: number; attempts: number }> {
  const redact = (s: string) => s.split(key).join("[redacted]");
  for (let attempt = 1; ; attempt++) {
    const t0 = performance.now();
    let res: Response | null = null;
    let netErr = "";
    try {
      res = await d.fetch(JEV_URL, {
        method: "POST",
        headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
        body,
        signal: AbortSignal.timeout(CALL_TIMEOUT_MS),
      });
      if (res.ok) {
        const json = (await res.json()) as unknown;
        if (!json || typeof json !== "object" || !(json as { answers?: unknown }).answers || typeof (json as { answers?: unknown }).answers !== "object") {
          throw new Error("response has no answers object");
        }
        return { json: json as Record<string, unknown>, ms: Math.round(performance.now() - t0), attempts: attempt };
      }
    } catch (e) {
      if (res?.ok) throw new Error(`jev ${res.status}: ${redact((e as Error).message)}`);
      netErr = `${(e as Error)?.name ?? "Error"}: ${(e as Error)?.message ?? String(e)}`;
      res = null;
    }
    const status = res?.status ?? 0;
    // The eval's inputs are not secret, so a short error body helps; the key is still scrubbed.
    const text = res ? await res.text().catch(() => "") : netErr;
    const retryable = !res || status === 408 || status === 429 || status === 529 || status >= 500;
    const what = `jev ${status || "network"}: ${redact(text).replace(/\s+/g, " ").slice(0, 200)}`;
    if (!retryable || attempt >= MAX_ATTEMPTS) throw new Error(what);
    const wait = retryAfterMs(res?.headers.get("retry-after") ?? null) ?? Math.min(30_000, 1000 * 2 ** (attempt - 1)) + d.random() * 500;
    if (wait > MAX_RETRY_WAIT_MS) throw new Error(`${what} (retry-after ${Math.round(wait / 1000)} s; try again later)`);
    d.log(`  ${what.slice(0, 80)}; retry ${attempt} in ${Math.round(wait)} ms`);
    await d.sleep(wait);
  }
}

export interface FetchStats {
  /** Unique requests the run needs, and how many of them were not cached. */
  requests: number;
  uncached: number;
  fresh: number;
  freshTokens: number;
  failed: number;
  /** Not started: they could have pushed the run past --budget-usd. */
  overBudget: number;
}

/** Fetch every uncached job (deduped by sha), at most 4 in flight, within the run's budget. */
async function fetchMissing(jobs: readonly Job[], o: EvalOptions, d: EvalDeps): Promise<FetchStats> {
  const unique = [...new Map(jobs.map((j) => [j.sha, j])).values()];
  const todo = unique.filter((j) => !readCache(o.cacheDir, j.sha));
  const stats: FetchStats = { requests: unique.length, uncached: todo.length, fresh: 0, freshTokens: 0, failed: 0, overBudget: 0 };
  if (!todo.length) return stats;
  if (o.offline) {
    d.log(`offline: ${todo.length} of ${unique.length} request(s) not cached; their cases are reported missing`);
    stats.failed = todo.length;
    return stats;
  }
  const key = d.key();
  if (!key) throw new Error("TYPESAFE_API_KEY is empty");
  fs.mkdirSync(o.cacheDir, { recursive: true });
  const budget = o.budgetUsd / USD_PER_TOKEN;
  const est = todo.reduce((n, j) => n + j.est, 0);
  d.log(
    `fetching ${todo.length} of ${unique.length} request(s), est ≤ ${est.toLocaleString("en-US")} tokens (≤ $${(est * USD_PER_TOKEN).toFixed(4)}); ` +
      `budget $${o.budgetUsd.toFixed(2)}`,
  );
  let next = 0;
  let inflight = 0;
  const worker = async () => {
    while (next < todo.length) {
      const job = todo[next++]!;
      if (stats.freshTokens + inflight + job.est > budget) {
        d.log(`  budget: not starting ${job.label} (could pass $${o.budgetUsd.toFixed(2)})`);
        stats.overBudget++;
        stats.failed++;
        continue;
      }
      inflight += job.est;
      try {
        const r = await callJev(job.body, key, d);
        const usage = (r.json.usage && typeof r.json.usage === "object" ? r.json.usage : {}) as CacheRecord["usage"];
        const rec: CacheRecord = { sha: job.sha, label: job.label, model: r.json.model, ms: r.ms, attempts: r.attempts, usage, answers: r.json.answers, ts: new Date().toISOString() };
        const tokens = tokensOf(rec);
        writeCache(o.cacheDir, rec);
        fs.appendFileSync(ledgerPath(o.cacheDir), `${JSON.stringify({ ts: rec.ts, sha: job.sha, tokens, ms: r.ms, attempts: r.attempts, label: job.label, engine: engineId() })}\n`);
        stats.fresh++;
        stats.freshTokens += tokens;
        d.log(`  ok ${job.label}: ${job.questions} questions, ${tokens} tokens, ${r.ms} ms`);
      } catch (e) {
        stats.failed++;
        d.log(`  FAILED ${job.label}: ${(e as Error).message.split(key).join("[redacted]")}`);
      } finally {
        inflight -= job.est;
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(MAX_IN_FLIGHT, todo.length) }, worker));
  return stats;
}

// ---------------------------------------------------------------- evaluation

interface Scored {
  scores: Map<ElementId, SortScore>;
  unparsed: number;
  tokens: number;
  requests: number;
}

const round4 = (x: number | null): number | null => (x === null || !Number.isFinite(x) ? null : Math.round(x * 1e4) / 1e4);
const roundAll = (m: Metrics): Metrics => Object.fromEntries(Object.entries(m).map(([k, v]) => [k, round4(v)]));
const toNumbers = (s: ReadonlyMap<ElementId, SortScore>) => new Map([...s].map(([id, sc]) => [id, sc.s]));

export interface EvalResult {
  tool: "eval-sort";
  version: 1;
  engine: string;
  model: string;
  rubric: string;
  thresholds: { match: number; fit: number };
  ts: string;
  split: EvalOptions["split"];
  cases: string[] | null;
  repeat: number;
  elements: number;
  summary: Partial<Record<Split, SplitSummary>>;
  perCase: CaseResult[];
  cost: { requests: number; tokens: number; usd: number; fresh: number; freshTokens: number; freshUsd: number; failed: number; overBudget: number };
}

export interface EvalRun {
  result: EvalResult;
  text: string;
  /** 0 ok; 1 = a case is missing or a --compare gate failed. */
  exitCode: number;
  gates?: { rows: GateRow[]; failed: boolean; common: number };
}

export async function runEval(o: EvalOptions, d: EvalDeps): Promise<EvalRun> {
  const data = loadCases(o.casesFile);
  const lib = libraryOf(data.elements);
  const all: EvalCase[] = [...data.rank, ...data.groups];
  const byId = new Map(all.map((c) => [c.id, c]));
  for (const id of o.cases ?? []) if (!byId.has(id)) throw new Error(`unknown case ${id}`);
  const selected = all.filter((c) => (o.split === "all" || c.split === o.split) && (!o.cases || o.cases.includes(c.id)));
  if (!selected.length) throw new Error(`no cases selected (split ${o.split}${o.cases ? `, cases ${o.cases.join(",")}` : ""})`);
  // Negation twins and compound components are scored too, but not reported.
  const needed = new Map(selected.map((c) => [c.id, c]));
  for (const c of selected) {
    if (!isRankCase(c)) continue;
    for (const dep of [c.pair_with, ...(c.components ?? [])]) if (dep !== undefined && !needed.has(dep)) needed.set(dep, byId.get(dep)!);
  }

  const plans = new Map<string, RunPlan>();
  const jobs: Job[] = [];
  for (const c of needed.values()) {
    const spec = specOf(c);
    const chunks = packChunks(spec, lib.items);
    for (let rep = 0; rep < o.repeat; rep++) {
      const js = chunks.map((chunk, i): Job => {
        const body = requestBody(spec, chunk);
        return {
          sha: cacheKey(body, rep),
          body,
          label: `${c.id}${rep ? `/rep${rep}` : ""}#${i + 1}of${chunks.length}`,
          est: estTokens(body),
          questions: Object.keys((JSON.parse(body) as { questions: object }).questions).length,
        };
      });
      jobs.push(...js);
      plans.set(`${c.id}#${rep}`, { spec, chunks, jobs: js });
    }
  }

  const fetched = await fetchMissing(jobs, o, d);

  const records = new Map<string, CacheRecord | null>();
  const record = (sha: string) => {
    if (!records.has(sha)) records.set(sha, readCache(o.cacheDir, sha));
    return records.get(sha)!;
  };
  const scoredMemo = new Map<string, Scored | null>();
  const scored = (id: string, rep: number): Scored | null => {
    const k = `${id}#${rep}`;
    if (scoredMemo.has(k)) return scoredMemo.get(k)!;
    const p = plans.get(k)!;
    let out: Scored | null = { scores: new Map(), unparsed: 0, tokens: 0, requests: p.jobs.length };
    for (let i = 0; i < p.jobs.length && out; i++) {
      const rec = record(p.jobs[i]!.sha);
      if (!rec) {
        out = null;
        break;
      }
      // The real parser: an id it cannot use lands in `retry`, which counts as unparsed here.
      const r = parseChunk(p.spec, p.chunks[i]!, rec.answers);
      for (const [eid, sc] of r.scored) out.scores.set(eid, sc);
      out.unparsed += r.retry.length;
      out.tokens += tokensOf(rec);
    }
    scoredMemo.set(k, out);
    return out;
  };

  const perCase: CaseResult[] = [];
  let tokensAll = 0;
  for (const c of selected) {
    const rank = isRankCase(c);
    const base: CaseResult = rank
      ? { id: c.id, split: c.split, kind: "rank", category: c.category, family: familyOf(c), ...(c.informational ? { informational: true } : {}), status: "missing" }
      : { id: c.id, split: c.split, kind: "groups", category: c.category, k: c.groups.length, other: c.other, status: "missing" };
    const reps: Metrics[] = [];
    const repScores: Map<ElementId, SortScore>[] = [];
    let detail: CaseResult["detail"];
    let tokens = 0;
    let requests = 0;
    let unparsed = 0;
    for (let rep = 0; rep < o.repeat; rep++) {
      const s = scored(c.id, rep);
      if (!s) break;
      tokens += s.tokens;
      requests += s.requests;
      unparsed += s.unparsed;
      let r: ReturnType<typeof rankCaseMetrics>;
      if (isRankCase(c)) {
        const deps = new Map<string, Map<ElementId, number>>();
        for (const dep of [c.pair_with, ...(c.components ?? [])]) {
          const ds = dep !== undefined ? scored(dep, rep) : null;
          if (dep !== undefined && ds) deps.set(dep, toNumbers(ds.scores));
        }
        r = rankCaseMetrics(c, toNumbers(s.scores), lib, deps, SORT_MATCH_THRESHOLD);
      } else {
        r = groupsCaseMetrics(c, s.scores, lib);
      }
      reps.push(r.m);
      repScores.push(s.scores);
      if (rep === 0) detail = r.detail;
    }
    if (reps.length < o.repeat) {
      perCase.push(base);
      continue;
    }
    tokensAll += tokens;
    const stability = o.repeat > 1 ? (isRankCase(c) ? rankStability(repScores.map(toNumbers)) : groupsStability(c, repScores)) : {};
    const metrics = roundAll({ ...averageMetrics(reps), ...stability, tokens, requests, unparsed, tokPerEl: tokens / lib.items.length / o.repeat });
    perCase.push({ ...base, status: "ok", metrics, ...(detail ? { detail } : {}) });
  }

  const splits = SPLITS.filter((s) => selected.some((c) => c.split === s));
  const summary: Partial<Record<Split, SplitSummary>> = {};
  for (const s of splits) summary[s] = roundSummary(summarize(perCase, s));
  const result: EvalResult = {
    tool: "eval-sort",
    version: 1,
    engine: engineId(),
    model: SORT_MODEL,
    rubric: SORT_RUBRIC,
    thresholds: { match: SORT_MATCH_THRESHOLD, fit: SORT_FIT_THRESHOLD },
    ts: new Date().toISOString(),
    split: o.split,
    cases: o.cases,
    repeat: o.repeat,
    elements: lib.items.length,
    summary,
    perCase,
    cost: {
      requests: fetched.requests,
      tokens: tokensAll,
      usd: round4(tokensAll * USD_PER_TOKEN)!,
      fresh: fetched.fresh,
      freshTokens: fetched.freshTokens,
      freshUsd: round4(fetched.freshTokens * USD_PER_TOKEN)!,
      failed: fetched.failed,
      overBudget: fetched.overBudget,
    },
  };

  const lines = [report(result, o, splits)];
  const ledger = ledgerTokens(o.cacheDir);
  lines.push(
    "",
    `requests: ${fetched.requests} unique (${fetched.requests - fetched.uncached} cached, ${fetched.fresh} fresh, ${fetched.failed} failed or skipped` +
      `${fetched.overBudget ? `, ${fetched.overBudget} over budget` : ""}) · input tokens evaluated ${tokensAll.toLocaleString("en-US")} (~$${(tokensAll * USD_PER_TOKEN).toFixed(4)}) · ` +
      `fresh this run ${fetched.freshTokens.toLocaleString("en-US")} (~$${(fetched.freshTokens * USD_PER_TOKEN).toFixed(4)}) · ledger ${ledger.toLocaleString("en-US")} (~$${(ledger * USD_PER_TOKEN).toFixed(4)})`,
  );
  const missing = perCase.filter((c) => c.status !== "ok").map((c) => c.id);
  let exitCode = 0;
  if (missing.length) {
    lines.push("", `MISSING (${missing.length}): ${missing.join(", ")}${o.offline ? " (not cached; rerun without --offline)" : " (failed or over budget; see the log above)"}`);
    exitCode = 1;
  }
  let gates: EvalRun["gates"];
  if (o.compare) {
    const base = readBaseline(o.compare);
    gates = compareRuns(perCase, base.perCase, "holdout");
    lines.push("", compareReport(gates, base, result, o.compare));
    if (gates.failed) exitCode = 1;
  }
  if (o.json) {
    fs.mkdirSync(path.dirname(o.json), { recursive: true });
    fs.writeFileSync(o.json, `${JSON.stringify(result, null, 1)}\n`);
    d.log(`wrote ${path.relative(process.cwd(), o.json) || o.json}`);
  }
  return { result, text: lines.join("\n"), exitCode, gates };
}

function roundSummary(s: SplitSummary): SplitSummary {
  const r = (x: Record<string, number | null>) => Object.fromEntries(Object.entries(x).map(([k, v]) => [k, round4(v)]));
  return { rank: r(s.rank), families: Object.fromEntries(Object.entries(s.families).map(([f, x]) => [f, r(x)])), groups: r(s.groups), missing: s.missing };
}

export function readBaseline(file: string): EvalResult {
  const b = JSON.parse(fs.readFileSync(file, "utf8")) as EvalResult;
  if (b?.tool !== "eval-sort" || !Array.isArray(b.perCase)) throw new Error(`${file} is not an eval-sort --json file`);
  return b;
}

// ---------------------------------------------------------------- reporting

const isNum = (x: unknown): x is number => typeof x === "number" && Number.isFinite(x);
const f2 = (x: number | null | undefined) => (isNum(x) ? x.toFixed(2) : "—");
const f3 = (x: number | null | undefined) => (isNum(x) ? x.toFixed(3) : "—");
const f1 = (x: number | null | undefined) => (isNum(x) ? x.toFixed(1) : "—");
const f0 = (x: number | null | undefined) => (isNum(x) ? String(Math.round(x)) : "—");
const pct = (x: number | null | undefined) => (isNum(x) ? `${(x * 100).toFixed(1)}%` : "—");
const table = (head: string[], rows: string[][]) =>
  [`| ${head.join(" | ")} |`, `|${head.map(() => "---").join("|")}|`, ...rows.map((r) => `| ${r.join(" | ")} |`)].join("\n");

function report(r: EvalResult, o: EvalOptions, splits: readonly Split[]): string {
  const out: string[] = [];
  out.push(
    `## Custom-sort eval · ${r.engine} · ${r.elements} elements · Matches ≥ ${r.thresholds.match} · fit < ${r.thresholds.fit} → Other` +
      `${o.repeat > 1 ? ` · repeat ${o.repeat}` : ""}${o.cases ? ` · cases ${o.cases.join(",")}` : ""}`,
  );
  for (const split of splits) {
    const s = r.summary[split]!;
    const cs = r.perCase.filter((c) => c.split === split);
    out.push("", `### ${split}`, "", splitTable(s, cs, o.repeat));
    if (o.verbose) out.push("", caseTables(cs), "", details(cs));
  }
  return out.join("\n");
}

function splitTable(s: SplitSummary, cases: readonly CaseResult[], repeat: number): string {
  const R = s.rank;
  const G = s.groups;
  const F = s.families;
  const rows: string[][] = [];
  if (R.cases || F.probe) {
    rows.push(["rank cases (gated)", `${f0(R.cases)}${F.probe ? ` (+${f0(F.probe.cases)} informational)` : ""}`]);
    rows.push(["AUC mean / min", `${f2(R.auc)} / ${f2(R.minAuc)}`]);
    rows.push(["P@10 · plain prompts only", `${f2(R.p10)} · ${f2(F.plain?.p10)}`]);
    rows.push(["tiers (pairwise order in graded chains)", f2(R.tier)]);
    rows.push(["clear lows in a top 10 (sum)", f0(R.low10)]);
    rows.push(["Matches P / R / F1", `${f2(R.matchP)} / ${f2(R.matchR)} / ${f2(R.matchF1)}`]);
    rows.push(["mean Matches per case · cases with 0 Matches", `${f0(R.matches)} · ${f0(R.weak)}`]);
    rows.push(["junk names in Matches · Matches tiles worded below “Clear match”", `${f0(R.junkMatches)} · ${f0(R.partial)}`]);
    const fam = (label: string, x: SplitSummary["rank"] | undefined, extra?: [string, (x: SplitSummary["rank"]) => string]) => {
      if (!x) return;
      const head = `${label} (${f0(x.cases)}): AUC mean / min · tiers · P@10 · M-F1 · #M`;
      const vals = `${f2(x.auc)} / ${f2(x.minAuc)} · ${f2(x.tier)} · ${f2(x.p10)} · ${f2(x.matchF1)} · ${f0(x.matches)}`;
      rows.push(extra ? [`${head} · ${extra[0]}`, `${vals} · ${extra[1](x)}`] : [head, vals]);
    };
    fam("plain", F.plain);
    fam("negation", F.negation, ["ρ twin / revAUC", (x) => `${f2(x.rho)} / ${f2(x.revAuc)}`]);
    fam("compound", F.compound, ["compAUC", (x) => f2(x.compAuc)]);
    fam("union “and”", F.union);
    for (const c of cases.filter((x) => x.informational && x.metrics)) {
      rows.push([`informational ${c.id}: AUC · P@10 · #M`, `${f2(c.metrics!.auc)} · ${f2(c.metrics!.p10)} · ${f0(c.metrics!.matches)}`]);
    }
  }
  if (G.cases) {
    const on = cases.filter((c) => c.kind === "groups" && c.status === "ok" && c.other).length;
    rows.push(["groups cases (Other on / closest)", `${f0(G.cases)} (${on} / ${f0((G.cases ?? 0) - on)})`]);
    rows.push(["groups label errors / labels (strict + soft)", `${f0(G.errors)} / ${f0(G.labels)}`]);
    rows.push(["accuracy, macro: all · Other on · closest", `${f3(G.accAll)} · ${f3(G.accOn)} · ${f3(G.accOff)}`]);
    rows.push(["chosen group right: strict · soft labels", `${f3(G.choiceAcc)} · ${f3(G.choiceSoft)}`]);
    rows.push(["Other P / R / F1", `${f3(G.otherP)} / ${f3(G.otherR)} / ${f3(G.otherF1)}`]);
    rows.push(["fit AUC · weak fits sink in-group (s · s×n)", `${f3(G.fitAuc)} · ${f3(G.sinkS)} · ${f3(G.sinkSN)}`]);
    rows.push(["first-listed group picked", pct(G.firstPick)]);
  }
  rows.push(["tokens / element: rank · groups k ≤ 4 · k = 8", `${f1(R.tokPerEl)} · ${f1(G.tokPerElSmall)} · ${f1(G.tokPerEl8)}`]);
  rows.push(["unparsed ids (parseChunk retry)", f0((R.unparsed ?? 0) + (G.unparsed ?? 0) + (F.probe?.unparsed ?? 0))]);
  if (repeat > 1) {
    rows.push(["repeat: rank |Δs| mean / p95 / max · elements crossing 600 per case", `${f1(R.instMean)} / ${f1(R.instP95)} / ${f0(R.instMax)} · ${f1(R.instCross)}`]);
    rows.push(["repeat: groups chosen-group / bucket flips", `${pct(G.choiceFlip)} / ${pct(G.bucketFlip)}`]);
  }
  rows.push(["missing cases", s.missing.join(", ") || "none"]);
  return table(["metric", "value"], rows);
}

function caseTables(cases: readonly CaseResult[]): string {
  const out: string[] = [];
  const rank = cases.filter((c) => c.kind === "rank" && c.metrics);
  if (rank.length) {
    out.push(
      table(
        ["rank case", "family", "AUC", "P@10", "low@10", "tiers", "M-P", "M-R", "M-F1", "#M", "ρ twin", "revAUC", "compAUC", "junk", "tok/el"],
        rank.map((c) => {
          const m = c.metrics!;
          return [c.id, c.family ?? "", f2(m.auc), f2(m.p10), f0(m.low10), f2(m.tier), f2(m.matchP), f2(m.matchR), f2(m.matchF1), f0(m.matches), f2(m.rho), f2(m.revAuc), f2(m.compAuc), f0(m.junkMatches), f1(m.tokPerEl)];
        }),
      ),
    );
  }
  const grp = cases.filter((c) => c.kind === "groups" && c.metrics);
  if (grp.length) {
    out.push(
      "",
      table(
        ["groups case", "k", "Other", "errors / labels", "acc", "choiceAcc", "Oth-P", "Oth-R", "Oth-F1", "fitAUC", "sink s", "1st pick", "Oth%", "tok/el"],
        grp.map((c) => {
          const m = c.metrics!;
          return [c.id, String(c.k), c.other ? "on" : "off", `${f0(m.errors)} / ${f0(m.labels)}`, f3(m.accAll), f3(m.choiceAcc), f3(m.otherP), f3(m.otherR), f3(m.otherF1), f3(m.fitAuc), f3(m.sinkS), pct(m.firstPick), pct(m.otherRate), f1(m.tokPerEl)];
        }),
      ),
    );
  }
  return out.join("\n");
}

function details(cases: readonly CaseResult[]): string {
  const out: string[] = [];
  for (const c of cases.filter((x) => x.detail)) {
    out.push(`**${c.id}**`);
    for (const [k, v] of Object.entries(c.detail!)) {
      out.push(`- ${k}: ${Array.isArray(v) ? v.join(", ") || "—" : Object.entries(v as Record<string, number>).map(([g, n]) => `${g} ${n}`).join(", ")}`);
    }
  }
  return out.join("\n");
}

function compareReport(g: NonNullable<EvalRun["gates"]>, base: EvalResult, run: EvalResult, file: string): string {
  const fmt = (x: number | null) => (x === null ? "—" : Number.isInteger(x) ? String(x) : Math.abs(x) >= 10 ? x.toFixed(1) : x.toFixed(3));
  const delta = (b: number | null, r: number | null) => (b === null || r === null ? "—" : `${r - b >= 0 ? "+" : ""}${fmt(Math.round((r - b) * 1e4) / 1e4)}`);
  const out = [`### --compare ${path.relative(process.cwd(), file) || file} (holdout, ${g.common} common case(s))`];
  if (base.engine !== run.engine) out.push("", `baseline engine ${base.engine}, this run ${run.engine}`);
  out.push(
    "",
    table(
      ["gate", "baseline", "run", "Δ", "limit", "result"],
      g.rows.map((r) => [r.gate, fmt(r.baseline), fmt(r.run), delta(r.baseline, r.run), r.limit, r.ok === null ? "info" : r.ok ? "ok" : `**FAIL**${r.note ? ` (${r.note})` : ""}`]),
    ),
  );
  out.push("", g.common === 0 ? "FAIL: no holdout case in common with the baseline (run with --split holdout or all)" : g.failed ? "FAIL: a holdout gate failed" : "PASS: every holdout gate holds");
  return out.join("\n");
}

// ---------------------------------------------------------------- main

async function main() {
  const o = parseArgs(process.argv.slice(2));
  if (o === "help") {
    console.log(USAGE);
    return;
  }
  // The same .env loader as scripts/jev-smoke.ts, imported here rather than at the top so that
  // importing this module (scripts/eval-sort.test.ts) never reads .env.
  await import("./lib/env.ts");
  const deps: EvalDeps = {
    fetch: (input, init) => globalThis.fetch(input, init),
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    key: () => {
      const k = process.env.TYPESAFE_API_KEY;
      if (!k) throw new Error("TYPESAFE_API_KEY is not set (expected in .env)");
      return k;
    },
    log: (line) => console.error(line),
    random: Math.random,
  };
  const run = await runEval(o, deps);
  console.log(run.text);
  if (run.exitCode) {
    await new Promise<void>((resolve) => process.stdout.write("", () => resolve()));
    process.exit(run.exitCode);
  }
}

if (isMain(import.meta.url)) runMain(main);
