// Offline checks for the custom-sort eval: label sanity for scripts/eval-sort.cases.json, the
// hand-computed metric fixtures from the local eval's metrics-selftest, and the runner
// (scripts/eval-sort.ts) against a stub fetch. Nothing here touches the network or .env: the
// live eval is `npm run eval:sort`, deliberately not a *.test.ts.
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SortScore, SortSpec } from "../src/shared/api.ts";
import { normalizeSpec } from "../src/shared/sortSpec.ts";
import { packChunks, parseChunk, questionsFor, requestBody, SORT_MODEL } from "../server/ai/jev.ts";
import { CASES_FILE, cacheKey, parseArgs, runEval, type EvalDeps, type EvalOptions } from "./eval-sort.ts";
import {
  auc,
  clientOrder,
  compareRuns,
  firstListed,
  GATES,
  groupsCaseMetrics,
  libraryOf,
  matchBucket,
  precisionAtK,
  rankCaseMetrics,
  rankOrder,
  spearman,
  specOf,
  summarize,
  tierAcc,
  validateCases,
  type CaseResult,
  type EvalCases,
  type GroupsCase,
  type RankCase,
} from "./lib/evalMetrics.ts";

const DATA = JSON.parse(fs.readFileSync(CASES_FILE, "utf8")) as EvalCases;
const clone = (): EvalCases => structuredClone(DATA);
const close = (a: number | null | undefined, b: number, eps = 1e-9) => {
  expect(a).not.toBeNull();
  expect(Math.abs((a as number) - b)).toBeLessThan(eps);
};
const M = (o: Record<string, number>) => new Map(Object.entries(o));

// ---------------------------------------------------------------- labels

describe("eval-sort.cases.json", () => {
  it("is the 286-element set with 52 rank and 10 groups cases (1,073 groups labels)", () => {
    expect(DATA.version).toBe(1);
    expect(DATA.model).toBe(SORT_MODEL);
    expect(DATA.elements).toHaveLength(286);
    expect(DATA.rank).toHaveLength(52);
    expect(DATA.groups).toHaveLength(10);
    const split = (cs: { split: string }[], s: string) => cs.filter((c) => c.split === s).length;
    expect([split(DATA.rank, "tune"), split(DATA.rank, "holdout")]).toEqual([28, 24]);
    expect([split(DATA.groups, "tune"), split(DATA.groups, "holdout")]).toEqual([5, 5]);
    const labels = (s: string) =>
      DATA.groups.filter((c) => c.split === s).reduce((n, c) => n + Object.keys(c.expected).length + Object.keys(c.accept).length, 0);
    expect([labels("tune"), labels("holdout")]).toEqual([588, 485]);
  });

  it("passes validateCases", () => {
    expect(validateCases(DATA)).toEqual([]);
  });

  it("labels only known elements, never one element as both high and low", () => {
    const names = new Set(DATA.elements.map((e) => e.name));
    for (const c of DATA.rank) {
      for (const n of [...c.high, ...c.low, ...(c.tiers ?? []).flat()]) expect(names.has(n), `${c.id}: ${n}`).toBe(true);
      expect(c.high.filter((n) => c.low.includes(n)), c.id).toEqual([]);
    }
    for (const c of DATA.groups) for (const n of [...Object.keys(c.expected), ...Object.keys(c.accept)]) expect(names.has(n), `${c.id}: ${n}`).toBe(true);
  });

  it("labels every groups element with one of its groups, or Other when Other is on", () => {
    for (const c of DATA.groups) {
      const ok = (g: string) => (g === "Other" ? c.other : c.groups.includes(g));
      for (const [n, g] of Object.entries(c.expected)) expect(ok(g), `${c.id}: ${n} → ${g}`).toBe(true);
      for (const [n, gs] of Object.entries(c.accept)) {
        expect(gs.length, `${c.id}: ${n}`).toBeGreaterThan(0);
        for (const g of gs) expect(ok(g), `${c.id}: ${n} accepts ${g}`).toBe(true);
      }
    }
  });

  it("asks exactly the specs production would send (normalizeSpec leaves them unchanged)", () => {
    for (const c of [...DATA.rank, ...DATA.groups]) {
      const spec = specOf(c);
      expect(normalizeSpec(spec), c.id).toEqual({ ok: true, spec });
    }
  });

  it("keeps informational status to the probe cases, and dependencies to rank cases", () => {
    const rankIds = new Set(DATA.rank.map((c) => c.id));
    for (const c of DATA.rank) {
      expect(!!c.informational, c.id).toBe(c.category.startsWith("probe"));
      for (const d of [c.pair_with, ...(c.components ?? [])].filter((x) => x !== undefined)) expect(rankIds.has(d!), `${c.id} → ${d}`).toBe(true);
    }
  });

  it("validateCases reports broken labels", () => {
    const bad = clone();
    bad.rank[0]!.high.push("Not An Element");
    bad.rank[1]!.low.push(bad.rank[1]!.high[0]!);
    bad.rank[2]!.prompt = "  most   dangerous ";
    bad.rank[3]!.pair_with = "nope";
    const closest = bad.groups.find((c) => !c.other)!;
    closest.expected[Object.keys(closest.expected)[0]!] = "Other";
    bad.groups[0]!.expected[Object.keys(bad.groups[0]!.expected)[0]!] = "Plants";
    bad.groups[0]!.accept[Object.keys(bad.groups[0]!.accept)[0]!] = [];
    bad.elements.push({ ...bad.elements[0]!, id: "1" });
    const problems = validateCases(bad).join("\n");
    expect(problems).toContain('unknown element "Not An Element"');
    expect(problems).toContain("both high and low");
    expect(problems).toContain(`${bad.rank[2]!.id}: spec is not normalized`);
    expect(problems).toContain("unknown rank dependency nope");
    expect(problems).toContain("(Other is off)");
    expect(problems).toContain('"Plants" is not a group');
    expect(problems).toContain("empty soft label");
    expect(problems).toContain("duplicate element name");
  });
});

// ---------------------------------------------------------------- metrics (hand-computed)

describe("metrics", () => {
  it("auc counts ties as 0.5 and skips unscored ids", () => {
    const s = M({ a: 900, b: 500, c: 100, d: 500 });
    close(auc(s, ["a", "b"], ["c", "d"]), 3.5 / 4); // a>c, a>d, b>c, b=d
    close(auc(s, ["c"], ["a"]), 0);
    expect(auc(s, ["zz"], ["a"])).toBeNull();
  });

  it("tierAcc is pairwise within low → high chains", () => {
    const s = M({ x: 100, y: 300, z: 200, p: 5, q: 5 });
    close(tierAcc(s, [["x", "y", "z"]]), 2 / 3); // x<y ok, x<z ok, y<z wrong
    close(tierAcc(s, [["x", "y", "z"], ["p", "q"]]), 2.5 / 4);
  });

  it("spearman uses average ranks", () => {
    close(spearman([1, 2, 3, 4], [40, 30, 20, 10]), -1);
    close(spearman([1, 2, 3, 4], [1, 2, 3, 4]), 1);
    close(spearman([1, 1, 2, 2], [1, 1, 2, 2]), 1);
    expect(spearman([1, 2], [2, 1])).toBeNull();
  });

  it("matchBucket: precision and recall over labels, #Matches over everything", () => {
    const s = M({ a: 900, b: 500, c: 700, d: 100, u: 650 });
    const r = matchBucket(s, ["a", "b"], ["c", "d"], 600);
    close(r.P, 0.5);
    close(r.R, 0.5);
    close(r.F1, 0.5);
    expect(r.matches).toBe(3); // a, c, u
    expect(matchBucket(s, ["b"], ["d"], 600).F1).toBe(0); // nothing labeled in the bucket
  });

  it("orders like the client grid: s descending, then name", () => {
    const names = new Map([["1", "Banana"], ["2", "apple"], ["3", "Cherry"]]);
    const order = rankOrder(M({ 1: 500, 2: 500, 3: 900 }), names);
    expect(order).toEqual(["3", "2", "1"]);
    close(precisionAtK(order, ["3", "1"]), 0.5); // k = min(10, |high|) = 2: top 2 = 3, 2
    // groups: by group slot, then s, then fit, then name; Other (fit < 500) after the real groups.
    const spec: SortSpec = { kind: "groups", groups: ["A", "B"] };
    const res = new Map<string, SortScore>([
      ["1", { g: 1, s: 900, n: 900 }],
      ["2", { g: 0, s: 900, n: 700 }],
      ["3", { g: 0, s: 900, n: 800 }],
      ["4", { g: 0, s: 900, n: 100 }],
    ]);
    const n4 = new Map([...names, ["4", "Date"]]);
    expect(clientOrder(spec, res, n4)).toEqual(["3", "2", "1", "4"]);
    expect(clientOrder(spec, res, n4, false)).toEqual(["3", "2", "4", "1"]);
  });

  it("the option listed first is fnv1a(id) % k, and None of these groups is always last", () => {
    const spec: SortSpec = { kind: "groups", groups: ["A", "B", "C"] };
    for (const e of DATA.elements.slice(0, 40)) {
      const crit = (questionsFor(spec, e, 0).c0 as { criteria: Record<string, string> }).criteria;
      const keys = Object.keys(crit);
      expect(keys[0]).toBe(`g${firstListed(e.id, 3)}`);
      expect(keys.at(-1)).toBe("gx");
    }
  });

  it("parses with the real r2 parseChunk (rank levels; groups None → closest real group, fit discounted)", () => {
    const chunk = [{ id: "1", name: "X" }];
    const rank = (score: unknown) => parseChunk({ kind: "rank", prompt: "x" }, chunk, { r0: { score } }).scored.get("1")?.s ?? null;
    expect([rank(2), rank(4), rank(0), rank(2.37)]).toEqual([500, 1000, 0, 593]);
    expect([rank(4.0001), rank(-0.1), rank(Number.NaN), rank("3")]).toEqual([null, null, null, null]);
    const spec: SortSpec = { kind: "groups", groups: ["A", "B", "C"] };
    const grp = (c: unknown, noul: unknown) => parseChunk(spec, chunk, { c0: c, n0: { noul } });
    expect(grp({ choice: "g1", probabilities: { g0: 0.1, g1: 0.7, g2: 0.1, gx: 0.1 } }, 0.3).scored.get("1")).toEqual({ s: 700, g: 1, n: 270 });
    expect(grp({ choice: "gx", probabilities: { g0: 0.2, g1: 0.1, g2: 0.05, gx: 0.65 } }, 0.9).scored.get("1")).toEqual({ s: 200, g: 0, n: 315 });
    expect(grp({ choice: "g1", probabilities: { g0: 0.1, g1: 0.8, g2: 0.1 } }, 0.5).retry).toEqual(["1"]); // no gx probability
    expect(grp({ choice: "g2", confidence: 0.55 }, 0.9).retry).toEqual(["1"]); // no confidence fallback
  });

  // Tiny library for the case-level functions.
  const els = ["Ghost", "Bat", "Puppy", "Bread", "Rock", "Blorbo", "Cake"].map((name, i) => ({ id: String(i + 1), name, cat: name === "Blorbo" ? "junk" : "x" }));
  const lib = libraryOf(els);
  const id = (name: string) => lib.byName.get(name)!.id;
  const byName = (o: Record<string, number>) => new Map(Object.entries(o).map(([n, s]) => [id(n), s]));

  it("rankCaseMetrics: negation twin rho / revAUC, junk in Matches, lows in the top 10", () => {
    const c: RankCase = { id: "t", split: "tune", category: "negation", prompt: "least spooky", high: ["Puppy", "Bread"], low: ["Ghost", "Bat"], pair_with: "spooky" };
    const score = byName({ Ghost: 50, Bat: 200, Puppy: 900, Bread: 800, Rock: 600, Blorbo: 650 });
    const twin = byName({ Ghost: 1000, Bat: 700, Puppy: 0, Bread: 100, Rock: 300, Blorbo: 200 });
    const { m, detail } = rankCaseMetrics(c, score, lib, new Map([["spooky", twin]]));
    close(m.auc, 1);
    close(m.rho, -1);
    close(m.revAuc, 1);
    close(m.p10, 1);
    expect(m.matches).toBe(4);
    expect(m.junkMatches).toBe(1);
    expect(m.low10).toBe(2); // 6 elements: both lows are in the "top 10"
    expect(m.partial).toBe(0); // 600 and 650 read at least "Clear match" (levelLabel)
    expect(detail.top[0]).toBe("Puppy 900");
  });

  it("rankCaseMetrics: compound AUC is the geometric mean of the component cases", () => {
    const c: RankCase = { id: "t", split: "tune", category: "compound", prompt: "spooky and small", high: ["Bat"], low: ["Ghost", "Bread"], components: ["spooky", "small"] };
    const score = byName({ Ghost: 500, Bat: 500, Bread: 100 });
    const spooky = byName({ Ghost: 1000, Bat: 800, Bread: 0 });
    const small = byName({ Ghost: 100, Bat: 900, Bread: 900 });
    const { m } = rankCaseMetrics(c, score, lib, new Map([["spooky", spooky], ["small", small]]));
    close(m.auc, 0.75); // Bat = Ghost (0.5), Bat > Bread (1)
    close(m.compAuc, 1); // √(800·900) ≈ 849 beats √(1000·100) ≈ 316 and √(1·900) = 30
    expect(m.rho).toBeUndefined();
  });

  it("groupsCaseMetrics: Other by the fit threshold, Other P/R, soft labels, unscored labels are errors", () => {
    const c: GroupsCase = {
      id: "g", split: "tune", category: "groups-other", other: true, groups: ["Animals", "Food"],
      expected: { Bat: "Animals", Bread: "Food", Rock: "Other", Blorbo: "Other" },
      accept: { Puppy: ["Animals", "Other"], Cake: ["Food"] },
    };
    const res = new Map<string, SortScore>([
      [id("Bat"), { g: 0, s: 900, n: 800 }], // Animals, right
      [id("Bread"), { g: 1, s: 900, n: 400 }], // fit < 500 → Other, wrong
      [id("Rock"), { g: 1, s: 500, n: 100 }], // Other, right
      [id("Blorbo"), { g: 0, s: 500, n: 600 }], // Animals, wrong
      [id("Puppy"), { g: 1, s: 600, n: 300 }], // Other: an accepted soft label
      // Cake is not scored: a soft label that counts as an error
    ]);
    const { m, detail } = groupsCaseMetrics(c, res, lib);
    expect([m.labels, m.labeled, m.correct, m.errors]).toEqual([6, 5, 3, 3]);
    close(m.accAll, 0.5);
    close(m.accStrict, 0.5);
    close(m.accSoft, 1);
    close(m.choiceAcc, 1); // Bat g0, Bread g1
    close(m.otherP, 0.5); // Rock right, Bread wrong
    close(m.otherR, 0.5); // Rock found, Blorbo missed
    close(m.otherRate, 3 / 5);
    // Gold Others that chose the same group as a member: Blorbo (s 500) under Bat (s 900) in Animals; Rock (500) under Bread (900) in Food.
    close(m.sinkS, 1);
    close(m.fitAuc, 0.75); // members 800, 400 vs Others 100, 600
    expect(detail.counts).toEqual({ Animals: 2, Other: 3 });
    expect(detail.wrong).toHaveLength(3);
  });

  it("groupsCaseMetrics with Other off: every element keeps its closest group", () => {
    const c: GroupsCase = { id: "g", split: "tune", category: "groups-closest", other: false, groups: ["Animals", "Food"], expected: { Bread: "Food" }, accept: {} };
    const { m } = groupsCaseMetrics(c, new Map([[id("Bread"), { g: 1, s: 900, n: 10 }]]), lib);
    expect(m.errors).toBe(0);
    expect(m.otherP).toBeUndefined();
  });
});

// ---------------------------------------------------------------- summaries and gates

const rankResult = (id: string, m: Record<string, number | null>, extra: Partial<CaseResult> = {}): CaseResult => ({
  id, split: "holdout", kind: "rank", category: "quality", family: "plain", status: "ok", metrics: { auc: 1, p10: 0.8, matchF1: 1, tokPerEl: 92, ...m }, ...extra,
});
const groupsResult = (id: string, m: Record<string, number | null>): CaseResult => ({
  id, split: "holdout", kind: "groups", category: "groups-other", k: 3, other: true, status: "ok", metrics: { errors: 2, labels: 100, accAll: 0.98, tokPerEl: 150, ...m },
});
const BASE = [rankResult("a", {}), rankResult("b", { auc: 0.95, p10: 0.6 }), rankResult("p", { auc: 1, p10: 1 }, { informational: true, family: "probe" }), groupsResult("g", {})];
const failing = (run: CaseResult[]) => compareRuns(run, BASE).rows.filter((r) => r.ok === false).map((r) => r.gate);

describe("summaries and --compare gates", () => {
  it("summarize leaves informational cases out of the gated rank numbers", () => {
    const s = summarize(BASE, "holdout");
    expect(s.rank.cases).toBe(2);
    close(s.rank.p10, 0.7);
    expect(s.families.probe?.cases).toBe(1);
    expect(s.groups.errors).toBe(2);
  });

  it("passes an identical run and fails nothing", () => {
    const r = compareRuns(BASE, BASE);
    expect(r.failed).toBe(false);
    expect(r.common).toBe(4);
  });

  it(`fails a rank case losing more than ${GATES.aucDrop} AUC (not an informational one)`, () => {
    expect(failing([rankResult("a", { auc: 0.97 }), ...BASE.slice(1)])).toEqual(["rank AUC, worst case"]);
    expect(failing([rankResult("a", { auc: 0.981 }), ...BASE.slice(1)])).toEqual([]);
    expect(failing([...BASE.slice(0, 2), rankResult("p", { auc: 0.5, p10: 1 }, { informational: true, family: "probe" }), BASE[3]!])).toEqual([]);
  });

  it(`fails a mean P@10 drop over ${GATES.p10Drop} and a Matches-F1 drop over ${GATES.matchF1Drop}`, () => {
    expect(failing([rankResult("a", { p10: 0.68 }), ...BASE.slice(1)])).toEqual(["rank mean P@10"]); // mean 0.70 → 0.64
    expect(failing([rankResult("a", { p10: 0.71 }), ...BASE.slice(1)])).toEqual([]); // mean 0.70 → 0.655
    expect(failing([rankResult("a", { matchF1: 0.92 }), ...BASE.slice(1)])).toEqual(["rank mean Matches F1"]); // 1.00 → 0.96
  });

  it(`fails groups errors rising by more than ${GATES.errorsRise}, and tokens per element rising over 10%`, () => {
    expect(failing([...BASE.slice(0, 3), groupsResult("g", { errors: 6 })])).toEqual(["groups label errors"]);
    expect(failing([...BASE.slice(0, 3), groupsResult("g", { errors: 5 })])).toEqual([]);
    expect(failing([...BASE.slice(0, 3), groupsResult("g", { tokPerEl: 166 })])).toEqual(["groups tokens / element"]);
    expect(failing([rankResult("a", { tokPerEl: 112 }), ...BASE.slice(1)])).toEqual(["rank tokens / element"]); // mean 92 → 102
  });

  it("fails a selected case missing from the run, and a run with nothing in common", () => {
    const missing: CaseResult = { id: "a", split: "holdout", kind: "rank", category: "quality", family: "plain", status: "missing" };
    expect(failing([missing, ...BASE.slice(1)])).toEqual(["selected cases missing from the run"]);
    expect(compareRuns([{ ...BASE[0]!, split: "tune" }], BASE).failed).toBe(true);
  });
});

// ---------------------------------------------------------------- the runner, offline

const KEY = "sk-test-EVAL-SORT-SECRET";
type Q = { type: string; instructions: Record<string, unknown>; criteria?: Record<string, string> | string[] };

/** A Jev-shaped reply built from the gold labels: metrics should come out perfect. */
function oracle(body: string) {
  const { questions } = JSON.parse(body) as { questions: Record<string, Q> };
  const qs = Object.values(questions);
  const prompt = qs.find((q) => q.type === "score")?.instructions.sort_description;
  const groups = qs.find((q) => q.type === "noul")?.instructions.groups;
  const rc = prompt !== undefined ? DATA.rank.find((c) => c.prompt === prompt) : undefined;
  const gc = groups !== undefined ? DATA.groups.find((c) => JSON.stringify(c.groups) === JSON.stringify(groups)) : undefined;
  const answers: Record<string, unknown> = {};
  for (const [qid, q] of Object.entries(questions)) {
    const name = q.instructions.element as string;
    if (q.type === "score") answers[qid] = { type: "score", score: rc!.high.includes(name) ? 4 : rc!.low.includes(name) ? 0 : 2, confidence: 0.8 };
    else {
      const gold = gc!.expected[name] ?? gc!.accept[name]?.[0];
      if (q.type === "choice") {
        const keys = Object.keys(q.criteria as Record<string, string>);
        const pick = keys.find((k) => k !== "gx" && (q.criteria as Record<string, string>)[k] === gold) ?? "gx";
        answers[qid] = { type: "choice", choice: pick, probabilities: Object.fromEntries(keys.map((k) => [k, k === pick ? 0.91 : 0.09 / (keys.length - 1)])) };
      } else answers[qid] = { type: "noul", noul: gold === "Other" || gold === undefined ? 0.1 : 0.95 };
    }
  }
  return { model: SORT_MODEL, answers, usage: { input_tokens: Math.ceil(body.length / 3), output_tokens: 1 } };
}

const reply = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  new Response(typeof body === "string" ? body : JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });

describe("runner (stub fetch, temp cache: never the network)", () => {
  let dir: string;
  let logs: string[];
  const opts = (over: Partial<EvalOptions> = {}): EvalOptions => ({ ...(parseArgs([]) as EvalOptions), split: "all", cacheDir: path.join(dir, "cache"), ...over });
  const deps = (fetch: (url: string, init?: RequestInit) => Promise<Response>, over: Partial<EvalDeps> = {}) => {
    const f = vi.fn(fetch);
    const d: EvalDeps = { fetch: f as unknown as typeof globalThis.fetch, sleep: vi.fn(async () => {}), key: () => KEY, log: (l) => logs.push(l), random: () => 0, ...over };
    return { d, f };
  };
  const answerAll = async (_url: string, init?: RequestInit) => reply(200, oracle(String(init?.body)));
  const filesText = () =>
    fs.existsSync(path.join(dir, "cache")) ? fs.readdirSync(path.join(dir, "cache")).map((f) => fs.readFileSync(path.join(dir, "cache", f), "utf8")).join("\n") : "";
  // coldest needs its twin hottest; edible-but-dangerous needs edible and most-dangerous (tune).
  const CASES = ["coldest", "edible-but-dangerous", "g-heroes-villains"];

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "eval-sort-test-"));
    logs = [];
  });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  it("offline with an empty cache: no fetch, no key, every case missing, exit 1", async () => {
    const key = vi.fn(() => KEY);
    const { d, f } = deps(answerAll, { key });
    const run = await runEval(opts({ offline: true, cases: CASES }), d);
    expect(f).not.toHaveBeenCalled();
    expect(key).not.toHaveBeenCalled();
    expect(run.exitCode).toBe(1);
    expect(run.result.perCase.map((c) => c.status)).toEqual(["missing", "missing", "missing"]);
    expect(fs.existsSync(path.join(dir, "cache"))).toBe(false);
  });

  it("sends production's exact requests, caches them by sha256(body), then reruns offline for free", async () => {
    const { d, f } = deps(answerAll);
    const run = await runEval(opts({ cases: CASES }), d);
    expect(run.exitCode).toBe(0);
    // The bodies are packChunks + requestBody for every needed case (dependencies included), once each.
    const items = libraryOf(DATA.elements).items;
    const needed = ["coldest", "hottest", "edible-but-dangerous", "edible", "most-dangerous", "g-heroes-villains"];
    const want = needed.flatMap((cid) => {
      const spec = specOf([...DATA.rank, ...DATA.groups].find((c) => c.id === cid)!);
      return packChunks(spec, items).map((ch) => requestBody(spec, ch));
    });
    const sent = f.mock.calls.map((call) => String(call[1]?.body));
    expect(new Set(sent)).toEqual(new Set(want));
    expect(sent).toHaveLength(want.length);
    for (const b of want) {
      expect(cacheKey(b)).toBe(crypto.createHash("sha256").update(b).digest("hex"));
      expect(fs.existsSync(path.join(dir, "cache", `${cacheKey(b)}.json`))).toBe(true);
    }
    const ledger = fs.readFileSync(path.join(dir, "cache", "ledger.jsonl"), "utf8").trim().split("\n");
    expect(ledger).toHaveLength(want.length);
    // Gold-label answers score perfectly.
    const [coldest, compound, heroes] = run.result.perCase;
    expect(coldest!.metrics).toMatchObject({ auc: 1, p10: 1, matchF1: 1, rho: -1, unparsed: 0 });
    expect(compound!.metrics).toMatchObject({ auc: 1, p10: 1 });
    expect(compound!.metrics!.compAuc).toBeTypeOf("number"); // from its components' (oracle) scores
    expect(heroes!.metrics).toMatchObject({ errors: 0, accAll: 1, unparsed: 0, requests: 2 });
    expect(run.result.summary.holdout?.groups.errors).toBe(0);
    expect(run.result.cost).toMatchObject({ fresh: want.length, failed: 0 });
    // The key appears nowhere: not in the report, the log, the cache or the ledger.
    expect([run.text, ...logs, filesText()].join("\n")).not.toContain(KEY);

    const again = deps(async () => {
      throw new Error("network");
    });
    const rerun = await runEval(opts({ cases: CASES, offline: true }), again.d);
    expect(again.f).not.toHaveBeenCalled();
    expect(rerun.result.perCase).toEqual(run.result.perCase);
  });

  it("salts the cache key per repeat and reports stability", async () => {
    const { d, f } = deps(answerAll);
    const run = await runEval(opts({ cases: ["g-heroes-villains"], repeat: 2 }), d);
    expect(f).toHaveBeenCalledTimes(4); // 2 requests × 2 repeats, same bodies
    const body = String(f.mock.calls[0]![1]?.body);
    expect(cacheKey(body, 1)).toBe(crypto.createHash("sha256").update(`${body}\n#rep=1`).digest("hex"));
    expect(run.result.perCase[0]!.metrics).toMatchObject({ choiceFlip: 0, bucketFlip: 0, errors: 0 });
  });

  it("retries a 429 after its retry-after, and records the attempts", async () => {
    let first = true;
    const sleep = vi.fn(async () => {});
    const { d } = deps(
      async (url, init) => {
        if (first) {
          first = false;
          return reply(429, { error: "rate_limited" }, { "retry-after": "2" });
        }
        return answerAll(url, init);
      },
      { sleep },
    );
    const run = await runEval(opts({ cases: ["hottest"] }), d);
    expect(run.exitCode).toBe(0);
    expect(sleep).toHaveBeenCalledWith(2000);
    const ledger = JSON.parse(fs.readFileSync(path.join(dir, "cache", "ledger.jsonl"), "utf8").trim()) as { attempts: number };
    expect(ledger.attempts).toBe(2);
  });

  it("does not retry a 401, scrubs the key from the error, and reports the case missing", async () => {
    const { d, f } = deps(async () => reply(401, `invalid key ${KEY}`));
    const run = await runEval(opts({ cases: ["hottest"] }), d);
    expect(f).toHaveBeenCalledTimes(1);
    expect(run.exitCode).toBe(1);
    expect(run.result.perCase[0]!.status).toBe("missing");
    expect(logs.join("\n")).toContain("[redacted]");
    expect([run.text, ...logs, filesText()].join("\n")).not.toContain(KEY);
  });

  it("refuses to start calls past --budget-usd", async () => {
    const { d, f } = deps(answerAll);
    const run = await runEval(opts({ cases: ["hottest"], budgetUsd: 0.0001 }), d);
    expect(f).not.toHaveBeenCalled();
    expect(run.result.cost.overBudget).toBe(1);
    expect(run.exitCode).toBe(1);
  });

  it("keeps at most 4 requests in flight", async () => {
    let active = 0;
    let peak = 0;
    const { d, f } = deps(async (url, init) => {
      active++;
      peak = Math.max(peak, active);
      await new Promise((r) => setTimeout(r, 5));
      active--;
      return answerAll(url, init);
    });
    await runEval(opts({ split: "holdout", cases: ["cutest", "most-magical", "hottest", "oldest", "ocean", "alive", "edible"] }), d);
    expect(f).toHaveBeenCalledTimes(7);
    expect(peak).toBe(4);
  });

  it("--json writes the baseline format, and --compare passes the same run and exits 1 on a regression", async () => {
    const baseline = path.join(dir, "baseline.json");
    const { d } = deps(answerAll);
    await runEval(opts({ split: "holdout", cases: ["cutest", "g-heroes-villains"], json: baseline }), d);
    const same = await runEval(opts({ split: "holdout", cases: ["cutest", "g-heroes-villains"], offline: true, compare: baseline }), deps(answerAll).d);
    expect(same.gates?.failed).toBe(false);
    expect(same.exitCode).toBe(0);
    expect(same.text).toContain("PASS");
    // A worse model: every cutest answer is "somewhat", so P@10, Matches-F1 and AUC collapse.
    const worse = deps(async (_url, init) => {
      const o = oracle(String(init?.body));
      for (const a of Object.values(o.answers) as { type: string; score?: number }[]) if (a.type === "score") a.score = 2;
      return reply(200, o);
    });
    const bad = await runEval(opts({ split: "holdout", cases: ["cutest"], cacheDir: path.join(dir, "worse"), compare: baseline }), worse.d);
    expect(bad.exitCode).toBe(1);
    expect(bad.gates?.rows.filter((r) => r.ok === false).map((r) => r.gate)).toEqual(["rank AUC, worst case", "rank mean P@10", "rank mean Matches F1"]);
  });

  it("parseArgs: defaults, split from --cases, and bad values", () => {
    expect(parseArgs([])).toMatchObject({ split: "tune", repeat: 1, budgetUsd: 0.1, offline: false, cases: null });
    expect(parseArgs(["--cases", "a,b"])).toMatchObject({ split: "all", cases: ["a", "b"] });
    expect(parseArgs(["--help"])).toBe("help");
    expect(() => parseArgs(["--split", "dev"])).toThrow(/--split/);
    expect(() => parseArgs(["--repeat", "0"])).toThrow(/--repeat/);
    expect(() => parseArgs(["--budget-usd", "-1"])).toThrow(/--budget-usd/);
    expect(() => parseArgs(["--json"])).toThrow(/needs a value/);
    expect(() => parseArgs(["--bogus"])).toThrow(/unknown argument/);
  });
});
