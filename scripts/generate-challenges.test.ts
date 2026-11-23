import { describe, expect, it } from "vitest";
import {
  APPLY_FREEZE_MARGIN_MS,
  configHash,
  daysForYears,
  horizonEnd,
  makePlan,
  nextReplaced,
  planHashOf,
  planStats,
  prepare,
  prepareContext,
  refuseFrozen,
  refuseWithoutMeta,
  revalidate,
  writeFrozenThrough,
  type Snapshot,
} from "./generate-challenges.ts";
import { armFor } from "./lib/challengeModel.ts";
import { dayRange, GENERATOR, repickDeadline, type DayTargets, type StoredRow } from "./lib/challenges.ts";
import { reachInputsToJson } from "./lib/reach.ts";
import type { WorldElement } from "./lib/world.ts";

const t = (e: string, h: string, x: string): DayTargets => ({ easy: e, hard: h, expert: x });

describe("nextReplaced (meta.replaced)", () => {
  it("records the replaced row, keeping the pre-v6 entry first and the last 3 after it", () => {
    const pre: StoredRow = { day: "2027-01-05", source: "generated", generator: "bfs-v4", targets: t("1", "2", "3") };
    const r1 = nextReplaced(pre, "v6-rollout", "a")!;
    expect(r1).toEqual([{ generator: "bfs-v4", targets: t("1", "2", "3"), reason: "v6-rollout", at: "a" }]);
    let row: StoredRow = { ...pre, generator: GENERATOR, targets: t("4", "5", "6"), meta: { replaced: r1 } as StoredRow["meta"] };
    let rep = r1;
    for (let i = 0; i < 5; i++) {
      rep = nextReplaced(row, `jit${i}`, `t${i}`)!;
      row = { ...row, targets: t(`e${i}`, `h${i}`, `x${i}`), meta: { replaced: rep } as StoredRow["meta"] };
    }
    expect(rep).toHaveLength(4);
    expect(rep[0]!.generator).toBe("bfs-v4");
    expect(rep.slice(1).map((r) => r.reason)).toEqual(["jit2", "jit3", "jit4"]);
    expect(nextReplaced(null, "x", "y")).toBeUndefined();
  });
});

describe("guards", () => {
  it("refuses frozen days unless --allow-frozen", () => {
    const now = new Date("2026-11-23T02:00:00Z"); // frozen through 11-24
    expect(() => refuseFrozen(["2026-11-24", "2026-11-25"], now, false, "test")).toThrow(/frozen/);
    expect(() => refuseFrozen(["2026-11-25"], now, false, "test")).not.toThrow();
    expect(() => refuseFrozen(["2026-11-24"], now, true, "test")).not.toThrow();
  });

  it("treats a day as frozen APPLY_FREEZE_MARGIN_MS before it freezes (a long apply cannot commit late)", () => {
    const deadline = repickDeadline("2026-12-02").getTime(); // 2026-11-30 10:00 UTC
    expect(APPLY_FREEZE_MARGIN_MS).toBe(30 * 60_000);
    expect(() => refuseFrozen(["2026-12-02"], new Date(deadline - APPLY_FREEZE_MARGIN_MS - 1), false, "test")).not.toThrow();
    expect(() => refuseFrozen(["2026-12-02"], new Date(deadline - APPLY_FREEZE_MARGIN_MS + 1), false, "test")).toThrow(/freeze within 30 min/);
    expect(writeFrozenThrough(new Date(deadline - 10 * 60_000))).toBe("2026-12-02");
    expect(writeFrozenThrough(new Date(deadline - 31 * 60_000))).toBe("2026-12-01");
  });

  it("refuses pred-v6 writes without challenges.meta; never on a holdout day", () => {
    const days = dayRange("2026-11-30", 70);
    const hold = days.filter((d) => armFor(d).holdout.assigned);
    const plain = days.filter((d) => !armFor(d).holdout.assigned).slice(0, 5);
    expect(hold.length).toBeGreaterThan(0);
    expect(() => refuseWithoutMeta(days, true, false, "test")).not.toThrow();
    expect(() => refuseWithoutMeta([], false, false, "test")).not.toThrow();
    expect(() => refuseWithoutMeta(plain, false, false, "test")).toThrow(/challenges.meta is missing/);
    expect(() => refuseWithoutMeta(plain, false, true, "test")).not.toThrow();
    expect(() => refuseWithoutMeta([...plain, hold[0]!].sort(), false, true, "test")).toThrow(/holdout/);
    // Holdout days outside the window (none assigned) are plain days.
    expect(() => refuseWithoutMeta(["2027-03-02"], false, true, "test")).not.toThrow();
  });

  it("the default range ends at the 5-year horizon", () => {
    expect(daysForYears("2026-11-06", 5)).toBe(1826);
    expect(horizonEnd()).toBe("2031-11-06");
  });

  it("configHash is stable within a build", () => {
    expect(configHash()).toBe(configHash());
    expect(configHash()).toMatch(/^[0-9a-f]{12}$/);
  });
});

/** A tiny offline snapshot: easy/hard/expert-capable elements made from the starters. */
function snapshot(): Snapshot {
  const elements: WorldElement[] = ["Water", "Fire", "Earth", "Air", "Time"].map((name, i) => ({
    id: String(i + 1),
    name,
    isStarter: true,
    steps: 0,
    depth: 0,
    imageStatus: "ready",
    emoji: null,
    notable: false,
    tags: null,
    recognizable: null,
  }));
  const owners: [string, { owners: number; owners7: number }][] = [];
  // A ladder 50..61 with steps 1..12 (unclassified, so never targets), so fresh steps match.
  const recipes = [{ ingredients: ["1", "2"], result: "50" }];
  for (let s = 1; s <= 12; s++) {
    elements.push({ id: String(49 + s), name: `Rung${"abcdefghijkl"[s - 1]}`, isStarter: false, steps: s, depth: s, imageStatus: "ready", emoji: null, notable: false, tags: null, recognizable: null });
    if (s > 1) recipes.push({ ingredients: [String(48 + s), "1"], result: String(49 + s) });
  }
  let n = 0;
  const syll = ["ba", "do", "fi", "gu", "ke", "lo", "mi", "nu", "pe", "ro", "ti", "vu"];
  for (let s = 1; s <= 12; s++) {
    for (let k = 0; k < 90; k++) {
      const id = String(1000 + n);
      const name = `${syll[n % 12]}${syll[Math.floor(n / 12) % 12]}${syll[Math.floor(n / 144) % 12]}`;
      elements.push({ id, name: name[0]!.toUpperCase() + name.slice(1), isStarter: false, steps: s, depth: Math.min(s, 3), imageStatus: "ready", emoji: `:e${n}:`, notable: false, tags: null, recognizable: true });
      const reach = 0.0005 * (0.75 / 0.0005) ** (k / 89);
      owners.push([id, { owners: Math.max(1, Math.round(reach * 2000)), owners7: 1 }]);
      // Two near-optimal recipes each (the aha floor, C12).
      if (s === 1) recipes.push({ ingredients: ["1", "2"], result: id }, { ingredients: ["3", "4"], result: id });
      else recipes.push({ ingredients: [String(48 + s), "1"], result: id }, { ingredients: [String(48 + s), "2"], result: id });
      n++;
    }
  }
  return {
    kind: "challenge-snapshot",
    v: 1,
    schema: "test",
    takenAt: "2026-11-23T02:00:00.000Z",
    worldAsOf: "2026-11-23 01:00:00+00",
    hasMeta: true,
    hasTags: false,
    elements,
    allRecipes: recipes,
    stored: [{ day: "2026-11-24", source: "generated", generator: "bfs-v4", targets: t("1000", "1500", "1900") }],
    reach: reachInputsToJson({ asOf: "2026-11-23T02:00:00.000Z", n28: 2000, n7: 1000, owners: new Map(owners), hourly: new Map(), windows: new Map() }),
  };
}

describe("prepare + makePlan (offline snapshot)", () => {
  const snap = snapshot();
  const prep = prepare(snap);
  const days = ["2026-11-25", "2026-11-26", "2026-11-30", "2026-12-01", "2026-12-02"];
  const plan = makePlan(snap, prep, days, new Date("2026-11-23T02:00:00Z"));

  it("plans the requested days with names, prev rows and one plan hash", () => {
    expect(plan.rows.map((r) => r.day)).toEqual(days);
    expect(new Set(plan.rows.map((r) => r.meta.planHash))).toEqual(new Set([plan.planHash]));
    expect(planHashOf(plan.rows)).toBe(plan.planHash); // purge re-picks hash their rows the same way
    for (const r of plan.rows) expect(r.names.easy).toBe(prep.names.get(r.targets.easy));
    expect(plan.rows[0]!.prev).toBeNull();
    expect(plan.frozenThroughAtPlan).toBe("2026-11-24");
    // Same snapshot, same code -> same rows (pickedAt aside).
    const again = makePlan(snap, prep, days, new Date("2026-11-23T03:00:00Z"));
    expect(again.rows.map((r) => r.targets)).toEqual(plan.rows.map((r) => r.targets));
    expect(again.planHash).toBe(plan.planHash);
  });

  it("revalidate passes now and catches a target that became unsafe", () => {
    expect(revalidate(plan, prep.ctx)).toEqual([]);
    const bad = { ...plan, rows: [{ ...plan.rows[0]!, targets: { ...plan.rows[0]!.targets, hard: "999999" } }] };
    expect(revalidate(bad, prep.ctx)[0]).toMatch(/inactive/);
  });

  it("refuses to plan without a reach cohort (a fresh schema), but the checker's context still builds", () => {
    const tiny = { ...snap, reach: { ...snap.reach, n28: 3 } };
    expect(() => prepare(tiny)).toThrow(/reach cohort/);
    const ctx = prepareContext(tiny);
    expect(ctx.smallCohort).toMatch(/reach cohort/);
    expect(ctx.ctx.byId.size).toBe(snap.elements.length);
    expect(prepareContext(snap).smallCohort).toBeNull();
  });

  it("the checker's context builds even when a pool would be empty", () => {
    const noEasy = { ...snap, elements: snap.elements.map((e) => (e.steps !== null && e.steps <= 3 && !e.isStarter ? { ...e, recognizable: null } : e)) };
    expect(() => prepare(noEasy)).toThrow(/pool is empty/);
    expect(() => prepareContext(noEasy)).not.toThrow();
  });

  it("planStats splits weekdays and off days, and leaves realized holdout tiers out of weekday-v6", () => {
    const s = planStats(plan.rows);
    expect(s.days).toBe(5);
    expect(s.byType.off!.days).toBe(2);
    expect(s.byType.weekday!.days).toBe(3);
    expect(s.byType.weekday!.easy.meanP).toBeGreaterThan(s.byType.weekday!.hard.meanP);
    const wk = plan.rows.filter((r) => r.meta.dayType !== "off");
    const held = [{ ...wk[0]!, meta: { ...wk[0]!.meta, exp: { ...wk[0]!.meta.exp, expert: { ...wk[0]!.meta.exp.expert, realized: "holdout" as const } } } }, ...wk.slice(1)];
    const h = planStats(held);
    const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;
    expect(h.byType["weekday-v6"]!.expert.meanP).toBeCloseTo(mean(wk.slice(1).map((r) => r.meta.tiers.expert.p)), 12);
    expect(h.byType["weekday-v6"]!.hard.meanP).toBeCloseTo(mean(wk.map((r) => r.meta.tiers.hard.p)), 12);
  });
});
