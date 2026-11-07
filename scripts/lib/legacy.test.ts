import { describe, expect, it } from "vitest";
import { buildPlan, LEGACY_USER_RE, parseRecipeName, uniqueRowidTime, type LegacySnapshot } from "./legacy.ts";

const at = new Date("2023-05-20T00:00:00Z");
const U1 = "alchemy:11111111-1111-4111-8111-111111111111";
const U2 = "alchemy:22222222-2222-4222-8222-222222222222";

describe("helpers", () => {
  it("decodes unique_rowid timestamps", () => {
    // The first legacy element id (2023-05-20 launch).
    const d = uniqueRowidTime("866674527284625410");
    expect(d.toISOString().slice(0, 10)).toBe("2023-05-20");
  });

  it("parses recipe names as a multiset", () => {
    expect(parseRecipeName("recipe:3,1,1")).toEqual(["3", "1", "1"]);
    expect(parseRecipeName("recipe:")).toBeNull();
    expect(parseRecipeName("3,1")).toBeNull();
  });

  it("validates legacy user ids", () => {
    expect(LEGACY_USER_RE.test(U1)).toBe(true);
    expect(LEGACY_USER_RE.test("alchemy:score 5")).toBe(false);
    expect(LEGACY_USER_RE.test(U1.toUpperCase())).toBe(false);
    // The earliest players (before 2023-05-23) have bare UUIDs.
    expect(LEGACY_USER_RE.test(U1.slice("alchemy:".length))).toBe(true);
    expect(LEGACY_USER_RE.test(`x${U1.slice("alchemy:".length)}`)).toBe(false);
  });
});

describe("buildPlan", () => {
  // ids: 1-5 starters, 10 steam, 11 'steam ' twin, 12 spam, 13 mud, 14 brick,
  // 15 a double-space list name that is a challenge target, 16 a long-token path element.
  const el = (id: number, name: string, creator = "", starter = false) => ({ id: String(id), name, starter, createdAt: at, creator });
  const snap: LegacySnapshot = {
    asOf: "0",
    elements: [
      el(1, "earth", "", true),
      el(2, "water", "", true),
      el(3, "air", "", true),
      el(4, "fire", "", true),
      el(5, "time", "", true),
      el(6, "time "),
      el(10, "steam", U1),
      el(11, "steam ", U2),
      el(12, "mechamechamecha", U1),
      el(13, "mud", "junk user"),
      el(14, "brick", U2),
      el(15, "whirlpool  rapids  maelstrom"),
      el(16, "superultramegahypercolossal"),
    ],
    recipes: [
      { id: "100", name: "recipe:2,4", resultId: "10", createdAt: at }, // water+fire=steam
      { id: "101", name: "recipe:4,2", resultId: "11", createdAt: at }, // same multiset after sort -> collision
      { id: "102", name: "recipe:1,2", resultId: "13", createdAt: at }, // mud
      { id: "103", name: "recipe:13,4", resultId: "14", createdAt: at }, // brick
      { id: "104", name: "recipe:10,12", resultId: "14", createdAt: at }, // quarantined ingredient
      { id: "105", name: "recipe:3,5", resultId: "12", createdAt: at }, // result quarantined
      { id: "106", name: "recipe:1,999", resultId: "10", createdAt: at }, // purged ingredient
      { id: "107", name: "recipe:1,2,3,4,5", resultId: "10", createdAt: at }, // arity 5
      { id: "108", name: "recipe:1", resultId: "10", createdAt: at }, // arity 1
      { id: "109", name: "recipe:6,4", resultId: "16", createdAt: at }, // 'time '+fire -> long token (path)
      { id: "110", name: "recipe:16,2", resultId: "15", createdAt: at }, // -> target
    ],
    challenges: [
      { day: "2026-11-05", easy: "13", hard: "14", expert: "15" },
      { day: "2026-11-06", easy: "10", hard: "14", expert: "12" }, // cutover day: not copied
    ],
    completions: [
      { userId: U1, day: "2026-11-05", easy: true, hard: false, expert: true },
      { userId: "alchemy:score 9", day: "2026-11-05", easy: true, hard: false, expert: false },
      { userId: U2, day: "2026-11-06", easy: true, hard: false, expert: false },
    ],
    credits: [
      { id: "866674527284625410", userId: U1 },
      { id: "866674527284625411", userId: "alchemy:score 9" },
    ],
  };
  const plan = buildPlan(snap);
  const byId = new Map(plan.elements.map((e) => [e.id, e]));

  it("aliases whitespace twins to the canonical row", () => {
    expect(plan.map.find((m) => m.legacyId === "11")).toEqual({ legacyId: "11", elementId: "10", disposition: "alias" });
    expect(plan.map.find((m) => m.legacyId === "6")).toEqual({ legacyId: "6", elementId: "5", disposition: "alias" });
    expect(byId.has("11")).toBe(false);
    expect(plan.map).toHaveLength(snap.elements.length);
  });

  it("activates by checkName, protects targets and their derivations", () => {
    expect(byId.get("10")).toMatchObject({ name: "Steam", status: "active", creator: U1 });
    expect(byId.get("12")!.status).toBe("quarantined");
    expect(byId.get("15")).toMatchObject({ status: "active", name: "Whirlpool Rapids Maelstrom" });
    expect(byId.get("16")!.status).toBe("active"); // only active because it is on 15's path
    expect(byId.get("13")!.creator).toBeNull();
    expect(byId.get("1")).toMatchObject({ isStarter: true, emoji: "🌍", name: "Earth" });
    expect(plan.stats["elements.protected.path_additions"]).toBe(1);
  });

  it("maps, filters and de-collides recipes", () => {
    const ids = plan.recipes.map((r) => r.id);
    expect(ids).toEqual(["100", "102", "103", "105", "109", "110"]);
    expect(plan.recipes.find((r) => r.id === "100")!.ingredientIds).toEqual(["2", "4"]);
    expect(plan.recipes.find((r) => r.id === "105")!.status).toBe("quarantined");
    expect(plan.recipes.find((r) => r.id === "109")!.ingredientIds).toEqual(["4", "5"]); // alias resolved
    expect(plan.recipes.find((r) => r.id === "110")!.protected).toBe(true);
    expect(plan.stats).toMatchObject({
      "recipes.dropped.collision_same_result": 1,
      "recipes.dropped.quarantined_ingredient": 1,
      "recipes.dropped.purged_ingredient": 1,
      "recipes.dropped.arity_above_4": 1,
      "recipes.dropped.arity_below_2": 1,
    });
  });

  it("computes depth and steps", () => {
    expect(plan.depth.get("14")).toBe(2);
    expect(plan.steps.get("15")).toBe(2);
    expect(plan.depth.has("12")).toBe(false);
  });

  it("copies only pre-cutover challenges and valid completions", () => {
    expect(plan.challenges).toEqual([{ day: "2026-11-05", ids: { easy: "13", hard: "14", expert: "15" }, steps: { easy: 1, hard: 2, expert: 2 } }]);
    expect(plan.completions).toEqual([
      { legacyUserId: U1, day: "2026-11-05", tier: "easy" },
      { legacyUserId: U1, day: "2026-11-05", tier: "expert" },
    ]);
    expect(plan.stats["completions.dropped.junk_user"]).toBe(1);
    expect(plan.stats["completions.dropped.on_or_after_cutover"]).toBe(1);
  });

  it("creates players and discoveries", () => {
    expect(plan.players.map((p) => p.legacyUserId)).toEqual([U1, U2]);
    expect(plan.players[0]!.createdAt.toISOString().slice(0, 10)).toBe("2023-05-20");
    const disc = plan.discoveries.map((d) => `${d.legacyUserId === U1 ? "U1" : "U2"}:${d.elementId}`).sort();
    // U1 created steam (10) and spam (12, quarantined: skipped); completed easy 13 + expert 15.
    // U2 created the 'steam ' twin (-> 10) and brick (14).
    expect(disc).toEqual(["U1:10", "U1:13", "U1:15", "U2:10", "U2:14"]);
  });
});
