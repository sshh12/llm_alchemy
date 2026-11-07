import { describe, expect, it } from "vitest";
import { buildPools, dayRange, NO_REPEAT_DAYS, pickChallenges, TIERS, type DayTargets, type PoolElement, type TierPool } from "./challenges.ts";
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

describe("buildPools", () => {
  // 20, 22, 23 recognizable; 24 not; the rest unclassified.
  const verdicts = { "20": true, "22": true, "23": true, "24": false, "11": true };

  it("draws only recognizable targets when enough exist, keeping the well-connected preference", () => {
    const { elements, recipes } = world(verdicts);
    const { pools: p, stats } = buildPools(elements, recipes, { minRecognizable: 3 });
    expect(p.easy.candidates).toEqual(["20", "22", "23"]);
    expect(p.easy.preferred?.map((l) => [...l])).toEqual([["20"]]); // 21 is well-connected but unclassified
    expect(stats.easy).toEqual({ bfsTier: 2, eligible: 8, recognizable: 3, notRecognizable: 1, unclassified: 4, mode: "recognizable" });
  });

  it("falls back to every eligible candidate, recognizable first, when too few are recognizable", () => {
    const { elements, recipes } = world(verdicts);
    const { pools: p, stats } = buildPools(elements, recipes, { minRecognizable: 4 });
    expect(p.easy.candidates).toEqual(ids("2", 8));
    expect(p.easy.preferred?.map((l) => [...l])).toEqual([["20"], ["20", "22", "23"], ["20", "21"]]);
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
