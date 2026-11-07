import { describe, expect, it } from "vitest";
import { addDays, isPlausibleClientDay, utcDay } from "../../src/shared/dates.ts";
import type { TierPool } from "./challenges.ts";
import { computeDepthSteps } from "./graph.ts";
import {
  brokenFutureDays,
  challengeWindow,
  checkVerdicts,
  computePurge,
  depthStepsUpdates,
  liveRecipes,
  madeFromIndex,
  makeRunId,
  MAX_REASON_CHARS,
  neverPurge,
  newlyBroken,
  parseVerdictFile,
  recipeLabel,
  RUN_ID_RE,
  type ChallengeDay,
  type PurgeElement,
  type PurgeRecipe,
} from "./purge.ts";

// ---------------------------------------------------------------- a small synthetic world

/** Numeric string ids (the code sorts ids as INT8), interned by name. */
const ids = new Map<string, string>();
const id = (name: string) => {
  let v = ids.get(name);
  if (!v) ids.set(name, (v = String(100 + ids.size)));
  return v;
};
const nameById = (x: string) => [...ids].find(([, v]) => v === x)?.[0];

const STARTERS = ["earth", "water", "air", "fire", "time"];
let rid = 0;
const r = (ings: string[], result: string, isProtected = false): PurgeRecipe => ({
  id: String(9000 + ++rid),
  ingredients: ings.map(id),
  result: id(result),
  protected: isProtected,
});

const recipes: PurgeRecipe[] = [
  r(["water", "fire"], "steam"), // 9001
  r(["earth", "water"], "mud"), // 9002
  r(["steam", "mud"], "junk"), // 9003  junk: the direct purge
  r(["junk", "fire"], "leafA"), // 9004  only via junk -> orphan
  r(["leafA", "water"], "leafB"), // 9005  only via leafA -> orphan (cascade)
  r(["junk", "earth"], "shared"), // 9006  shared also has a junk-free recipe
  r(["mud", "air"], "shared"), // 9007
  r(["junk", "air"], "fancy"), // 9008  cheap route through junk
  r(["mud", "fire"], "brick"), // 9009
  r(["brick", "steam"], "wall"), // 9010
  r(["wall", "air"], "fancy"), // 9011  expensive junk-free route: depth/steps go up
  r(["ghost", "fire"], "spook"), // 9012  ghost is not active: spook was already unreachable
  r(["leafA", "air"], "target"), // 9013  target is a challenge target, only via leafA
  r(["target", "water"], "downstream"), // 9014  only via target
  r(["steam", "steam"], "cloud", true), // 9015  protected
  r(["junk", "spook"], "weird"), // 9016  never reachable
];
const activeNames = [...STARTERS, "steam", "mud", "junk", "leafA", "leafB", "shared", "fancy", "brick", "wall", "spook", "target", "downstream", "cloud", "weird", "lonely"];
// Stored depth/steps = the true values before the purge (so only purge-caused changes show up).
const truth = computeDepthSteps(
  STARTERS.map(id),
  liveRecipes(recipes, new Set(activeNames.map(id))),
);
const elements: PurgeElement[] = activeNames.map((n) => ({
  id: id(n),
  name: n,
  isStarter: STARTERS.includes(n),
  depth: truth.depth.value.get(id(n)) ?? null,
  steps: truth.steps.value.get(id(n)) ?? null,
}));
const recipeId = (ings: string[], result: string) =>
  recipes.find((x) => x.result === id(result) && x.ingredients.join() === ings.map(id).join())!.id;

describe("computePurge (leaf cascade)", () => {
  const protect = new Set([...STARTERS.map(id), id("target"), id("steam"), id("cloud")]);
  const e = computePurge({ elements, recipes, direct: [id("junk"), id("earth"), id("cloud"), id("nope")], protect });

  it("purges the direct set minus never-purge and inactive ids", () => {
    expect(e.direct).toEqual([id("junk")]);
    expect(e.skipped).toEqual(
      expect.arrayContaining([
        { id: id("earth"), why: "never-purge" },
        { id: id("cloud"), why: "never-purge" },
        { id: id("nope"), why: "not-active" },
      ]),
    );
  });

  it("orphans what was reachable only through purged elements, until stable", () => {
    expect(e.orphans.map(nameById).sort()).toEqual(["downstream", "leafA", "leafB"]);
    expect(e.rounds).toBe(2);
    expect([...e.removed].map(nameById).sort()).toEqual(["downstream", "junk", "leafA", "leafB"]);
  });

  it("with cascade off, keeps survivors active but marks them unreachable", () => {
    const nc = computePurge({ elements, recipes, direct: [id("junk")], protect, cascade: false });
    expect(nc.orphans).toEqual([]);
    expect([...nc.removed].map(nameById)).toEqual(["junk"]);
    const nulls = nc.updates.filter((u) => u.depth === null).map((u) => nameById(u.id)).sort();
    expect(nulls).toEqual(["downstream", "leafA", "leafB"]);
    expect(nc.updates.filter((u) => u.depth === null).every((u) => u.steps === null)).toBe(true);
  });

  it("leaves elements that were already unreachable alone", () => {
    for (const n of ["spook", "weird", "lonely"]) expect(e.removed.has(id(n))).toBe(false);
    expect(e.unreachableBefore).toBe(3);
    expect(e.updates.some((u) => [id("spook"), id("weird"), id("lonely")].includes(u.id))).toBe(false);
  });

  it("never orphans protected elements but reports them", () => {
    expect(e.removed.has(id("target"))).toBe(false);
    expect(e.collisions).toEqual([id("target")]);
  });

  it("keeps elements with another route and recomputes their depth/steps", () => {
    expect(e.removed.has(id("shared"))).toBe(false);
    expect(e.removed.has(id("fancy"))).toBe(false);
    // fancy: junk + air (depth 3, steps 4) -> wall + air (depth 4, steps 5).
    expect(truth.depth.value.get(id("fancy"))).toBe(3);
    expect(e.updates).toEqual([{ id: id("fancy"), depth: 4, steps: 5 }]);
    expect(e.reachableBefore - e.reachableAfter).toBe(5); // junk, leafA, leafB, target, downstream
  });

  it("quarantines recipes by result (unless protected) and by ingredient", () => {
    expect(e.recipesByResult.map((x) => x.id).sort()).toEqual(
      [recipeId(["steam", "mud"], "junk"), recipeId(["junk", "fire"], "leafA"), recipeId(["leafA", "water"], "leafB"), recipeId(["target", "water"], "downstream")].sort(),
    );
    expect(e.recipesByIngredient.map((x) => x.id).sort()).toEqual(
      [recipeId(["junk", "earth"], "shared"), recipeId(["junk", "air"], "fancy"), recipeId(["leafA", "air"], "target"), recipeId(["junk", "spook"], "weird")].sort(),
    );
    expect(e.protectedHits).toEqual([]);
  });

  it("reports protected recipes that touch a removed element instead of quarantining them", () => {
    const withBadProtection = recipes.map((x) => (x.result === id("leafB") ? { ...x, protected: true } : x));
    const out = computePurge({ elements, recipes: withBadProtection, direct: [id("junk")], protect });
    expect(out.protectedHits.map((x) => x.result)).toEqual([id("leafB")]);
    expect(out.recipesByResult.some((x) => x.result === id("leafB"))).toBe(false);
  });

  it("is a no-op for an empty purge set", () => {
    const out = computePurge({ elements, recipes, direct: [], protect });
    expect(out.removed.size).toBe(0);
    expect(out.updates).toEqual([]);
    expect(out.recipesByResult.length + out.recipesByIngredient.length).toBe(0);
  });
});

describe("depthStepsUpdates", () => {
  it("writes only reachable elements whose stored values differ", () => {
    const stale = elements.map((x) => (x.name === "mud" ? { ...x, depth: 7, steps: 7 } : x.name === "spook" ? { ...x, depth: 2, steps: 2 } : x));
    const graph = liveRecipes(recipes, new Set(activeNames.map(id)));
    const { depth, steps } = computeDepthSteps(STARTERS.map(id), graph);
    // mud is fixed; spook (unreachable, stale depth) is left as it is.
    expect(depthStepsUpdates(stale, depth, steps)).toEqual([{ id: id("mud"), depth: 1, steps: 1 }]);
  });
});

describe("neverPurge", () => {
  const day = (d: string, easy: string, hard: string, expert: string, source = "generated"): ChallengeDay => ({
    day: d,
    source,
    targets: { easy: id(easy), hard: id(hard), expert: id(expert) },
  });
  const graph = liveRecipes(recipes, new Set(activeNames.map(id)));
  const metrics = computeDepthSteps(STARTERS.map(id), graph);
  const set = neverPurge({
    elements,
    recipes,
    challenges: [day("2026-01-01", "lonely", "spook", "weird", "legacy"), day("2026-11-06", "leafB", "shared", "brick"), day("2026-12-01", "fancy", "wall", "mud")],
    window: { first: "2026-11-06", last: "2026-11-07" },
    graph,
    metrics,
  });
  const kinds = (n: string) => set.get(id(n)) ?? [];

  it("covers starters, every challenge target, live derivations and protected recipes", () => {
    expect(kinds("earth")).toContain("starter");
    for (const n of ["lonely", "spook", "weird", "leafB", "shared", "brick", "fancy", "wall", "mud"]) expect(kinds(n)).toContain("challenge-target");
    // Today's leafB = junk + fire -> leafA, + water: the whole derivation is protected.
    for (const n of ["leafA", "junk", "steam", "mud"]) expect(kinds(n)).toContain("live-path");
    expect(kinds("cloud")).toContain("protected-recipe");
    expect(kinds("steam")).toContain("protected-recipe");
    // A future day's derivations are not protected (that day is re-picked if it breaks).
    expect(kinds("wall")).not.toContain("live-path");
    expect(set.has(id("downstream"))).toBe(false);
  });

  it("makes today's targets survive a purge of their path", () => {
    const e = computePurge({ elements, recipes, direct: [id("junk")], protect: set });
    expect(e.direct).toEqual([]);
    expect(e.skipped).toEqual([{ id: id("junk"), why: "never-purge" }]);
  });
});

describe("challengeWindow", () => {
  it("contains every day that is today somewhere, plus a margin", () => {
    expect(challengeWindow(new Date("2026-11-06T12:00:00Z"))).toEqual({ first: "2026-11-06", last: "2026-11-07" });
    expect(challengeWindow(new Date("2026-11-06T09:00:00Z"))).toEqual({ first: "2026-11-05", last: "2026-11-07" });
    // 08:30 UTC: UTC+14 is still on the 6th, but within the 2 h margin of the 7th.
    expect(challengeWindow(new Date("2026-11-06T08:30:00Z")).last).toBe("2026-11-07");
    expect(challengeWindow(new Date("2026-11-06T07:59:00Z")).last).toBe("2026-11-06");
    for (let h = 0; h < 48; h += 0.5) {
      const now = new Date(Date.parse("2026-11-06T00:00:00Z") + h * 3_600_000);
      const w = challengeWindow(now);
      for (let k = -3; k <= 3; k++) {
        const d = addDays(utcDay(now), k);
        if (isPlausibleClientDay(d, now)) expect(d >= w.first && d <= w.last).toBe(true);
      }
    }
  });
});

describe("brokenFutureDays", () => {
  const pools = {
    easy: { candidates: ["1", "2"] },
    hard: { candidates: ["3", "4"] },
    expert: { candidates: ["5", "6"] },
  } as Record<"easy" | "hard" | "expert", TierPool>;
  const active = new Set(["1", "2", "3", "4", "5", "6", "7"]);
  const d = (day: string, easy: string, hard: string, expert: string, source = "generated"): ChallengeDay => ({ day, source, targets: { easy, hard, expert } });

  it("flags generated days after the cutoff with an inactive or out-of-pool target", () => {
    const out = brokenFutureDays(
      [
        d("2026-11-07", "9", "9", "9"), // not after the cutoff: never touched
        d("2026-11-09", "1", "3", "5"), // fine
        d("2026-11-08", "8", "3", "7"), // 8 inactive, 7 active but not in the expert pool
        d("2026-11-10", "9", "9", "9", "legacy"), // not generated
      ],
      "2026-11-07",
      active,
      pools,
    );
    expect(out).toEqual([
      {
        day: "2026-11-08",
        tiers: [
          { tier: "easy", id: "8", why: "inactive" },
          { tier: "expert", id: "7", why: "out-of-pool" },
        ],
      },
    ]);
  });
});

describe("newlyBroken", () => {
  it("keeps only tiers the purge broke", () => {
    const before = [{ day: "2026-12-01", tiers: [{ tier: "hard" as const, id: "3", why: "out-of-pool" as const }] }];
    const after = [
      { day: "2026-12-01", tiers: [{ tier: "hard" as const, id: "3", why: "out-of-pool" as const }] }, // drift, not the purge
      { day: "2026-12-02", tiers: [{ tier: "easy" as const, id: "1", why: "out-of-pool" as const }] },
    ];
    expect(newlyBroken(before, after)).toEqual([after[1]]);
    expect(newlyBroken([], after)).toEqual(after);
  });
});

describe("export helpers", () => {
  it("labels the cheapest recipe, else any active one", () => {
    const active = new Set(activeNames.map(id));
    const graph = liveRecipes(recipes, active);
    const { steps } = computeDepthSteps(STARTERS.map(id), graph);
    const made = madeFromIndex(recipes, graph, steps, active);
    expect(recipeLabel(made.get(id("fancy"))!, nameById)).toBe("junk + air");
    expect(recipeLabel(made.get(id("spook"))!, nameById)).toBe("ghost + fire"); // ghost is inactive: fallback recipe
    expect(recipeLabel(made.get(id("spook"))!, () => undefined)).toBe(`#${id("ghost")} + #${id("fire")}`);
    expect(recipeLabel(made.get(id("weird"))!, nameById)).toBe("junk + spook");
    expect(made.has(id("lonely"))).toBe(false);
  });

  it("makes run ids", () => {
    expect(makeRunId(new Date("2026-11-06T15:30:05Z"))).toBe("purge-20261106-153005");
    expect(RUN_ID_RE.test(makeRunId())).toBe(true);
  });
});

// ---------------------------------------------------------------- verdicts

describe("parseVerdictFile", () => {
  it("accepts a JSON array, normalizes verdicts and truncates reasons", () => {
    const res = parseVerdictFile(
      JSON.stringify([
        { id: "1083333177628557313", verdict: "Purge", reason: "garbled  compound" },
        { id: " 1083333177628557314 ", verdict: "keep" },
        { id: "1083333177628557315", verdict: "purge", reason: "x".repeat(500), name: "Foo", depth: 3 },
      ]),
    );
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.items).toEqual([
      { id: "1083333177628557313", verdict: "purge", reason: "garbled compound" },
      { id: "1083333177628557314", verdict: "keep", reason: "" },
      { id: "1083333177628557315", verdict: "purge", reason: "x".repeat(MAX_REASON_CHARS), name: "Foo" },
    ]);
  });

  it("accepts JSON Lines and a BOM", () => {
    const res = parseVerdictFile('﻿{"id":"11","verdict":"keep","reason":"ok"}\n\n{"id":"12","verdict":"purge","reason":"junk"}\n');
    expect(res.ok && res.items.map((i) => i.id)).toEqual(["11", "12"]);
  });

  it("merges exact duplicates with a warning", () => {
    const res = parseVerdictFile('[{"id":"11","verdict":"keep"},{"id":"11","verdict":"keep"}]');
    expect(res.ok && res.items.length).toBe(1);
    expect(res.ok && res.warnings.length).toBe(1);
  });

  it("rejects malformed input with every problem listed", () => {
    const res = parseVerdictFile(
      JSON.stringify([
        { id: 1083333177628557313, verdict: "purge" },
        { id: "abc", verdict: "purge" },
        { id: "13", verdict: "delete" },
        { id: "14", verdict: "purge", reason: 5 },
        "15",
        { id: "16", verdict: "keep" },
        { id: "16", verdict: "purge" },
      ]),
    );
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.errors).toHaveLength(6);
    expect(res.errors[0]).toMatch(/JSON number; write it as a string/);
    expect(res.errors[1]).toMatch(/string of digits/);
    expect(res.errors[2]).toMatch(/"purge" or "keep"/);
    expect(res.errors[3]).toMatch(/reason must be a string/);
    expect(res.errors[4]).toMatch(/must be an object/);
    expect(res.errors[5]).toMatch(/twice with different verdicts/);
  });

  it("rejects non-arrays, empty input and broken JSON", () => {
    for (const bad of ["", "[]", '{"verdicts":[]}', "[{]", "null"]) {
      const res = parseVerdictFile(bad);
      expect(res.ok, bad).toBe(false);
    }
  });
});

describe("checkVerdicts", () => {
  const db = new Map([
    ["11", { name: "Doublepanoramajungle", status: "active" }],
    ["12", { name: "Rain Forest", status: "active" }],
    ["13", { name: "Spam", status: "quarantined" }],
  ]);
  const item = (id: string, verdict: "purge" | "keep" = "purge", name?: string) => ({ id, verdict, reason: "", ...(name ? { name } : {}) });

  it("accepts active ids and near-identical echoed names", () => {
    expect(checkVerdicts([item("11", "purge", "Double Panorama Jungle"), item("12", "keep", "Rain Forrest")], { pass: "review", elements: db, batch: 1 })).toEqual([]);
  });

  it("rejects unknown, inactive, misnamed and out-of-batch ids", () => {
    const errs = checkVerdicts([item("99"), item("13"), item("11", "purge", "Volcano"), item("12")], {
      pass: "review",
      elements: db,
      batch: 2,
      batchIds: new Set(["11", "13", "99"]),
    });
    expect(errs).toHaveLength(4);
    expect(errs[0]).toMatch(/no element has this id/);
    expect(errs[1]).toMatch(/not active/);
    expect(errs[2]).toMatch(/copied wrong/);
    expect(errs[3]).toMatch(/not in batch 2/);
  });

  it("verify only accepts ids the review marked purge", () => {
    const errs = checkVerdicts([item("11", "keep"), item("12", "purge")], { pass: "verify", elements: db, batch: 1, reviewPurge: new Set(["11"]) });
    expect(errs).toHaveLength(1);
    expect(errs[0]).toMatch(/^id 12 .*review verdict/);
  });
});
