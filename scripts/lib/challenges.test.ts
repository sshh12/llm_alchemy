import { describe, expect, it } from "vitest";
import { addDays } from "../../src/shared/dates.ts";
import { checkName } from "../../src/shared/names.ts";
import { armFor, BANDS, dayType, MIN_POOL, namedHoliday } from "./challengeModel.ts";
import {
  analyzeWorld,
  APPLY_CHECKS,
  BROKEN_PROBLEMS,
  brokenDays,
  buildCandidates,
  buildPools,
  checkDays,
  dayRange,
  drawWeight,
  featuresOf,
  GENERATOR,
  hardFailures,
  liveWindow,
  makeContext,
  NO_REPEAT_DAYS,
  planDays,
  preV6Targets,
  repickDeadline,
  splitRepickable,
  stableDraw,
  TIERS,
  twinNear,
  VARIETY_DAYS,
  type ChallengeTags,
  type DayTargets,
  type PlannedRow,
  type PoolElement,
  type StoredRow,
} from "./challenges.ts";
import type { GraphRecipe } from "./graph.ts";
import type { Reach } from "./reach.ts";

// ---------------------------------------------------------------- synthetic world

const CONS = "bdfgklmnprtvz";
const VOW = "aeiou";
const syl = (n: number) => CONS[n % 13]! + VOW[Math.floor(n / 13) % 5]!;
/** Unique pronounceable one-word names that pass checkName and share no twin key. */
function names(n: number): string[] {
  const out: string[] = [];
  for (let i = 0; out.length < n; i++) {
    const s = `${syl(i % 65)}${syl(Math.floor(i / 65) % 65)}${syl((i * 7 + 11) % 65)}`;
    const name = s[0]!.toUpperCase() + s.slice(1);
    if (checkName(name).ok) out.push(name);
  }
  return out;
}

interface Spec {
  id?: string;
  name?: string;
  steps: number;
  reach: number;
  art?: string;
  /** null = no emoji. */
  emoji?: string | null;
  recognizable?: boolean | null;
  tags?: ChallengeTags;
  /** One near-optimal recipe only (fails the aha floor). */
  single?: boolean;
}

const PROV = { configHash: "test", gitSha: "test", classifierVersion: "kid-test", pickedAt: "2026-11-23T00:00:00.000Z", worldAsOf: "2026-11-23" };

function makeWorld(specs: Spec[], extraRecipes: GraphRecipe[] = []) {
  const nm = names(specs.length);
  const elements: PoolElement[] = ["Water", "Fire", "Earth", "Air", "Time"].map((name, i) => ({ id: String(i + 1), name, isStarter: true, steps: 0, recognizable: null, imageStatus: "ready" }));
  const reach = new Map<string, number>();
  const recipes: GraphRecipe[] = [...extraRecipes];
  specs.forEach((s, i) => {
    const id = s.id ?? String(1000 + i);
    elements.push({
      id,
      name: s.name ?? nm[i]!,
      isStarter: false,
      steps: s.steps,
      depth: Math.min(s.steps, 3),
      recognizable: s.recognizable === undefined ? true : s.recognizable,
      imageStatus: s.art ?? "ready",
      emoji: s.emoji === undefined ? `:e${i}:` : s.emoji,
      notable: false,
      tags: s.tags ?? null,
    });
    reach.set(id, s.reach);
    // Two near-optimal recipes each, so every element passes the aha floor (C12).
    recipes.push({ ingredients: ["1", "2"], result: id });
    if (!s.single) recipes.push({ ingredients: ["3", "4"], result: id });
  });
  const r: Reach = { asOf: "2026-11-23T00:00:00.000Z", mode: "r1", cohortN: 1000, cohortN7: 500, reach, reach7: reach, owners: new Map([...reach].map(([k, v]) => [k, Math.round(v * 1000)])) };
  const ctx = makeContext({ elements, recipes, reach: r });
  return { ctx, elements, recipes, reach: r };
}

/** A grid of steps 1..14 × 80 reach values (0.05%..75%, geometric): every band gets a full pool. */
function gridSpecs(perSteps = 80): Spec[] {
  const out: Spec[] = [];
  for (let s = 1; s <= 14; s++) {
    for (let k = 0; k < perSteps; k++) out.push({ steps: s, reach: 0.0005 * (0.75 / 0.0005) ** (k / (perSteps - 1)) });
  }
  return out;
}

function prepared(specs = gridSpecs()) {
  const w = makeWorld(specs);
  const { cands, drops } = buildCandidates(w.ctx);
  const { pools, warnings } = buildPools(cands);
  return { ...w, cands, drops, pools, warnings };
}

const asStored = (rows: readonly PlannedRow[]): StoredRow[] => rows.map((r) => ({ day: r.day, source: "generated", generator: GENERATOR, targets: r.targets, meta: r.meta }));

// ---------------------------------------------------------------- pools

describe("buildCandidates / buildPools", () => {
  it("builds full, disjoint pools on the school basis, in tier order", () => {
    const { pools, cands, warnings } = prepared();
    // The frozen THIRD_CUTS are fitted to the real pools, not this grid: only that warning is allowed.
    expect(warnings.filter((w) => !w.includes("easy") && !w.includes("THIRD_CUTS"))).toEqual([]);
    for (const dt of ["school", "mon", "off"] as const) {
      const P = pools[dt];
      const easy = new Set(P.easy.ids);
      const hard = new Set(P.hard.ids);
      for (const id of [...P.hard.ids, ...P.expert.ids, ...(P.explore?.ids ?? [])]) {
        const c = cands.get(id)!;
        expect(easy.has(id)).toBe(false);
        // easy-capable never leaks upward
        expect(c.steps! <= 3 && c.art === "ready" && c.p.easy >= 0.22).toBe(false);
      }
      for (const id of [...P.expert.ids, ...(P.explore?.ids ?? [])]) expect(hard.has(id)).toBe(false);
      for (const tier of TIERS) {
        const pool = P[tier];
        expect(pool.ids.length).toBeGreaterThan(0);
        for (const id of pool.ids) {
          const c = cands.get(id)!;
          expect(c.p[tier]).toBeGreaterThanOrEqual(pool.lo - 1e-12);
          expect(c.p[tier]).toBeLessThanOrEqual(pool.hi);
          expect(c.steps).toBeGreaterThanOrEqual(BANDS[dt][tier].steps[0]);
          expect(c.steps).toBeLessThanOrEqual(BANDS[dt][tier].steps[1]);
        }
      }
      // p-order on the school basis: every easy > every hard > every expert.
      const ps = (ids: string[], t: "easy" | "hard" | "expert") => ids.map((id) => cands.get(id)!.p[t]);
      expect(Math.min(...ps(P.easy.ids, "easy"))).toBeGreaterThan(Math.max(...ps(P.hard.ids, "hard")));
      expect(Math.min(...ps(P.hard.ids, "hard"))).toBeGreaterThanOrEqual(Math.max(...ps(P.expert.ids, "expert")));
    }
    expect(pools.off.explore).toBeNull();
    expect(pools.school.explore!.ids.length).toBeGreaterThanOrEqual(MIN_POOL.explore);
  });

  it("widens a small band down to its floor, never above hi, and reports it", () => {
    const { pools, warnings } = prepared(gridSpecs(40));
    // 40 reach values per step count give fewer than 24 easy names at p >= 0.30.
    expect(pools.school.easy.widened).toBeGreaterThan(0);
    expect(pools.school.easy.lo).toBeLessThan(0.3);
    expect(pools.school.easy.lo).toBeGreaterThanOrEqual(0.27 - 1e-12);
    expect(warnings.some((w) => w.startsWith("school easy"))).toBe(true);
  });

  it("drops unsafe, denied (teacher), twin-trapped, unrecognizable, blocked-art, starter and demo names", () => {
    const specs: Spec[] = [
      ...gridSpecs(40),
      { id: "9001", name: "Gunfire", steps: 2, reach: 0.4 },
      { id: "9002", name: "Black Hole", steps: 6, reach: 0.01, emoji: "🕳️" },
      { id: "9003", name: "Blackhole", steps: 6, reach: 0.02, emoji: "⚫" },
      { id: "9004", name: "Lighthouse", steps: 4, reach: 0.05, tags: { teacher: true } },
      { id: "9005", name: "Unclassified", steps: 4, reach: 0.05, recognizable: null },
      { id: "9006", name: "Blocked", steps: 4, reach: 0.05, art: "blocked" },
      { id: "9007", name: "Steam", steps: 1, reach: 0.6 },
    ];
    const { ctx } = makeWorld(specs);
    const { cands, drops } = buildCandidates(ctx);
    for (const id of ["9001", "9002", "9004", "9005", "9006", "9007"]) expect(cands.has(id), id).toBe(false);
    expect(cands.has("9003")).toBe(true);
    expect(drops.unsafe).toBe(1);
    expect(drops.twinTrap).toBe(1);
    expect(drops.challengeDeny).toBe(1);
    expect(drops.unclassified).toBe(1);
    expect(hardFailures(ctx, "9007").map((f) => f.code)).toContain("demo");
    expect(hardFailures(ctx, "424242").map((f) => f.code)).toEqual(["inactive"]);
  });

  it("keeps EASY_DENY names out of easy, and synonym traps out of hard/expert", () => {
    const specs: Spec[] = [
      ...gridSpecs(),
      { id: "9010", name: "History", steps: 1, reach: 0.5 },
      { id: "9011", name: "Sea", steps: 4, reach: 0.02, tags: { synonyms: ["Ocean"] } },
      { id: "9012", name: "Ocean", steps: 2, reach: 0.4 },
    ];
    const { ctx } = makeWorld(specs);
    const { cands } = buildCandidates(ctx);
    const { pools } = buildPools(cands);
    for (const dt of ["school", "mon", "off"] as const) {
      expect(pools[dt].easy.ids).not.toContain("9010");
      expect(pools[dt].hard.ids).not.toContain("9011");
      expect(pools[dt].expert.ids).not.toContain("9011");
    }
    expect(pools.school.synonymDrops).toBe(1);
  });

  it("throws when a tier is empty at its floor (never falls back to unclassified names)", () => {
    const specs = gridSpecs(40).filter((s) => s.steps > 3);
    const { ctx } = makeWorld(specs);
    expect(() => buildPools(buildCandidates(ctx).cands)).toThrow(/easy pool is empty/);
  });

  it("the off-day expert appeal floor applies when enough appeal >= 1 names remain", () => {
    const specs = gridSpecs().map((s, i) => (s.steps >= 6 && i % 2 === 0 ? { ...s, tags: { appeal: 0 } } : s));
    const { pools, cands } = (() => {
      const w = makeWorld(specs);
      const c = buildCandidates(w.ctx).cands;
      return { pools: buildPools(c).pools, cands: c };
    })();
    expect(pools.off.appealFloor).toBe("applied");
    for (const id of pools.off.expert.ids) expect(cands.get(id)!.appeal).not.toBe(0);
    // School expert keeps appeal-0 names (they are only weighted down).
    expect(pools.school.expert.ids.some((id) => cands.get(id)!.appeal === 0)).toBe(true);
  });
});

// ---------------------------------------------------------------- the draw

describe("stableDraw (Efraimidis-Spirakis)", () => {
  const bag = Array.from({ length: 50 }, (_, i) => ({ id: String(100 + i), w: 1 }));
  it("is deterministic and never moved by removing a non-winner", () => {
    for (const day of dayRange("2027-01-01", 60)) {
      const win = stableDraw(day, "hard", bag, (c) => c.w);
      expect(stableDraw(day, "hard", bag, (c) => c.w)).toBe(win);
      const others = bag.filter((c) => c.id !== win.id);
      for (const drop of others.slice(0, 10)) expect(stableDraw(day, "hard", bag.filter((c) => c !== drop), (c) => c.w).id).toBe(win.id);
    }
  });

  it("favours heavier weights in proportion", () => {
    const heavy = bag.map((c) => (c.id === "100" ? { ...c, w: 10 } : c));
    let wins = 0;
    const days = dayRange("2027-01-01", 2000);
    for (const day of days) if (stableDraw(day, "expert", heavy, (c) => c.w).id === "100") wins++;
    // expected share 10 / 59 = 17%
    expect(wins / days.length).toBeGreaterThan(0.13);
    expect(wins / days.length).toBeLessThan(0.21);
  });

  it("weights: aha, abstract and appeal (easy is flat)", () => {
    expect(drawWeight("easy", { aha: 3, abstract: true, appeal: 2 })).toBe(1);
    expect(drawWeight("hard", { aha: 0, abstract: false, appeal: null })).toBe(1);
    expect(drawWeight("hard", { aha: 10, abstract: false, appeal: 2 })).toBeCloseTo(Math.exp(2) * 2, 12);
    expect(drawWeight("expert", { aha: 0, abstract: true, appeal: 0 })).toBeCloseTo(0.6 * 0.25, 12);
  });
});

// ---------------------------------------------------------------- planning

describe("planDays", () => {
  const P = prepared();
  const days = dayRange("2026-11-25", 400);
  const plan = planDays(P.ctx, P.cands, P.pools, { days, stored: [], provenance: PROV });
  const f = (id: string) => P.cands.get(id) ?? featuresOf(P.ctx, id)!;

  it("is deterministic", () => {
    const again = planDays(P.ctx, P.cands, P.pools, { days, stored: [], provenance: PROV });
    expect(again.rows.map((r) => r.targets)).toEqual(plan.rows.map((r) => r.targets));
  });

  it("orders steps (expert >= hard + 2 on weekdays), reach and school-basis p", () => {
    for (const r of plan.rows) {
      const [e, h, x] = TIERS.map((t) => f(r.targets[t]));
      const fb = TIERS.flatMap((t) => r.meta.tiers[t].fallback);
      expect(h!.steps!).toBeGreaterThan(e!.steps!);
      expect(x!.steps!).toBeGreaterThan(h!.steps!);
      if (dayType(r.day) !== "off" && !fb.includes("gap")) expect(x!.steps! - h!.steps!).toBeGreaterThanOrEqual(2);
      if (!fb.includes("reach-order")) {
        expect(x!.reach).toBeLessThanOrEqual(h!.reach);
        expect(h!.reach).toBeLessThanOrEqual(e!.reach);
      }
      expect(e!.p.easy).toBeGreaterThan(h!.p.hard);
      expect(h!.p.hard).toBeGreaterThan(x!.p.expert);
    }
  });

  it("never repeats a hard/expert target within 120 days when the pool allows; spaces easy repeats", () => {
    const last = new Map<string, number>();
    let minEasyGap = Infinity;
    plan.rows.forEach((r, i) => {
      for (const t of TIERS) {
        const id = r.targets[t];
        const prev = last.get(id);
        if (prev !== undefined) {
          if (t === "easy") minEasyGap = Math.min(minEasyGap, i - prev);
          else if (!r.meta.tiers[t].fallback.includes("lru")) expect(i - prev).toBeGreaterThanOrEqual(NO_REPEAT_DAYS);
        }
        last.set(id, i);
      }
    });
    // Easy pools are ~25 names: the least-recently-used quarter keeps repeats >= ~3/4 of the pool apart.
    expect(minEasyGap).toBeGreaterThanOrEqual(Math.floor(0.6 * P.pools.school.easy.ids.length));
  });

  it("keeps every pick in its day type's pool and arm slice, and logs the arms", () => {
    for (const r of plan.rows) {
      const dt = dayType(r.day);
      const pools = P.pools[dt];
      const a = armFor(r.day);
      expect(r.meta.dayType).toBe(dt);
      expect(pools.easy.ids).toContain(r.targets.easy);
      const hr = r.meta.exp.hard.realized;
      expect(r.meta.exp.hard.assigned).toBe(a.holdout.assigned ? "holdout" : a.hard.third);
      if (hr === 0 || hr === 1 || hr === 2) {
        expect(hr).toBe(a.hard.third);
        expect(pools.hard.third.get(r.targets.hard)).toBe(hr);
      }
      if (r.meta.exp.expert.realized === "explore") {
        expect(a.expert.assigned).toBe("explore");
        expect(pools.explore!.ids).toContain(r.targets.expert);
      } else if (dt !== "off") expect(pools.expert.ids).toContain(r.targets.expert);
      expect(r.meta.tiers.hard.p).toBeGreaterThan(0);
      expect(r.meta.generator).toBe(GENERATOR);
    }
    const explore = plan.rows.filter((r) => r.meta.exp.expert.realized === "explore");
    expect(explore.length).toBeGreaterThan(20);
    for (const r of explore) expect(r.day <= "2027-04-30").toBe(true);
    // Realized hard thirds are balanced overall.
    const thirds = [0, 1, 2].map((k) => plan.rows.filter((r) => r.meta.exp.hard.realized === k).length);
    // Every hard third is realized on a fair share of days (assignment is balanced per block of 3;
    // a slice under 3 candidates falls back and logs realized null).
    for (const k of thirds) expect(k).toBeGreaterThan(0.2 * plan.rows.length);
  });

  it("variety: no emoji or name word shared with a picked day within ±6 days", () => {
    // Give every element one of 40 emojis, so the emoji rule has real work to do.
    const specs = gridSpecs().map((s, i) => ({ ...s, emoji: `:m${i % 40}:` }));
    const Q = prepared(specs);
    const p = planDays(Q.ctx, Q.cands, Q.pools, { days: dayRange("2027-01-04", 60), stored: [], provenance: PROV });
    const emo = (id: string) => Q.ctx.byId.get(id)!.emoji;
    p.rows.forEach((r, i) => {
      for (let j = Math.max(0, i - VARIETY_DAYS); j < i; j++) {
        for (const t of TIERS) {
          if (r.meta.tiers[t].fallback.includes("emoji")) continue;
          for (const u of TIERS) expect(emo(r.targets[t]), `${r.day} ${t}`).not.toBe(emo(p.rows[j]!.targets[u]));
        }
      }
    });
  });

  it("keeps seasonal names to their months", () => {
    const specs: Spec[] = [...gridSpecs(), { id: "9100", name: "Snowman", steps: 1, reach: 0.7 }];
    const Q = prepared(specs);
    expect(Q.pools.school.easy.ids).toContain("9100");
    const p = planDays(Q.ctx, Q.cands, Q.pools, { days: dayRange("2027-01-01", 365), stored: [], provenance: PROV });
    const snow = p.rows.filter((r) => r.targets.easy === "9100").map((r) => Number(r.day.slice(5, 7)));
    expect(snow.length).toBeGreaterThan(0);
    for (const m of snow) expect([11, 12, 1, 2, 3]).toContain(m);
  });

  it("stored days outside the plan are fixed neighbours (repeats both ways)", () => {
    const later = plan.rows[30]!; // stored 30 days after the re-picked day
    const stored = asStored(plan.rows.filter((r) => r.day !== plan.rows[0]!.day));
    const again = planDays(P.ctx, P.cands, P.pools, { days: [plan.rows[0]!.day], stored, provenance: PROV });
    for (const t of ["hard", "expert"] as const) expect(Object.values(later.targets)).not.toContain(again.rows[0]!.targets[t]);
  });

  it("is stable when an unrelated candidate leaves the pool", () => {
    const first = plan.rows[0]!;
    const unused = P.pools.off.easy.ids.find((id) => id !== first.targets.easy)!;
    const cands = new Map(P.cands);
    cands.delete(unused);
    const { pools } = buildPools(cands);
    const again = planDays(P.ctx, cands, pools, { days: [first.day], stored: [], provenance: PROV });
    expect(again.rows[0]!.targets).toEqual(first.targets);
  });

  it("holdout days keep valid pre-v6 hard/expert targets (recognizable not required), else v6 picks", () => {
    const holdDays = dayRange("2026-11-30", 70).filter((d) => armFor(d).holdout.assigned);
    expect(holdDays.length).toBeGreaterThanOrEqual(7);
    const specs: Spec[] = [
      ...gridSpecs(),
      { id: "8001", name: "Oldhard", steps: 5, reach: 0.002, recognizable: false },
      { id: "8002", name: "Oldexpert", steps: 11, reach: 0.0004, recognizable: false },
      { id: "8003", name: "Gunfire", steps: 5, reach: 0.002 },
    ];
    const Q = prepared(specs);
    const old = (day: string, hard: string): StoredRow => ({ day, source: "generated", generator: "bfs-v4", targets: { easy: "1000", hard, expert: "8002" } });
    const both = (day: string, hard: string, expert: string): StoredRow => ({ day, source: "generated", generator: "bfs-v4", targets: { easy: "1000", hard, expert } });
    const stored = [old(holdDays[0]!, "8001"), old(holdDays[1]!, "8003"), both(holdDays[2]!, "8001", "8003"), both(holdDays[3]!, "8003", "8003")];
    const p = planDays(Q.ctx, Q.cands, Q.pools, { days: dayRange("2026-11-25", 80), stored, provenance: PROV });
    const r0 = p.rows.find((r) => r.day === holdDays[0])!;
    expect(r0.targets.hard).toBe("8001");
    expect(r0.targets.expert).toBe("8002");
    expect(r0.meta.exp.holdout).toMatchObject({ assigned: true, realized: true, tiers: { hard: true, expert: true } });
    expect(r0.meta.exp.hard).toMatchObject({ assigned: "holdout", realized: "holdout" });
    // Unsafe pre-v6 hard: only that tier takes a v6 pick (below the holdout expert); the expert stays.
    const r1 = p.rows.find((r) => r.day === holdDays[1])!;
    expect(r1.targets.hard).not.toBe("8003");
    expect(r1.targets.expert).toBe("8002");
    expect(r1.meta.tiers.hard.steps!).toBeLessThan(11);
    expect(r1.meta.exp.holdout).toMatchObject({ assigned: true, realized: true, tiers: { hard: false, expert: true } });
    expect(r1.meta.exp.hard).toMatchObject({ assigned: "holdout" });
    expect(r1.meta.exp.hard.realized).not.toBe("holdout");
    expect(r1.meta.exp.expert.realized).toBe("holdout");
    expect(p.warnings.some((w) => w.startsWith(`${holdDays[1]}: holdout hard not realized`))).toBe(true);
    // Unsafe pre-v6 expert: the hard stays the holdout, the expert is a v6 pick.
    const r2 = p.rows.find((r) => r.day === holdDays[2])!;
    expect(r2.targets.hard).toBe("8001");
    expect(r2.targets.expert).not.toBe("8003");
    expect(r2.meta.exp.holdout).toMatchObject({ realized: true, tiers: { hard: true, expert: false } });
    expect(r2.meta.tiers.expert.steps!).toBeGreaterThan(5);
    // Both invalid: a plain v6 day, logged realized false.
    const r3 = p.rows.find((r) => r.day === holdDays[3])!;
    expect(r3.meta.exp.holdout).toMatchObject({ assigned: true, realized: false });
    expect(p.warnings.some((w) => w.startsWith(`${holdDays[3]}: holdout assigned but no valid`))).toBe(true);
    // The pre-v6 targets are fixed neighbours: no other day picks them within 120 days.
    for (const r of p.rows) if (r.day !== holdDays[0] && r.day !== holdDays[2]) expect(r.targets.hard).not.toBe("8001");
    for (const r of p.rows) if (r.day !== holdDays[0] && r.day !== holdDays[1]) expect(r.targets.expert).not.toBe("8002");
    // The checker treats the realized holdout tiers (and the order checks next to them) as holdout.
    const issues = checkDays(asStored(p.rows.filter((r) => holdDays.includes(r.day))), Q.ctx, { today: "2026-11-25" });
    expect(issues.filter((i) => i.severity === "broken")).toEqual([]);
  });

  it("preV6Targets reads meta.replaced[0] on pred-v6 rows", () => {
    const t: DayTargets = { easy: "1", hard: "2", expert: "3" };
    const u: DayTargets = { easy: "4", hard: "5", expert: "6" };
    expect(preV6Targets({ day: "d", source: "generated", generator: "bfs-v4", targets: t })).toEqual(t);
    expect(preV6Targets({ day: "d", source: "generated", generator: GENERATOR, targets: u })).toBeNull();
    const meta = { replaced: [{ generator: "bfs-v3", targets: t, reason: "v6-rollout", at: "x" }] } as unknown as StoredRow["meta"];
    expect(preV6Targets({ day: "d", source: "generated", generator: GENERATOR, targets: u, meta })).toEqual(t);
    expect(preV6Targets(undefined)).toBeNull();
  });

  it("rejects unsorted or duplicate days", () => {
    expect(() => planDays(P.ctx, P.cands, P.pools, { days: ["2027-01-02", "2027-01-01"], stored: [], provenance: PROV })).toThrow();
    expect(() => planDays(P.ctx, P.cands, P.pools, { days: ["2027-01-01", "2027-01-01"], stored: [], provenance: PROV })).toThrow();
  });
});

// ---------------------------------------------------------------- generator -> checker round trip

describe("generator -> checker round trip (no endless --fix re-picks)", () => {
  it("checkDays finds nothing broken in what buildPools + planDays produce", () => {
    const P = prepared();
    const plan = planDays(P.ctx, P.cands, P.pools, { days: dayRange("2026-11-25", 365), stored: [], provenance: PROV });
    const issues = checkDays(asStored(plan.rows), P.ctx, { today: "2026-11-01" });
    expect(issues.filter((i) => i.severity === "broken")).toEqual([]);
    expect(brokenDays(issues)).toEqual([]);
  });
});

describe("checkDays (§9.3)", () => {
  const P = prepared([
    ...gridSpecs(40),
    { id: "7001", name: "Gunfire", steps: 2, reach: 0.3 },
    { id: "7002", name: "Snowball", steps: 1, reach: 0.5 },
    { id: "7003", name: "Midhard", steps: 3, reach: 0.05 },
    { id: "7004", name: "Lowexpert", steps: 9, reach: 0.002 },
    { id: "7005", name: "Notknown", steps: 2, reach: 0.4, recognizable: false },
  ]);
  const row = (day: string, targets: DayTargets, generator = GENERATOR): StoredRow => ({ day, source: "generated", generator, targets });
  const problems = (rows: StoredRow[]) => checkDays(rows, P.ctx, { today: "2027-01-01" }).map((i) => `${i.tier}:${i.problem}:${i.severity}`);

  it("flags safety, inactive and tier order as broken on every row", () => {
    expect(problems([row("2027-01-12", { easy: "7001", hard: "7003", expert: "7004" }, "bfs-v4")])).toContain("easy:unsafe:broken");
    expect(problems([row("2027-01-12", { easy: "424242", hard: "7003", expert: "7004" }, "bfs-v4")])).toContain("easy:inactive:broken");
    expect(problems([row("2027-01-12", { easy: "7002", hard: "7004", expert: "7003" }, "bfs-v4")])).toContain("expert:tier-order:broken");
  });

  it("not-recognizable, out-of-season and p-order are broken on pred-v6 rows only", () => {
    const v6 = problems([row("2027-07-13", { easy: "7005", hard: "7003", expert: "7004" })]);
    expect(v6).toContain("easy:not-recognizable:broken");
    const old = problems([row("2027-07-13", { easy: "7005", hard: "7003", expert: "7004" }, "bfs-v4")]);
    expect(old).toContain("easy:not-recognizable:warning");
    expect(problems([row("2027-07-13", { easy: "7002", hard: "7003", expert: "7004" })])).toContain("easy:out-of-season:broken");
    expect(problems([row("2027-01-13", { easy: "7002", hard: "7003", expert: "7004" })])).not.toContain("easy:out-of-season:broken");
    // expert with a higher school-basis p than hard
    expect(problems([row("2027-01-13", { easy: "7002", hard: "7004", expert: "7003" })])).toContain("expert:p-order:broken");
    expect(problems([row("2027-01-13", { easy: "7002", hard: "7004", expert: "7003" }, "bfs-v4")])).toContain("expert:p-order:warning");
  });

  it("holdout tiers keep only safety/inactive/unreachable/art/twin as broken", () => {
    const meta = { exp: { holdout: { assigned: true, realized: true, block: 0 }, hard: {}, expert: {} } } as unknown as StoredRow["meta"];
    const issues = checkDays([{ ...row("2027-01-13", { easy: "7002", hard: "7004", expert: "7003" }), meta }], P.ctx, { today: "2027-01-01" });
    expect(issues.filter((i) => i.tier !== "easy" && i.severity === "broken")).toEqual([]);
    const unsafe = checkDays([{ ...row("2027-01-13", { easy: "7002", hard: "7001", expert: "7004" }), meta }], P.ctx, { today: "2027-01-01" });
    expect(unsafe.some((i) => i.tier === "hard" && i.problem === "unsafe" && i.severity === "broken")).toBe(true);
  });

  it("p-low / p-high are report-only; art-not-ready is a warning inside its horizon", () => {
    const art = makeWorld([...gridSpecs(40), { id: "7101", name: "Pendingart", steps: 1, reach: 0.5, art: "pending" }]);
    const near = checkDays([row("2027-01-03", { easy: "7101", hard: "7003", expert: "7004" })], art.ctx, { today: "2027-01-01" });
    expect(near.some((i) => i.problem === "art-not-ready" && i.severity === "warning")).toBe(true);
    const far = checkDays([row("2027-02-03", { easy: "7101", hard: "7003", expert: "7004" })], art.ctx, { today: "2027-01-01" });
    expect(far.some((i) => i.problem === "art-not-ready")).toBe(false);
    for (const i of checkDays([row("2027-01-13", { easy: "7002", hard: "1000", expert: "7004" })], P.ctx, { today: "2027-01-01" })) {
      if (i.problem === "p-low" || i.problem === "p-high") expect(i.severity).toBe("report");
    }
    expect(BROKEN_PROBLEMS.has("p-low")).toBe(false);
  });
});

describe("Nov 2026 review rules", () => {
  /** A hand-built world: starters 1-5, then `els` with explicit recipes (reach per id). */
  function world(els: { id: string; name: string; emoji?: string | null; recipes: string[][]; reach?: number; steps?: number }[]) {
    const elements: PoolElement[] = ["Water", "Fire", "Earth", "Air", "Time"].map((name, i) => ({ id: String(i + 1), name, isStarter: true, steps: 0, imageStatus: "ready" }));
    const recipes: GraphRecipe[] = [];
    const reach = new Map<string, number>();
    for (const e of els) {
      elements.push({ id: e.id, name: e.name, isStarter: false, steps: e.steps ?? 1, recognizable: true, imageStatus: "ready", emoji: e.emoji === undefined ? `:${e.id}:` : e.emoji });
      for (const r of e.recipes) recipes.push({ ingredients: r, result: e.id });
      reach.set(e.id, e.reach ?? 0.05);
    }
    const r: Reach = { asOf: "x", mode: "r1", cohortN: 1000, cohortN7: 500, reach, reach7: reach, owners: new Map() };
    return makeContext({ elements, recipes, reach: r });
  }
  const codes = (ctx: ReturnType<typeof world>, id: string) => hardFailures(ctx, id).map((f) => f.code);

  it("C5b: drops a safe name whose short routes all go through a denied element", () => {
    const ctx = world([
      { id: "100", name: "Gunfire", recipes: [["1", "2"]] },
      { id: "101", name: "Shellcase", recipes: [["100", "1"]], steps: 2 }, // only via Gunfire
      { id: "104", name: "Puddle", recipes: [["1", "3"]] },
      { id: "105", name: "Brook", recipes: [["104", "1"]], steps: 2 },
      { id: "106", name: "Stream", recipes: [["105", "1"]], steps: 3 },
      { id: "103", name: "Longway", recipes: [["100", "1"], ["106", "1"]], steps: 2 }, // safe route 4 > 2 + 1
      { id: "107", name: "Shortway", recipes: [["100", "1"], ["105", "1"]], steps: 2 }, // safe route 3 = 2 + 1
    ]);
    expect(codes(ctx, "101")).toContain("unsafe-path");
    expect(codes(ctx, "103")).toContain("unsafe-path");
    expect(codes(ctx, "107")).not.toContain("unsafe-path");
    expect(codes(ctx, "100")).toContain("unsafe");
    expect(codes(ctx, "100")).not.toContain("unsafe-path");
    expect(APPLY_CHECKS.has("unsafe-path")).toBe(true);
    expect(featuresOf(ctx, "103")!.safeSteps).toBe(4);
    // The checker breaks a stored day on it, on every row.
    const issues = checkDays([{ day: "2027-01-12", source: "generated", generator: "bfs-v4", targets: { easy: "104", hard: "101", expert: "103" } }], ctx, { today: "2027-01-01" });
    expect(issues.some((i) => i.tier === "hard" && i.problem === "unsafe-path" && i.severity === "broken")).toBe(true);
  });

  it("C5 emoji and C1 emoji: a denied emoji is unsafe, a missing emoji keeps a name out of the candidates", () => {
    const { ctx } = makeWorld([...gridSpecs(40), { id: "9201", name: "Fizzwater", steps: 2, reach: 0.4, emoji: "🍺" }, { id: "9202", name: "Plainname", steps: 2, reach: 0.4, emoji: null }]);
    expect(codes(ctx as ReturnType<typeof world>, "9201")).toContain("unsafe");
    expect(codes(ctx as ReturnType<typeof world>, "9202")).toContain("no-emoji");
    const { cands, drops } = buildCandidates(ctx);
    expect(cands.has("9201")).toBe(false);
    expect(cands.has("9202")).toBe(false);
    expect(drops.unsafe).toBe(1);
  });

  it("C8b: easy drops a twin made by >= 25% as many players (or >= 5% of players), hard/expert at >= 50%", () => {
    const specs: Spec[] = [
      ...gridSpecs(),
      { id: "9301", name: "Ash", steps: 1, reach: 0.376 },
      { id: "9302", name: "Ashes", steps: 1, reach: 0.34, recognizable: null },
      { id: "9303", name: "Clay", steps: 1, reach: 0.5 },
      { id: "9304", name: "Clays", steps: 1, reach: 0.06, recognizable: null },
      { id: "9305", name: "Sand", steps: 1, reach: 0.5 },
      { id: "9306", name: "Sands", steps: 1, reach: 0.03, recognizable: null },
      { id: "9307", name: "Wave", steps: 4, reach: 0.05 },
      { id: "9308", name: "Waves", steps: 4, reach: 0.03, recognizable: null },
      { id: "9309", name: "Comet", steps: 4, reach: 0.05 },
      { id: "9310", name: "Comets", steps: 4, reach: 0.02, recognizable: null },
    ];
    const Q = prepared(specs);
    for (const dt of ["school", "mon", "off"] as const) {
      expect(Q.pools[dt].easy.ids).not.toContain("9301");
      expect(Q.pools[dt].easy.ids).not.toContain("9303");
    }
    expect(Q.pools.school.easy.ids).toContain("9305");
    expect(Q.pools.school.hard.ids).not.toContain("9307");
    expect(Q.pools.school.hard.ids).toContain("9309");
    expect(twinNear(Q.cands.get("9301")!, "easy")).toMatch(/twin reach 34/);
    expect(twinNear(Q.cands.get("9309")!, "hard")).toBeNull();
    expect(Q.pools.school.easyTwinDrops).toBe(2);
    expect(Q.pools.school.upperDrops.twinNear).toBe(1);
  });

  it("C12: near-name traps, the aha floor and art-not-ready stay out of hard/expert/explore", () => {
    const specs: Spec[] = [
      ...gridSpecs(),
      { id: "9401", name: "Machine", steps: 4, reach: 0.05 },
      { id: "9402", name: "Time Machine", steps: 3, reach: 0.2, recognizable: null },
      { id: "9403", name: "Robot", steps: 4, reach: 0.05 },
      { id: "9404", name: "Robot Arm", steps: 5, reach: 0.1, recognizable: null },
      { id: "9405", name: "Lonely", steps: 4, reach: 0.05, single: true },
      { id: "9406", name: "Unpainted", steps: 4, reach: 0.05, art: "pending" },
    ];
    const Q = prepared(specs);
    const upper = (dt: "school" | "mon" | "off") => [...Q.pools[dt].hard.ids, ...Q.pools[dt].expert.ids, ...(Q.pools[dt].explore?.ids ?? [])];
    for (const dt of ["school", "mon", "off"] as const) for (const id of ["9401", "9405", "9406"]) expect(upper(dt), `${dt} ${id}`).not.toContain(id);
    expect(Q.pools.school.hard.ids).toContain("9403");
    expect(Q.cands.get("9401")!.nearNameTrap).toBe("9402");
    expect(Q.cands.get("9405")!.ahaOk).toBe(false);
    expect(Q.pools.school.upperDrops).toMatchObject({ nearName: 1, ahaFloor: 1, artNotReady: 1 });
  });

  it("EASY_SOFT_DENY applies only while the easy pool keeps MIN_POOL names without it", () => {
    const big = prepared([...gridSpecs(200), { id: "9501", name: "Mountain", steps: 1, reach: 0.5 }]);
    expect(big.pools.school.easySoftDeny).toBe("applied");
    expect(big.pools.school.easy.ids.length).toBeGreaterThanOrEqual(MIN_POOL.easy);
    expect(big.pools.school.easy.ids).not.toContain("9501");
    const small = prepared([...gridSpecs(40), { id: "9501", name: "Mountain", steps: 1, reach: 0.5 }]);
    expect(small.pools.school.easySoftDeny).toBe("dropped");
    expect(small.pools.school.easy.ids).toContain("9501");
    expect(prepared(gridSpecs(40)).pools.school.easySoftDeny).toBe("n/a");
  });

  it("the off-day appeal floor reports vacuous when no candidate has tags", () => {
    expect(prepared().pools.off.appealFloor).toBe("vacuous");
  });

  it("thirds come from frozen cut points: removing a candidate never re-slices the others", () => {
    const P = prepared();
    const victim = P.pools.school.hard.ids[Math.floor(P.pools.school.hard.ids.length / 2)]!;
    const cands = new Map(P.cands);
    cands.delete(victim);
    const { pools } = buildPools(cands);
    for (const dt of ["school", "mon", "off"] as const) {
      for (const t of ["hard", "expert"] as const) {
        for (const [id, k] of pools[dt][t].third) expect(P.pools[dt][t].third.get(id), `${dt} ${t} ${id}`).toBe(k);
      }
    }
  });

  it("is stable over a year when a never-picked mid-pool hard candidate leaves (no LRU in its pool)", () => {
    const P = prepared(gridSpecs(160));
    const days = dayRange("2026-11-25", 365);
    const base = planDays(P.ctx, P.cands, P.pools, { days, stored: [], provenance: PROV });
    const picked = new Set(base.rows.flatMap((r) => TIERS.map((t) => r.targets[t])));
    expect(P.pools.school.hard.ids.length).toBeGreaterThanOrEqual(NO_REPEAT_DAYS);
    // Only in the school hard pool (below Monday's band, 2 steps: not an off-day or expert range).
    const only = P.pools.school.hard.ids.filter((id) => {
      const c = P.cands.get(id)!;
      return !picked.has(id) && c.steps === 2 && !P.pools.mon.hard.ids.includes(id);
    });
    expect(only.length).toBeGreaterThan(0);
    const cands = new Map(P.cands);
    cands.delete(only[Math.floor(only.length / 2)]!);
    const again = planDays(P.ctx, cands, buildPools(cands).pools, { days, stored: [], provenance: PROV });
    expect(again.rows.map((r) => r.targets)).toEqual(base.rows.map((r) => r.targets));
  });

  it("p-order is enforced by the planner; a recorded tier-order/p-order fallback is only a warning in the checker", () => {
    const P = prepared();
    const plan = planDays(P.ctx, P.cands, P.pools, { days: dayRange("2027-01-04", 30), stored: [], provenance: PROV });
    for (const row of plan.rows) {
      const [e, h, x] = TIERS.map((t) => P.cands.get(row.targets[t])!);
      expect(h!.p.hard).toBeLessThan(e!.p.easy);
      expect(x!.p.expert).toBeLessThan(h!.p.hard);
    }
    const r = plan.rows[0]!;
    // The most completable candidate as expert: fewer steps and a higher school-basis p than hard.
    const top = [...P.cands.values()].sort((a, b) => b.p.expert - a.p.expert)[0]!;
    expect(top.p.expert).toBeGreaterThan(P.cands.get(r.targets.hard)!.p.hard);
    const bad: StoredRow = { day: r.day, source: "generated", generator: GENERATOR, targets: { ...r.targets, expert: top.id }, meta: r.meta };
    const sev = (row: StoredRow, problem: string) => checkDays([row], P.ctx, { today: "2027-01-01" }).find((i) => i.problem === problem && i.tier === "expert")?.severity;
    expect(sev(bad, "p-order")).toBe("broken");
    expect(sev(bad, "tier-order")).toBe("broken");
    const m = r.meta;
    const recorded: StoredRow = { ...bad, meta: { ...m, tiers: { ...m.tiers, expert: { ...m.tiers.expert, id: top.id, fallback: ["tier-order", "p-order"] } } } };
    expect(sev(recorded, "p-order")).toBe("warning");
    expect(sev(recorded, "tier-order")).toBe("warning");
    // A fallback recorded for another target does not excuse this one.
    const stale: StoredRow = { ...bad, meta: { ...m, tiers: { ...m.tiers, expert: { ...m.tiers.expert, fallback: ["tier-order", "p-order"] } } } };
    expect(sev(stale, "p-order")).toBe("broken");
  });

  it("no hazard or disease emoji on named holidays", () => {
    const specs = gridSpecs().map((s, i) => (i % 3 === 0 ? { ...s, emoji: ["🦠", "☢️", "☣️", "🚨"][i % 4]! } : s));
    const Q = prepared(specs);
    const p = planDays(Q.ctx, Q.cands, Q.pools, { days: dayRange("2026-11-25", 420), stored: [], provenance: PROV });
    const gloomy = (r: PlannedRow) => TIERS.some((t) => Q.cands.get(r.targets[t])!.gloomy);
    const holidays = p.rows.filter((r) => namedHoliday(r.day));
    expect(holidays.length).toBeGreaterThanOrEqual(5);
    for (const r of holidays) expect(gloomy(r), r.day).toBe(false);
    expect(p.rows.filter((r) => !namedHoliday(r.day) && gloomy(r)).length).toBeGreaterThan(20);
  });

  it("the explore arm waits for classifier tags", () => {
    const P = prepared();
    const p = planDays(P.ctx, P.cands, P.pools, { days: dayRange("2026-11-30", 60), stored: [], provenance: { ...PROV, classifierVersion: "none" } });
    const assigned = p.rows.filter((r) => armFor(r.day).expert.assigned === "explore" && !armFor(r.day).holdout.assigned);
    expect(assigned.length).toBeGreaterThan(5);
    for (const r of assigned) {
      expect(r.meta.exp.expert).toMatchObject({ assigned: "explore", realized: "band" });
      expect(r.meta.tiers.expert.fallback).toContain("explore-unclassified");
    }
    expect(p.warnings.some((w) => w.includes("explore arm waits for classifier tags"))).toBe(true);
  });
});

describe("analyzeWorld (solvability, legacy BFS tiers for the classifier)", () => {
  it("finds elements reachable over active 2-ingredient recipes only", () => {
    const elements: PoolElement[] = [
      { id: "1", name: "Water", isStarter: true },
      { id: "2", name: "Fire", isStarter: true },
      { id: "10", name: "Steam", isStarter: false },
      { id: "20", name: "Cloud", isStarter: false },
      { id: "30", name: "Rain", isStarter: false },
    ];
    const { tiers, eligibleAt } = analyzeWorld(elements, [
      { ingredients: ["1", "2"], result: "10" },
      { ingredients: ["10", "10"], result: "20" },
      { ingredients: ["10", "20", "1"], result: "30" }, // 3 ingredients: not a pair
    ]);
    expect(tiers.get("20")).toBe(2);
    expect(tiers.has("30")).toBe(false);
    expect(eligibleAt(1)).toEqual(["10"]);
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
    expect(addDays("2026-11-24", 1)).toBe("2026-11-25");
  });
});
