import { describe, expect, it } from "vitest";
import {
  analyzeWorld,
  BROKEN_PROBLEMS,
  buildPools,
  checkDays,
  dayRange,
  GENERATOR,
  inBand,
  liveWindow,
  MIN_BANDED_POOL,
  MIN_RECOGNIZABLE_POOL,
  NO_REPEAT_DAYS,
  pickChallenges,
  repickDeadline,
  splitRepickable,
  STEP_BANDS,
  TIERS,
  type DayTargets,
  type PoolElement,
  type TierPool,
} from "./challenges.ts";
import type { GraphRecipe } from "./graph.ts";

const ids = (prefix: string, n: number) => Array.from({ length: n }, (_, i) => `${prefix}${i}`);
const pools = (easy: number, hard: number, expert: number, preferred?: ReadonlySet<string>[]): Record<"easy" | "hard" | "expert", TierPool> => ({
  easy: { candidates: ids("e", easy), preferred },
  hard: { candidates: ids("h", hard) },
  expert: { candidates: ids("x", expert) },
});

describe("pickChallenges", () => {
  const days = dayRange("2026-11-06", 400);

  it("is deterministic", () => {
    const a = pickChallenges(days, pools(300, 300, 300), new Map());
    const b = pickChallenges(days, pools(300, 300, 300), new Map());
    expect([...a]).toEqual([...b]);
  });

  it("never repeats a target within the window when the pool allows", () => {
    const out = pickChallenges(days, pools(300, 300, 300), new Map());
    const last = new Map<string, number>();
    days.forEach((d, i) => {
      for (const id of Object.values(out.get(d)!)) {
        const prev = last.get(id);
        if (prev !== undefined) expect(i - prev).toBeGreaterThanOrEqual(NO_REPEAT_DAYS);
        last.set(id, i);
      }
    });
  });

  it("spaces repeats out when the pool is smaller than the window", () => {
    const out = pickChallenges(days, pools(40, 300, 300), new Map());
    const last = new Map<string, number>();
    let minGap = Infinity;
    days.forEach((d, i) => {
      const id = out.get(d)!.easy;
      const prev = last.get(id);
      if (prev !== undefined) minGap = Math.min(minGap, i - prev);
      last.set(id, i);
    });
    expect(minGap).toBeGreaterThanOrEqual(30); // drawn from the least-recently-used quarter
  });

  it("keeps stored days and counts them (and history) toward recency", () => {
    const fixed = new Map<string, DayTargets>([["2026-11-07", { easy: "e1", hard: "h1", expert: "x1" }]]);
    const history = [{ day: "2026-11-05", targets: { easy: "e2", hard: "h2", expert: "x2" } }];
    const out = pickChallenges(days.slice(0, 100), pools(300, 300, 300), fixed, history);
    expect(out.get("2026-11-07")).toEqual(fixed.get("2026-11-07"));
    const used = [...out.values()].filter((_, i) => i !== 1).flatMap((t) => Object.values(t));
    expect(used).not.toContain("e1");
    expect(used).not.toContain("e2");
  });

  it("re-picking a single day avoids targets stored on LATER days too", () => {
    // Small easy pool, every other day stored: the re-picked day must not duplicate a target
    // that is stored a few days later (the v3 picker only looked backwards).
    const all = pickChallenges(days.slice(0, 60), pools(24, 300, 300), new Map());
    const target = "2026-11-20";
    const fixed = new Map([...all].filter(([d]) => d !== target));
    const out = pickChallenges(days.slice(0, 60), pools(24, 300, 300), fixed);
    const pick = out.get(target)!.easy;
    const n = days.indexOf(target);
    const gaps = days
      .slice(0, 60)
      .map((d, i) => (d !== target && out.get(d)!.easy === pick ? Math.abs(i - n) : Infinity));
    // Looking backwards only, the "fresh" bag would be the 10 targets first used on days 15..23,
    // i.e. a repeat within 9 days. Now it is the quarter farthest from any use.
    expect(Math.min(...gaps)).toBeGreaterThanOrEqual(10);
  });

  it("does not draw a target stored a few days later, even when it is preferred", () => {
    const fixed = new Map<string, DayTargets>([["2026-11-10", { easy: "e5", hard: "h5", expert: "x5" }]]);
    const out = pickChallenges(days.slice(0, 4), pools(300, 300, 300, [new Set(["e5"])]), fixed);
    for (const t of out.values()) expect(t.easy).not.toBe("e5");
  });

  it("prefers the preferred subset while it has fresh candidates", () => {
    const preferred = new Set(["e1", "e2", "e3"]);
    const out = pickChallenges(days.slice(0, 3), pools(300, 300, 300, [preferred]), new Map());
    expect(new Set([...out.values()].map((t) => t.easy))).toEqual(preferred);
  });

  it("walks the preference layers in order", () => {
    const first = new Set(["e1"]);
    const second = new Set(["e2", "e3", "e4"]);
    const out = pickChallenges(days.slice(0, 6), pools(300, 300, 300, [first, second]), new Map());
    const easy = [...out.values()].map((t) => t.easy);
    expect(easy[0]).toBe("e1");
    expect(new Set(easy.slice(1, 4))).toEqual(second);
    for (const id of easy.slice(4)) expect(first.has(id) || second.has(id)).toBe(false);
  });

  describe("tier ordering by steps", () => {
    // Overlapping step ranges, so unordered draws would often invert.
    const steps = new Map<string, number>([
      ...ids("e", 100).map((id, i) => [id, 1 + (i % 6)] as const),
      ...ids("h", 200).map((id, i) => [id, 2 + (i % 9)] as const),
      ...ids("x", 300).map((id, i) => [id, 3 + (i % 18)] as const),
    ]);

    it("draws hard above easy and expert above hard on every day", () => {
      const out = pickChallenges(days, pools(100, 200, 300), new Map(), [], { steps });
      for (const t of out.values()) {
        expect(steps.get(t.hard)!).toBeGreaterThan(steps.get(t.easy)!);
        expect(steps.get(t.expert)!).toBeGreaterThan(steps.get(t.hard)!);
      }
      // Unordered (no steps) the same pools do invert, so the rule is doing the work.
      const free = [...pickChallenges(days, pools(100, 200, 300), new Map()).values()];
      expect(free.some((t) => steps.get(t.expert)! <= steps.get(t.hard)! || steps.get(t.hard)! <= steps.get(t.easy)!)).toBe(true);
    });

    it("is a lower bound only: the picker itself has no step cap (STEP_BANDS live in buildPools)", () => {
      const out = pickChallenges(days, pools(100, 200, 300), new Map(), [], { steps });
      const expertSteps = [...out.values()].map((t) => steps.get(t.expert)!);
      expect(Math.max(...expertSteps)).toBe(20);
    });

    it("falls back to an unconstrained draw when no candidate is above the previous tier", () => {
      const flat = new Map<string, number>([...ids("e", 10).map((id) => [id, 9] as const), ...ids("h", 10).map((id) => [id, 5] as const), ...ids("x", 10).map((id) => [id, 12] as const)]);
      const out = pickChallenges(days.slice(0, 5), pools(10, 10, 10), new Map(), [], { steps: flat });
      expect(out.size).toBe(5);
      for (const t of out.values()) expect(flat.get(t.hard)).toBe(5);
    });

    it("leaves stored days alone", () => {
      const stored: DayTargets = { easy: "e5", hard: "h0", expert: "x0" }; // 6 > 2 > 3: inverted
      const out = pickChallenges(days.slice(0, 3), pools(100, 200, 300), new Map([["2026-11-07", stored]]), [], { steps });
      expect(out.get("2026-11-07")).toEqual(stored);
    });
  });
});

/**
 * Tiny world: starters 1..5; tier 1 = 11 (1+2), 12 (1+3); tier 2 = 20..27 (from 11+12, plus a
 * second witnessing recipe 11+11 for 20 and 21); tier 3 = 30 (20+21).
 */
function world(verdicts: Record<string, boolean | null>, names: Record<string, string> = {}) {
  const elements: PoolElement[] = [];
  const add = (id: string, isStarter = false) =>
    elements.push({ id, name: names[id] ?? `Thing ${id}`, isStarter, recognizable: verdicts[id] ?? null });
  for (const s of ["1", "2", "3", "4", "5"]) add(s, true);
  for (const id of ["11", "12", "30", ...ids("2", 8)]) add(id);
  const recipes: GraphRecipe[] = [
    { ingredients: ["1", "2"], result: "11" },
    { ingredients: ["1", "3"], result: "12" },
    ...ids("2", 8).map((id) => ({ ingredients: ["11", "12"], result: id })),
    { ingredients: ["11", "11"], result: "20" },
    { ingredients: ["11", "11"], result: "21" },
    { ingredients: ["20", "21"], result: "30" },
  ];
  return { elements, recipes };
}

const NO_RULES = { bfsTier: 2, unsafe: 0, artBlocked: 0, discoverable: null, pathRule: "off", band: null, inBand: null, bandRule: "off" } as const;

describe("buildPools", () => {
  // 20, 22, 23 recognizable; 24 not; the rest unclassified.
  const verdicts = { "20": true, "22": true, "23": true, "24": false, "11": true };

  it("draws only recognizable targets when enough exist", () => {
    const { elements, recipes } = world(verdicts);
    const { pools: p, stats } = buildPools(elements, recipes, { minRecognizable: 3 });
    expect(p.easy.candidates).toEqual(["20", "22", "23"]);
    expect(p.easy.preferred).toEqual([]);
    // No depth loaded (as in scripts/purge-elements.ts): the easy path rule is off.
    expect(stats.easy).toEqual({ ...NO_RULES, eligible: 8, recognizable: 3, notRecognizable: 1, unclassified: 4, mode: "recognizable" });
  });

  it("falls back to every eligible candidate, recognizable first, when too few are recognizable", () => {
    const { elements, recipes } = world(verdicts);
    const { pools: p, stats } = buildPools(elements, recipes, { minRecognizable: 4 });
    expect(p.easy.candidates).toEqual(ids("2", 8));
    expect(p.easy.preferred?.map((l) => [...l])).toEqual([["20", "22", "23"]]);
    expect(stats.easy.mode).toBe("fallback");
    // Hard/expert (BFS 4/6) are empty in this world: no layers, fallback.
    expect(p.hard).toEqual({ candidates: [], preferred: [] });
  });

  it("skips starters and names that fail checkName even when classified recognizable", () => {
    const { elements, recipes } = world({ ...verdicts, "25": true, "1": true }, { "25": "Fire  Water" });
    const { pools: p, stats } = buildPools(elements, recipes, { minRecognizable: 1 });
    expect(p.easy.candidates).toEqual(["20", "22", "23"]);
    expect(stats.easy.eligible).toBe(7);
  });

  it("leaves out school-unsafe names and blocked art on every tier", () => {
    const { elements, recipes } = world({ ...verdicts, "25": true, "26": true }, { "25": "Murder", "22": "Root Beer" });
    elements.find((e) => e.id === "26")!.imageStatus = "blocked";
    const { pools: p, stats } = buildPools(elements, recipes, { minRecognizable: 1 });
    expect(p.easy.candidates).toEqual(["20", "22", "23"]); // "Root Beer" is on the allowlist
    expect(stats.easy).toMatchObject({ eligible: 6, unsafe: 1, artBlocked: 1 });
  });

  it("feeds pickChallenges so every pick is recognizable", () => {
    const n = 300;
    const elements: PoolElement[] = ["1", "2", "3", "4", "5"].map((id) => ({ id, name: `Starter ${id}`, isStarter: true }));
    const recipes: GraphRecipe[] = [];
    // A chain of tiers 1..6 with n elements per tier, every other one recognizable.
    let prev = ["1", "2"];
    for (let tier = 1; tier <= 6; tier++) {
      const cur = Array.from({ length: n }, (_, i) => String(tier * 10_000 + i));
      cur.forEach((id, i) => {
        elements.push({ id, name: `Thing ${id}`, isStarter: false, recognizable: i % 2 === 0 });
        recipes.push({ ingredients: [prev[0]!, prev[1]!], result: id });
      });
      prev = cur.slice(0, 2);
    }
    const { pools: p, stats } = buildPools(elements, recipes);
    for (const t of TIERS) expect(stats[t]).toMatchObject({ eligible: n, recognizable: n / 2, mode: "recognizable" });
    const recognizable = new Set(elements.filter((e) => e.recognizable).map((e) => e.id));
    const out = pickChallenges(dayRange("2026-11-06", 200), p, new Map());
    for (const t of out.values()) for (const id of Object.values(t)) expect(recognizable.has(id)).toBe(true);
  });
});

describe("analyzeWorld paths (shallow, depth-based)", () => {
  // Starters 1..5 (depth 0); 11 = 1+2, 12 = 1+3 (depth 1); m = 11+12 is BFS tier 2 but depth 1
  // (a 3-ingredient starter recipe, not loaded, makes it in one combine); n = m+11 (depth 2).
  const el = (id: string, depth: number | null, isStarter = false): PoolElement => ({ id, name: `Thing ${id}`, isStarter, depth });
  const elements = [...["1", "2", "3", "4", "5"].map((id) => el(id, 0, true)), el("11", 1), el("12", 1), el("m", 1), el("n", 2), el("t", 2), el("s", 2)];
  const recipes: GraphRecipe[] = [
    { ingredients: ["1", "2"], result: "11" },
    { ingredients: ["1", "3"], result: "12" },
    { ingredients: ["11", "12"], result: "m" },
    { ingredients: ["11", "m"], result: "n" },
    { ingredients: ["11", "4"], result: "t" }, // path + BFS witness
    { ingredients: ["5", "m"], result: "t" }, // path (m has depth 1) but no witness (m is BFS tier 2 too)
    { ingredients: ["m", "n"], result: "t" }, // n is too deep
    { ingredients: ["1", "t"], result: "t" }, // produces itself: not a way to find it
    { ingredients: ["11", "gone"], result: "t" }, // inactive ingredient
    { ingredients: ["12", "12"], result: "s" }, // self-pair counts
    { ingredients: ["1", "2", "3"], result: "t" }, // 3 ingredients: not a 2-ingredient path
  ];

  it("counts active 2-ingredient recipes whose ingredients both have depth <= 1", () => {
    const w = analyzeWorld(elements, recipes);
    expect(w.hasDepth).toBe(true);
    expect(w.paths.get("t")).toBe(2);
    expect(w.witnesses.get("t")).toBe(1); // the BFS count misses the m shortcut
    expect(w.paths.get("s")).toBe(1);
    expect(w.paths.get("n")).toBe(1);
    expect(w.tiers.get("t")).toBe(2);
  });

  it("is off when depth is not loaded", () => {
    const w = analyzeWorld(elements.map(({ depth: _d, ...e }) => e), recipes);
    expect(w.hasDepth).toBe(false);
    expect(w.paths.size).toBe(0);
  });
});

/**
 * A realistic easy pool: 50 recognizable BFS-tier-2 candidates of which 26 have 3 shallow
 * paths and 24 have 1, plus 30 NON-recognizable candidates with 5 paths each (Nov 2026 had 26
 * of 50 passing). Shallow ingredients: starters + 20 tier-1 elements.
 */
function easyWorld() {
  const elements: PoolElement[] = ["1", "2", "3", "4", "5"].map((id) => ({ id, name: `Starter ${id}`, isStarter: true, depth: 0 }));
  const recipes: GraphRecipe[] = [];
  const starters = ["1", "2", "3", "4", "5"];
  const tier1 = Array.from({ length: 20 }, (_, i) => String(100 + i));
  tier1.forEach((id, i) => {
    elements.push({ id, name: `Base ${id}`, isStarter: false, depth: 1 });
    recipes.push({ ingredients: [starters[i % 5]!, starters[(i + 1 + Math.floor(i / 5)) % 5]!], result: id });
  });
  const shallow = [...starters, ...tier1];
  const pairs: [string, string][] = [];
  const seen = new Set<string>();
  for (const a of tier1) for (const b of shallow) {
    const key = [a, b].sort().join("+");
    if (!seen.has(key)) {
      seen.add(key);
      pairs.push([a, b]);
    }
  }
  let next = 0;
  const candidate = (id: string, recognizable: boolean, paths: number) => {
    elements.push({ id, name: `Thing ${id}`, isStarter: false, recognizable, depth: 2 });
    for (let k = 0; k < paths; k++) recipes.push({ ingredients: pairs[next++]!, result: id });
  };
  const good = Array.from({ length: 26 }, (_, i) => String(1000 + i));
  const thin = Array.from({ length: 24 }, (_, i) => String(2000 + i));
  const junk = Array.from({ length: 30 }, (_, i) => String(3000 + i));
  good.forEach((id) => candidate(id, true, 3));
  thin.forEach((id) => candidate(id, true, 1));
  junk.forEach((id) => candidate(id, false, 5));
  return { elements, recipes, good, thin, junk };
}

describe("buildPools easy path rule", () => {
  it("keeps recognizable mode although fewer than MIN_RECOGNIZABLE_POOL pass (the fallback trap)", () => {
    const { elements, recipes, good, junk } = easyWorld();
    expect(good.length).toBeLessThan(MIN_RECOGNIZABLE_POOL);
    const { pools: p, stats } = buildPools(elements, recipes);
    expect(stats.easy).toMatchObject({ eligible: 80, recognizable: 50, mode: "recognizable", discoverable: 26, pathRule: "required" });
    expect(p.easy.candidates).toEqual(good);
    // The well-connected non-recognizable names never get in.
    for (const id of junk) expect(p.easy.candidates).not.toContain(id);
    expect(p.easy.preferred).toEqual([]);
  });

  it("degrades to a preference when too few candidates pass", () => {
    const { elements, recipes, good, thin } = easyWorld();
    const { pools: p, stats } = buildPools(elements, recipes, { minDiscoverable: 30 });
    expect(stats.easy).toMatchObject({ mode: "recognizable", discoverable: 26, pathRule: "preferred" });
    expect(p.easy.candidates).toEqual([...good, ...thin]);
    expect(p.easy.preferred?.map((l) => [...l])).toEqual([good]);
  });

  it("in fallback mode requires paths on every eligible candidate, recognizable first", () => {
    const { elements, recipes, good, junk } = easyWorld();
    const { pools: p, stats } = buildPools(elements, recipes, { minRecognizable: 60 });
    expect(stats.easy).toMatchObject({ mode: "fallback", discoverable: 56, pathRule: "required" });
    expect(p.easy.candidates).toEqual([...good, ...junk]);
    expect(p.easy.preferred?.map((l) => [...l])).toEqual([good]);
  });

  it("only applies to easy", () => {
    const { stats } = buildPools(easyWorld().elements, easyWorld().recipes);
    expect(stats.hard).toMatchObject({ discoverable: null, pathRule: "off" });
  });
});

/**
 * A chain of BFS tiers 1..6 with `n` elements per tier (easy/hard/expert draw from 2/4/6), each
 * with the given current steps; recognizable unless `recognizable` says otherwise. No depth, so
 * the easy path rule is off and only the step bands are exercised.
 */
function bandWorld(
  n: number,
  steps: (bfsTier: number, i: number) => number | null | undefined,
  recognizable: (bfsTier: number, i: number) => boolean = () => true,
) {
  const elements: PoolElement[] = ["1", "2", "3", "4", "5"].map((id) => ({ id, name: `Starter ${id}`, isStarter: true }));
  const recipes: GraphRecipe[] = [];
  const at: Record<number, string[]> = {};
  let prev = ["1", "2"];
  for (let tier = 1; tier <= 6; tier++) {
    const cur = Array.from({ length: n }, (_, i) => String(tier * 10_000 + i));
    cur.forEach((id, i) => {
      const e: PoolElement = { id, name: `Thing ${id}`, isStarter: false, recognizable: recognizable(tier, i) };
      const s = steps(tier, i);
      if (s !== undefined) e.steps = s;
      elements.push(e);
      recipes.push({ ingredients: [prev[0]!, prev[1]!], result: id });
    });
    at[tier] = cur;
    prev = cur.slice(0, 2);
  }
  const stepsOf = new Map(elements.map((e) => [e.id, e.steps]));
  return { elements, recipes, at, stepsOf };
}

/** Easy 1-3 steps, hard 1-10 (every 10th unknown), expert 2-21: wide enough that unbanded draws leave the bands. */
const spread = (tier: number, i: number) => (tier === 2 ? 1 + (i % 3) : tier === 4 ? (i % 10 === 9 ? null : 1 + (i % 10)) : tier === 6 ? 2 + (i % 20) : 1);

describe("buildPools step bands (v5)", () => {
  it("are hard 3-5 and expert 6-11, easy has none, generator bfs-v5", () => {
    expect(STEP_BANDS).toEqual({ hard: [3, 5], expert: [6, 11] });
    expect(GENERATOR).toBe("bfs-v5");
    expect(MIN_BANDED_POOL).toBe(MIN_RECOGNIZABLE_POOL);
  });

  it("keeps only hard and expert targets whose current steps are inside the band", () => {
    const { elements, recipes, at, stepsOf } = bandWorld(200, spread);
    const { pools: p, stats } = buildPools(elements, recipes);
    expect(stats.hard).toMatchObject({ mode: "recognizable", recognizable: 200, band: [3, 5], inBand: 60, bandRule: "required" });
    expect(stats.expert).toMatchObject({ mode: "recognizable", recognizable: 200, band: [6, 11], inBand: 60, bandRule: "required" });
    expect(p.hard.candidates).toEqual(at[4]!.filter((id) => [3, 4, 5].includes(stepsOf.get(id)!)));
    expect(p.expert.candidates).toEqual(at[6]!.filter((id) => (stepsOf.get(id) ?? 0) >= 6 && stepsOf.get(id)! <= 11));
    expect(p.hard.preferred).toEqual([]);
    // Unknown steps are outside every band.
    for (const id of p.hard.candidates) expect(stepsOf.get(id)).not.toBeNull();
    // Easy is untouched (no band; no depth loaded, so no path rule either).
    expect(stats.easy).toMatchObject({ band: null, inBand: null, bandRule: "off" });
    expect(p.easy.candidates).toEqual(at[2]);
  });

  it("degrades to a preference layer when fewer than MIN_BANDED_POOL pass", () => {
    const few = (tier: number, i: number) => (tier === 4 ? (i < 10 ? 4 : 7) : spread(tier, i));
    const { elements, recipes, at } = bandWorld(200, few);
    const { pools: p, stats } = buildPools(elements, recipes);
    expect(stats.hard).toMatchObject({ inBand: 10, bandRule: "preferred" });
    expect(p.hard.candidates).toEqual(at[4]); // the tier never runs dry
    expect(p.hard.preferred?.map((l) => [...l])).toEqual([at[4]!.slice(0, 10)]);
    expect(stats.expert.bandRule).toBe("required"); // decided per tier
    // The picker draws the 10 in-band targets first, then (all used inside the window) the rest.
    const out = [...pickChallenges(dayRange("2026-11-06", 12), p, new Map()).values()].map((t) => t.hard);
    expect(new Set(out.slice(0, 10))).toEqual(new Set(at[4]!.slice(0, 10)));
    for (const id of out.slice(10)) expect(at[4]!.slice(0, 10)).not.toContain(id);
  });

  it("in fallback mode keeps in-band targets only, recognizable ones first", () => {
    const { elements, recipes, at, stepsOf } = bandWorld(200, spread, (tier, i) => tier !== 4 || i % 2 === 0);
    const { pools: p, stats } = buildPools(elements, recipes, { minRecognizable: 150 });
    expect(stats.hard).toMatchObject({ mode: "fallback", recognizable: 100, inBand: 60, bandRule: "required" });
    const band = at[4]!.filter((id) => inBand(stepsOf.get(id), [3, 5]));
    expect(p.hard.candidates).toEqual(band);
    expect(p.hard.preferred?.map((l) => [...l])).toEqual([band.filter((id) => Number(id) % 2 === 0)]);
  });

  it("can be widened per tier, and is off when steps are not loaded (scripts/purge-elements.ts)", () => {
    const { elements, recipes } = bandWorld(200, spread);
    const wide = buildPools(elements, recipes, { stepBands: { hard: [3, 6] } });
    expect(wide.stats.hard).toMatchObject({ band: [3, 6], inBand: 80, bandRule: "required" });
    expect(wide.stats.expert).toMatchObject({ band: null, bandRule: "off" });
    const noSteps = bandWorld(200, () => undefined);
    const off = buildPools(noSteps.elements, noSteps.recipes);
    for (const t of TIERS) expect(off.stats[t]).toMatchObject({ band: null, inBand: null, bandRule: "off" });
    expect(off.pools.hard.candidates).toEqual(noSteps.at[4]);
  });

  it("feeds pickChallenges: every day in band and strictly ordered easy < hard < expert", () => {
    const { elements, recipes, stepsOf } = bandWorld(500, spread);
    const { pools: p, stats } = buildPools(elements, recipes);
    expect(stats.hard.inBand).toBe(150); // >= NO_REPEAT_DAYS: no repeats inside the window either
    const days = dayRange("2026-11-25", 400);
    const out = pickChallenges(days, p, new Map(), [], { steps: stepsOf });
    const s = (id: string) => stepsOf.get(id)!;
    for (const t of out.values()) {
      expect(inBand(s(t.hard), STEP_BANDS.hard)).toBe(true);
      expect(inBand(s(t.expert), STEP_BANDS.expert)).toBe(true);
      expect(s(t.hard)).toBeGreaterThan(s(t.easy));
      expect(s(t.expert)).toBeGreaterThan(s(t.hard));
    }
    // 3-step easy days exist, and the floor lifts their hard to 4-5 (3 is inside the band).
    const threeStep = [...out.values()].filter((t) => s(t.easy) === 3);
    expect(threeStep.length).toBeGreaterThan(0);
    for (const t of threeStep) expect(s(t.hard)).toBeGreaterThanOrEqual(4);
    expect([...out.values()].some((t) => s(t.hard) === 3)).toBe(true);
    const last = new Map<string, number>();
    days.forEach((d, i) => {
      for (const id of [out.get(d)!.hard, out.get(d)!.expert]) {
        const prev = last.get(id);
        if (prev !== undefined) expect(i - prev).toBeGreaterThanOrEqual(NO_REPEAT_DAYS);
        last.set(id, i);
      }
    });
  });
});

/**
 * Every rule at once, for the generator -> checker round trip: depth (easy path rule on), steps
 * (bands and tier order on), school-unsafe names and blocked art. BFS tiers 1..6; easy (tier 2)
 * has 40 targets with 3 shallow paths and 20 with 1, steps 2 or 3; hard (4) and expert (6) have
 * `n` targets each with steps from `hardSteps` / `spread`, plus one unsafe name and one blocked
 * image per tier, both in band.
 */
function fullWorld(n: number, hardSteps: (i: number) => number | null = (i) => spread(4, i)) {
  const elements: PoolElement[] = ["1", "2", "3", "4", "5"].map((id) => ({ id, name: `Starter ${id}`, isStarter: true, depth: 0, steps: 0 }));
  const recipes: GraphRecipe[] = [];
  const add = (id: string, depth: number, steps: number | null, from: [string, string][], extra: Partial<PoolElement> = {}) => {
    elements.push({ id, name: `Thing ${id}`, isStarter: false, recognizable: true, depth, steps, ...extra });
    for (const ingredients of from) recipes.push({ ingredients, result: id });
  };
  const t1 = Array.from({ length: 20 }, (_, i) => String(100 + i));
  t1.forEach((id, i) => add(id, 1, 1, [[String((i % 5) + 1), String(((i + 1 + Math.floor(i / 5)) % 5) + 1)]]));
  const t1Pairs: [string, string][] = [];
  for (let a = 0; a < t1.length; a++) for (let b = a + 1; b < t1.length; b++) t1Pairs.push([t1[a]!, t1[b]!]);
  let next = 0;
  const easy = Array.from({ length: 60 }, (_, i) => String(1000 + i));
  easy.forEach((id, i) => add(id, 2, 2 + (i % 2), Array.from({ length: i < 40 ? 3 : 1 }, () => t1Pairs[next++]!)));
  const chain = (prev: string[], start: number, depth: number, count: number, steps: (i: number) => number | null) => {
    const ids = Array.from({ length: count }, (_, i) => String(start + i));
    ids.forEach((id, i) => add(id, depth, steps(i), [[prev[0]!, prev[1]!]]));
    return ids;
  };
  const t3 = chain(easy, 3000, 3, 4, () => 3);
  const hard = chain(t3, 40_000, 4, n, hardSteps);
  add("49001", 4, 4, [[t3[0]!, t3[1]!]], { name: "Rifle" });
  add("49002", 4, 4, [[t3[0]!, t3[1]!]], { imageStatus: "blocked" });
  const t5 = chain(hard, 5000, 5, 4, () => 6);
  const expert = chain(t5, 60_000, 6, n, (i) => spread(6, i));
  add("69001", 6, 8, [[t5[0]!, t5[1]!]], { name: "Cutlass" });
  add("69002", 6, 8, [[t5[0]!, t5[1]!]], { imageStatus: "blocked" });
  return { elements, recipes, easy, hard, expert, stepsOf: new Map(elements.map((e) => [e.id, e.steps])) };
}

describe("generator -> checker round trip (no endless --fix re-picks)", () => {
  const generated = (w: ReturnType<typeof fullWorld>, days: string[]) => {
    const { pools: p, stats } = buildPools(w.elements, w.recipes);
    const out = pickChallenges(days, p, new Map(), [], { steps: w.stepsOf });
    const rows = days.map((day) => ({ day, source: "generated", targets: out.get(day)! }));
    return { stats, rows, issues: checkDays(rows, analyzeWorld(w.elements, w.recipes)) };
  };

  it("checkDays finds nothing broken in what buildPools + pickChallenges produce", () => {
    const w = fullWorld(500);
    const { stats, rows, issues } = generated(w, dayRange("2026-11-25", 400));
    expect(stats.easy).toMatchObject({ mode: "recognizable", pathRule: "required", discoverable: 40 });
    expect(stats.hard).toMatchObject({ mode: "recognizable", bandRule: "required", inBand: 150, unsafe: 1, artBlocked: 1 });
    expect(stats.expert).toMatchObject({ mode: "recognizable", bandRule: "required", inBand: 150, unsafe: 1, artBlocked: 1 });
    expect(issues.filter((i) => BROKEN_PROBLEMS.has(i.problem))).toEqual([]);
    expect(issues).toEqual([]); // no drift or recognizability warnings either
    // The rules are actually exercised: 3-step easy days exist (their hard is lifted to 4-5).
    expect(rows.some((r) => w.stepsOf.get(r.targets.easy) === 3)).toBe(true);
  });

  it("a band that degrades to a preference never hides an out-of-band day from the checker", () => {
    // Only 10 hards inside 3-5 (< MIN_BANDED_POOL): the rest are 7 steps.
    const w = fullWorld(500, (i) => (i < 10 ? 4 : 7));
    const { stats, rows, issues } = generated(w, dayRange("2026-11-25", 60));
    expect(stats.hard).toMatchObject({ bandRule: "preferred", inBand: 10 }); // the unsafe / blocked stand-ins are not counted
    const outOfBand = rows.filter((r) => !inBand(w.stepsOf.get(r.targets.hard), STEP_BANDS.hard)).map((r) => r.day);
    expect(outOfBand.length).toBeGreaterThan(0);
    const flagged = issues.filter((i) => i.tier === "hard" && i.problem === "step-band").map((i) => i.day);
    expect(flagged).toEqual(outOfBand);
    // Unsafe names and blocked art stay out even of a degraded pool.
    expect(issues.filter((i) => i.problem === "unsafe" || i.problem === "art-blocked")).toEqual([]);
  });
});

describe("checkDays", () => {
  const { elements, recipes, good, thin } = easyWorld();
  // Hard/expert stand-ins at other tiers: checkDays reports drift for them, which is a warning.
  const extra: PoolElement[] = [
    { id: "h1", name: "Glacier", isStarter: false, recognizable: true, steps: 5 },
    { id: "h2", name: "Rifle", isStarter: false, recognizable: true, steps: 4 },
    { id: "h3", name: "Lighthouse", isStarter: false, recognizable: true, steps: 3 },
    { id: "h4", name: "Igloo", isStarter: false, recognizable: true, steps: 6 },
    { id: "x1", name: "Raichu", isStarter: false, recognizable: true, steps: 9, imageStatus: "blocked" },
    { id: "x2", name: "Fire Elemental", isStarter: false, recognizable: true, steps: 4 },
    { id: "x3", name: "Castle", isStarter: false, recognizable: true, steps: 8 },
    { id: "x4", name: "Mahjong", isStarter: false, recognizable: true, steps: 17 },
    { id: "x5", name: "Pottery", isStarter: false, recognizable: true, steps: null },
  ];
  // Easy candidates have 2 steps, except good[2] (3).
  const all = [...elements.map((e) => ({ ...e, steps: e.id === good[2] ? 3 : e.depth === 2 ? 2 : 1 })), ...extra];
  // Reachable (BFS tier 1, so "tier-drift" warnings only) via starter self-pairs.
  const reach: GraphRecipe[] = extra.map((e, i) => ({ ingredients: [String((i % 5) + 1), String((i % 5) + 1)], result: e.id }));
  const w = analyzeWorld(all, [...recipes, ...reach]);
  const day = (d: string, easy: string, hard: string, expert: string) => ({ day: d, source: "generated", targets: { easy, hard, expert } });
  const rows = [
    day("2026-12-01", good[0]!, "h1", "x2"), // expert 4: below its band, and <= hard 5
    day("2026-12-02", thin[0]!, "h2", "x1"), // 1 path; unsafe hard; blocked expert
    day("2026-12-03", good[1]!, "gone", "x3"), // inactive hard (no tier-order: steps unknown)
    day("2026-12-04", good[2]!, "h3", "x3"), // hard 3 <= easy 3, both inside their bands
    day("2026-12-05", good[3]!, "h4", "x4"), // hard 6 and expert 17: outside their bands
    day("2026-12-06", good[4]!, "h1", "x5"), // expert steps unknown
    day("2026-12-07", good[5]!, "h3", "x3"), // clean: 2 < 3 < 8
  ];
  const issues = checkDays(rows, w);
  const of = (d: string) => issues.filter((i) => i.day === d && BROKEN_PROBLEMS.has(i.problem)).map((i) => `${i.tier}:${i.problem}`);

  it("flags the v4 and v5 rules as broken", () => {
    expect(of("2026-12-01")).toEqual(["expert:step-band", "expert:tier-order"]);
    expect(of("2026-12-02")).toEqual(["easy:undiscoverable", "hard:unsafe", "expert:art-blocked"]);
    expect(of("2026-12-03")).toEqual(["hard:inactive"]);
    expect(of("2026-12-04")).toEqual(["hard:tier-order"]);
    expect(of("2026-12-05")).toEqual(["hard:step-band", "expert:step-band"]);
    expect(of("2026-12-06")).toEqual(["expert:step-band"]);
    expect(of("2026-12-07")).toEqual([]);
  });

  it("counts step-band as broken, so --fix re-picks those days", () => {
    expect(BROKEN_PROBLEMS.has("step-band")).toBe(true);
    // Band edges are inclusive: hard 3 and 5, expert 6 and 11 pass.
    const edges = analyzeWorld(
      [...all, { id: "x6", name: "Castle Six", isStarter: false, steps: 6 }, { id: "x11", name: "Castle Eleven", isStarter: false, steps: 11 }],
      [...recipes, ...reach, { ingredients: ["1", "1"], result: "x6" }, { ingredients: ["2", "2"], result: "x11" }],
    );
    const edgeIssues = checkDays([day("2026-12-08", good[0]!, "h3", "x6"), day("2026-12-09", good[0]!, "h1", "x11")], edges);
    expect(edgeIssues.filter((i) => i.problem === "step-band")).toEqual([]);
  });

  it("skips the band check when steps are not loaded", () => {
    const bare = analyzeWorld(
      all.map(({ steps: _s, ...e }) => e),
      [...recipes, ...reach],
    );
    expect(bare.hasSteps).toBe(false);
    expect(checkDays(rows, bare).filter((i) => i.problem === "step-band" || i.problem === "tier-order")).toEqual([]);
  });

  it("keeps drift and recognizability as warnings", () => {
    expect(BROKEN_PROBLEMS.has("tier-drift")).toBe(false);
    expect(BROKEN_PROBLEMS.has("not-recognizable")).toBe(false);
    expect(issues.some((i) => i.problem === "tier-drift")).toBe(true);
  });

  it("explains the problem", () => {
    expect(issues.find((i) => i.problem === "undiscoverable")!.detail).toBe("1 shallow path(s), need 3");
    expect(issues.find((i) => i.problem === "unsafe")!.detail).toBe('violence: "Rifle"');
    expect(issues.find((i) => i.problem === "tier-order")!.detail).toBe("expert 4 step(s) <= hard 5");
    const band = issues.filter((i) => i.problem === "step-band").map((i) => `${i.day} ${i.tier}: ${i.detail}`);
    expect(band).toEqual([
      "2026-12-01 expert: 4 step(s), band 6-11",
      "2026-12-05 hard: 6 step(s), band 3-5",
      "2026-12-05 expert: 17 step(s), band 6-11",
      "2026-12-06 expert: steps unknown, band 6-11",
    ]);
  });
});

describe("live window and the re-pick guard", () => {
  it("freezes through the day after the last live day (the teaser day)", () => {
    expect(liveWindow(new Date("2026-11-22T09:59:59Z"))).toEqual({ firstLive: "2026-11-21", lastLive: "2026-11-22", frozenThrough: "2026-11-23" });
    expect(liveWindow(new Date("2026-11-22T10:00:00Z"))).toEqual({ firstLive: "2026-11-21", lastLive: "2026-11-23", frozenThrough: "2026-11-24" });
    expect(liveWindow(new Date("2026-11-22T12:00:00Z")).firstLive).toBe("2026-11-22");
  });

  it("a day freezes exactly at D-2 10:00 UTC", () => {
    const d = "2026-12-02";
    expect(repickDeadline(d).toISOString()).toBe("2026-11-30T10:00:00.000Z");
    expect(splitRepickable([d], new Date("2026-11-30T09:59:59Z")).fixable).toEqual([d]);
    expect(splitRepickable([d], new Date("2026-11-30T10:00:00Z")).frozen).toEqual([d]);
    // Same boundary for every day of a year, including month/year ends.
    for (const day of dayRange("2026-11-01", 400)) {
      const t = repickDeadline(day).getTime();
      expect(liveWindow(new Date(t - 1)).frozenThrough < day).toBe(true);
      expect(liveWindow(new Date(t)).frozenThrough >= day).toBe(true);
    }
  });

  it("never offers today, the live window or tomorrow's teaser for a re-pick", () => {
    const now = new Date("2026-11-22T15:00:00Z"); // UTC+14 is already on 11-23
    const { fixable, frozen } = splitRepickable(dayRange("2026-11-21", 6), now);
    expect(frozen).toEqual(["2026-11-21", "2026-11-22", "2026-11-23", "2026-11-24"]);
    expect(fixable).toEqual(["2026-11-25", "2026-11-26"]);
  });
});
