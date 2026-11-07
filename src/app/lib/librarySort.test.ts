// Unit tests for the library order: built-in sorts must match the pre-custom-sort hook exactly
// (an oracle copied verbatim from useLibrary.ts), custom orders must match the implementation
// before decorate-then-sort (a second verbatim oracle), plus every custom-sort ordering rule.
import { describe, expect, it } from "vitest";
import { SORT_FIT_THRESHOLD, SORT_MATCH_THRESHOLD, type ElementDTO, type ElementId, type Rarity, type SortSpec } from "../../shared/api.ts";
import { RARITY_ORDER } from "../../shared/rarity.ts";
import type { Owned } from "../state/game.ts";
import type { LibraryFilter, LibrarySort } from "../state/ui.ts";
import type { BuiltInSort } from "./customSort.ts";
import {
  countsOf,
  groupOf,
  levelLabel,
  orderLibrary,
  rankOf,
  topOf,
  type Bucket,
  type Committed,
  type CustomCounts,
  type CustomOrder,
  type LibraryOrderInput,
} from "./librarySort.ts";

const NOW = Date.parse("2026-11-07T12:00:00Z");
const NEW_WINDOW_MS = 24 * 3_600_000;

/** The pre-custom-sort useLibraryList body, verbatim (minus React), as the reference. */
function legacyOrder(
  owned: Record<ElementId, Owned>,
  els: Record<ElementId, ElementDTO>,
  pins: ReadonlySet<ElementId>,
  filter: LibraryFilter,
  sort: "recent" | "az" | "rarity",
  query: string,
  now: number,
): ElementId[] {
  const q = query.trim().toLowerCase();
  const cutoff = now - NEW_WINDOW_MS;
  const ids = Object.keys(owned).filter((id) => {
    const el = els[id];
    if (!el) return false;
    if (filter === "pinned" && !pins.has(id)) return false;
    if (filter === "firsts" && !owned[id]!.first) return false;
    if (filter === "new" && (el.starter || Date.parse(owned[id]!.discoveredAt) < cutoff)) return false;
    return !q || el.name.toLowerCase().includes(q);
  });
  const name = (id: ElementId) => els[id]!.name;
  const time = (id: ElementId) => Date.parse(owned[id]!.discoveredAt) || 0;
  const rank = (id: ElementId) => RARITY_ORDER.indexOf(els[id]!.rarity);
  const depth = (id: ElementId) => (els[id]!.starter ? -1 : (els[id]!.depth ?? 0.5));
  const byName = (a: ElementId, b: ElementId) => name(a).localeCompare(name(b));
  const bySort =
    sort === "az"
      ? byName
      : sort === "rarity"
        ? (a: ElementId, b: ElementId) => rank(b) - rank(a) || depth(b) - depth(a) || byName(a, b)
        : (a: ElementId, b: ElementId) => time(b) - time(a) || byName(a, b);
  return ids.sort((a, b) => {
    if (q) {
      const pa = name(a).toLowerCase().startsWith(q) ? 0 : 1;
      const pb = name(b).toLowerCase().startsWith(q) ? 0 : 1;
      if (pa !== pb) return pa - pb;
    }
    if (filter !== "pinned") {
      const pa = pins.has(a) ? 0 : 1;
      const pb = pins.has(b) ? 0 : 1;
      if (pa !== pb) return pa - pb;
    }
    return bySort(a, b);
  });
}

/** orderLibrary before decorate-then-sort, verbatim (the reference for every custom order). */
function previousOrder(i: LibraryOrderInput): { ids: ElementId[]; counts: CustomCounts | null } {
  const { owned, elements: els, pins, filter, sort, query, now, custom } = i;
  const q = query.trim().toLowerCase();
  const cutoff = now - NEW_WINDOW_MS;
  let ids = Object.keys(owned).filter((id) => {
    const el = els[id];
    if (!el) return false;
    if (filter === "pinned" && !pins.has(id)) return false;
    if (filter === "firsts" && !owned[id]!.first) return false;
    if (filter === "new" && (el.starter || Date.parse(owned[id]!.discoveredAt) < cutoff)) return false;
    return !q || el.name.toLowerCase().includes(q);
  });
  const name = (id: ElementId) => els[id]!.name;
  const time = (id: ElementId) => Date.parse(owned[id]!.discoveredAt) || 0;
  const rank = (id: ElementId) => RARITY_ORDER.indexOf(els[id]!.rarity);
  // Within a tier, deeper is rarer. Starters are always the least rare; elements whose depth
  // is unknown (no current path from the starters) sit just above them.
  const depth = (id: ElementId) => (els[id]!.starter ? -1 : (els[id]!.depth ?? 0.5));
  const byName = (a: ElementId, b: ElementId) => name(a).localeCompare(name(b));
  const builtIn = (s: BuiltInSort) =>
    s === "az"
      ? byName
      : s === "rarity"
        ? (a: ElementId, b: ElementId) => rank(b) - rank(a) || depth(b) - depth(a) || byName(a, b)
        : (a: ElementId, b: ElementId) => time(b) - time(a) || byName(a, b);
  const prefixFirst = (a: ElementId, b: ElementId) => {
    if (!q) return 0;
    // Prefix matches first while searching.
    const pa = name(a).toLowerCase().startsWith(q) ? 0 : 1;
    const pb = name(b).toLowerCase().startsWith(q) ? 0 : 1;
    return pa - pb;
  };
  const pinsFirst = (a: ElementId, b: ElementId) => (filter === "pinned" ? 0 : (pins.has(a) ? 0 : 1) - (pins.has(b) ? 0 : 1));

  const c = sort === "custom" ? (custom?.committed ?? null) : null;
  if (!c || !custom) {
    // Built-in sorts, or custom with nothing weighed yet (the previous sort's order).
    const bySort = builtIn(sort === "custom" ? (custom?.prevSort ?? "recent") : sort);
    ids.sort((a, b) => prefixFirst(a, b) || pinsFirst(a, b) || bySort(a, b));
    return { ids, counts: null };
  }

  const { pending, reverse, other, bucket } = custom;
  const scores = c.scores;
  const prev = builtIn(custom.prevSort);
  // Always the committed kind: committed scores can lag behind a new spec.
  const groupsMode = c.kind === "groups";
  const groupCount = c.spec.kind === "groups" ? c.spec.groups.length : 0;
  // 0 = being weighed, 1 = scored, 2 = not scored and not pending (by the previous sort).
  const tier = (id: ElementId) => (pending.has(id) ? 0 : scores.has(id) ? 1 : 2);
  const group = new Map<ElementId, number | undefined>();
  if (groupsMode) for (const id of ids) group.set(id, groupOf(c, id, other));
  const fitOf = (id: ElementId) => c.fit?.get(id) ?? 0;

  let counts: CustomCounts;
  if (groupsMode) {
    const perGroup = Array.from({ length: groupCount }, () => 0);
    let otherN = 0;
    for (const id of ids) {
      const g = group.get(id);
      if (g === undefined) continue;
      if (g === -1) otherN++;
      else perGroup[g]!++;
    }
    counts = { kind: "groups", all: ids.length, groups: perGroup, other: otherN };
  } else {
    let matches = 0;
    for (const id of ids) if ((scores.get(id) ?? -1) >= SORT_MATCH_THRESHOLD) matches++;
    counts = { kind: "rank", all: ids.length, matches };
  }

  const bucketApplies =
    bucket !== null && (custom.key == null || custom.key === c.key) && (groupsMode ? typeof bucket === "number" : bucket === "matches");
  if (bucketApplies) {
    ids = ids.filter((id) =>
      pending.has(id) || (bucket === "matches" ? (scores.get(id) ?? -1) >= SORT_MATCH_THRESHOLD : group.get(id) === bucket),
    );
  }

  const newestFirst = (a: ElementId, b: ElementId) => time(b) - time(a) || byName(a, b);
  if (!groupsMode) {
    ids.sort((a, b) => {
      const ta = tier(a);
      const tb = tier(b);
      const head = prefixFirst(a, b) || pinsFirst(a, b) || ta - tb;
      if (head) return head;
      if (ta === 0) return newestFirst(a, b);
      if (ta === 2) return prev(a, b);
      const sa = scores.get(a)!;
      const sb = scores.get(b)!;
      return (reverse ? sa - sb : sb - sa) || byName(a, b);
    });
    return { ids, counts };
  }

  // Real groups in display order, then Other, then (defensively) scored ids with no usable group.
  const slot = (id: ElementId) => {
    const g = group.get(id);
    return g === undefined ? groupCount + 1 : g === -1 ? groupCount : g;
  };
  ids.sort((a, b) => {
    const ta = tier(a);
    const tb = tier(b);
    let d = prefixFirst(a, b) || ta - tb;
    if (d) return d;
    if (ta === 1) {
      d = slot(a) - slot(b);
      if (d) return d;
    }
    d = pinsFirst(a, b);
    if (d) return d;
    if (ta === 0) return newestFirst(a, b);
    if (ta === 2) return prev(a, b);
    // The group probability saturates for clear members (live Jev gives most of them 1000), so
    // the fit (how clearly it belongs in any group) breaks those ties before the name does.
    if (slot(a) < groupCount) return scores.get(b)! - scores.get(a)! || fitOf(b) - fitOf(a) || byName(a, b);
    return byName(a, b);
  });
  return { ids, counts };
}

function el(id: string, name: string, extra: Partial<ElementDTO> = {}): ElementDTO {
  return { id, name, emoji: null, img: null, art: "missing", description: null, notable: false, depth: 3, rarity: "common", starter: false, ...extra };
}

interface Fixture {
  owned: Record<ElementId, Owned>;
  elements: Record<ElementId, ElementDTO>;
}

/** Elements given as [id, name, minutes ago, extra?]. */
function lib(rows: [string, string, number, Partial<ElementDTO>?][]): Fixture {
  const owned: Record<ElementId, Owned> = {};
  const elements: Record<ElementId, ElementDTO> = {};
  for (const [id, name, ago, extra] of rows) {
    owned[id] = { discoveredAt: new Date(NOW - ago * 60_000).toISOString(), first: false };
    elements[id] = el(id, name, extra);
  }
  return { owned, elements };
}

/** Deterministic pseudo-random library with ties in names, dates, rarity and depth. */
function randomLibrary(n: number, seed: number): Fixture & { pins: Set<ElementId> } {
  let x = seed >>> 0;
  const rnd = () => ((x = (Math.imul(x, 1664525) + 1013904223) >>> 0) / 2 ** 32);
  const words = ["Fire", "Water", "Steam", "Mud", "fireball", "Stone", "steam engine", "Ash", "ash", "Ghost", "Rain"];
  const owned: Record<ElementId, Owned> = {};
  const elements: Record<ElementId, ElementDTO> = {};
  const pins = new Set<ElementId>();
  for (let i = 0; i < n; i++) {
    const id = String(1000 + i);
    const starter = i < 4;
    const ago = Math.floor(rnd() * 6) * 600; // many equal timestamps, some older than a day
    owned[id] = { discoveredAt: rnd() < 0.05 ? "garbage" : new Date(NOW - ago * 60_000).toISOString(), first: rnd() < 0.2 };
    const depth = rnd() < 0.2 ? null : Math.floor(rnd() * 16);
    elements[id] = el(id, words[Math.floor(rnd() * words.length)]!, {
      starter,
      depth,
      rarity: RARITY_ORDER[Math.floor(rnd() * RARITY_ORDER.length)] as Rarity,
    });
    if (rnd() < 0.15) pins.add(id);
  }
  // An owned id missing from the catalog is dropped.
  owned["9999"] = { discoveredAt: new Date(NOW).toISOString(), first: false };
  return { owned, elements, pins };
}

const base = { pins: new Set<ElementId>(), filter: "all" as LibraryFilter, query: "", now: NOW, custom: null };

function committed(spec: SortSpec, s: Record<string, number>, g?: Record<string, number>, n?: Record<string, number>): Committed {
  return {
    key: spec.kind === "rank" ? `r:${spec.prompt}` : `g:${spec.groups.join("\u0001").toLowerCase()}`,
    kind: spec.kind,
    spec,
    scores: new Map(Object.entries(s)),
    groups: g ? new Map(Object.entries(g)) : null,
    fit: n ? new Map(Object.entries(n)) : null,
  };
}

function custom(c: Committed | null, extra: Partial<CustomOrder> = {}): CustomOrder {
  return { committed: c, pending: new Set(), reverse: false, other: true, bucket: null, prevSort: "recent", ...extra };
}

const names = (f: Fixture, ids: ElementId[]) => ids.map((id) => f.elements[id]!.name);

describe("built-in sorts", () => {
  it("match the previous implementation exactly for every sort, filter, query and pin combination", () => {
    for (const seed of [1, 2, 3, 42]) {
      const f = randomLibrary(160, seed);
      for (const sort of ["recent", "az", "rarity"] as const) {
        for (const filter of ["all", "pinned", "new", "firsts"] as const) {
          for (const query of ["", "fi", "  STEAM ", "ash", "zzz"]) {
            const expected = legacyOrder(f.owned, f.elements, f.pins, filter, sort, query, NOW);
            const got = orderLibrary({ owned: f.owned, elements: f.elements, pins: f.pins, filter, sort, query, now: NOW, custom: null });
            expect(got.ids).toEqual(expected);
            expect(got.counts).toBeNull();
          }
        }
      }
    }
  });
  it("ignores a custom order unless the sort is custom", () => {
    const f = randomLibrary(40, 7);
    const c = committed({ kind: "rank", prompt: "x" }, Object.fromEntries(Object.keys(f.owned).map((id, i) => [id, i])));
    const got = orderLibrary({ ...base, ...f, sort: "az", custom: custom(c, { bucket: "matches" }) });
    expect(got.ids).toEqual(legacyOrder(f.owned, f.elements, f.pins, "all", "az", "", NOW));
    expect(got.counts).toBeNull();
  });
  it("custom with nothing committed uses prevSort and ignores the bucket", () => {
    const f = randomLibrary(40, 9);
    for (const prevSort of ["recent", "az", "rarity"] as const) {
      const got = orderLibrary({ ...base, ...f, sort: "custom", custom: custom(null, { prevSort, bucket: "matches" }) });
      expect(got.ids).toEqual(legacyOrder(f.owned, f.elements, f.pins, "all", prevSort, "", NOW));
      expect(got.counts).toBeNull();
    }
  });
  it("custom without a custom order at all falls back to Recent", () => {
    const f = randomLibrary(30, 11);
    expect(orderLibrary({ ...base, ...f, sort: "custom" as LibrarySort }).ids).toEqual(legacyOrder(f.owned, f.elements, f.pins, "all", "recent", "", NOW));
  });
});

// Ghost 900, Vampire 800, Zombie 700, Puppy 100; Mud pending; Rock unscored (newest of the rest).
const spooky = lib([
  ["1", "Ghost", 50],
  ["2", "Vampire", 40],
  ["3", "Zombie", 30],
  ["4", "Puppy", 20],
  ["5", "Mud", 1],
  ["6", "Rock", 5],
  ["7", "Brick", 6],
  ["8", "Mud Pie", 2],
]);
const spookySpec: SortSpec = { kind: "rank", prompt: "spookiest" };
const spookyC = committed(spookySpec, { "1": 900, "2": 800, "3": 700, "4": 100 });

describe("rank order", () => {
  it("pending first (newest first), then by score, then unscored in prevSort order", () => {
    const pending = new Set(["5", "8"]);
    const got = orderLibrary({ ...base, ...spooky, sort: "custom", custom: custom(spookyC, { pending }) });
    expect(names(spooky, got.ids)).toEqual(["Mud", "Mud Pie", "Ghost", "Vampire", "Zombie", "Puppy", "Rock", "Brick"]);
    const az = orderLibrary({ ...base, ...spooky, sort: "custom", custom: custom(spookyC, { prevSort: "az" }) });
    expect(names(spooky, az.ids)).toEqual(["Ghost", "Vampire", "Zombie", "Puppy", "Brick", "Mud", "Mud Pie", "Rock"]);
  });
  it("reverse flips only the scored tier", () => {
    const pending = new Set(["5"]);
    const got = orderLibrary({ ...base, ...spooky, sort: "custom", custom: custom(spookyC, { pending, reverse: true }) });
    expect(names(spooky, got.ids)).toEqual(["Mud", "Puppy", "Zombie", "Vampire", "Ghost", "Mud Pie", "Rock", "Brick"]);
  });
  it("ties break by name", () => {
    const f = lib([
      ["1", "b", 1],
      ["2", "a", 2],
      ["3", "c", 3],
    ]);
    const c = committed(spookySpec, { "1": 500, "2": 500, "3": 900 });
    expect(names(f, orderLibrary({ ...base, ...f, sort: "custom", custom: custom(c) }).ids)).toEqual(["c", "a", "b"]);
  });
  it("search prefix first, then pins first (unless the Pinned filter), then tiers", () => {
    const pins = new Set(["4"]);
    const got = orderLibrary({ ...base, ...spooky, pins, query: "mu", sort: "custom", custom: custom(spookyC) });
    expect(names(spooky, got.ids)).toEqual(["Mud", "Mud Pie"]);
    const all = orderLibrary({ ...base, ...spooky, pins, sort: "custom", custom: custom(spookyC, { pending: new Set(["5"]) }) });
    expect(names(spooky, all.ids).slice(0, 3)).toEqual(["Puppy", "Mud", "Ghost"]);
    const pinned = orderLibrary({ ...base, ...spooky, pins: new Set(["4", "1"]), filter: "pinned", sort: "custom", custom: custom(spookyC) });
    expect(names(spooky, pinned.ids)).toEqual(["Ghost", "Puppy"]);
    const prefix = lib([
      ["1", "Big Mud", 1],
      ["2", "Mud", 2],
    ]);
    const pc = committed(spookySpec, { "1": 900, "2": 100 });
    expect(names(prefix, orderLibrary({ ...base, ...prefix, query: "mud", sort: "custom", custom: custom(pc) }).ids)).toEqual(["Mud", "Big Mud"]);
  });
  it("matches bucket keeps strong scores and pending ids; counts are taken before the bucket", () => {
    const c = committed(spookySpec, { "1": 900, "2": SORT_MATCH_THRESHOLD, "3": SORT_MATCH_THRESHOLD - 1, "4": 100 });
    const got = orderLibrary({ ...base, ...spooky, sort: "custom", custom: custom(c, { bucket: "matches", pending: new Set(["5"]) }) });
    expect(names(spooky, got.ids)).toEqual(["Mud", "Ghost", "Vampire"]);
    expect(got.counts).toEqual({ kind: "rank", all: 8, matches: 2 });
  });
  it("counts follow the base filter", () => {
    const got = orderLibrary({ ...base, ...spooky, query: "o", sort: "custom", custom: custom(spookyC, { bucket: "matches" }) });
    // Ghost, Zombie, Rock contain "o"; Ghost and Zombie are matches.
    expect(got.counts).toEqual({ kind: "rank", all: 3, matches: 2 });
    expect(names(spooky, got.ids)).toEqual(["Ghost", "Zombie"]);
  });
  it("a bucket never filters by a lagging committed order of another key", () => {
    const got = orderLibrary({ ...base, ...spooky, sort: "custom", custom: custom(spookyC, { bucket: "matches", key: "r:metal" }) });
    expect(got.ids).toHaveLength(8);
    const same = orderLibrary({ ...base, ...spooky, sort: "custom", custom: custom(spookyC, { bucket: "matches", key: spookyC.key }) });
    expect(same.ids).toHaveLength(3);
  });
});

// Groups Animals(0) / Food(1): Owl 0 strong, Wolf 0 strong, Bread 1 strong, Sword weak fit (Other),
// Apple 1 strong but pinned, Stone pending, Brick unscored.
const zoo = lib([
  ["1", "Owl", 10],
  ["2", "Wolf", 9],
  ["3", "Bread", 8],
  ["4", "Sword", 7],
  ["5", "Apple", 6],
  ["6", "Stone", 1],
  ["7", "Brick", 2],
]);
const zooSpec: SortSpec = { kind: "groups", groups: ["Animals", "Food"] };
const zooC = committed(
  zooSpec,
  { "1": 700, "2": 900, "3": 800, "4": 600, "5": 650 },
  { "1": 0, "2": 0, "3": 1, "4": 0, "5": 1 },
  { "1": 900, "2": 900, "3": 900, "4": SORT_FIT_THRESHOLD - 1, "5": SORT_FIT_THRESHOLD },
);

describe("groups order", () => {
  it("pending, then groups in order (score desc, pins first within a group), Other last by name, then unscored", () => {
    const pins = new Set(["5"]);
    const got = orderLibrary({ ...base, ...zoo, pins, sort: "custom", custom: custom(zooC, { pending: new Set(["6"]) }) });
    expect(names(zoo, got.ids)).toEqual(["Stone", "Wolf", "Owl", "Apple", "Bread", "Sword", "Brick"]);
    expect(got.counts).toEqual({ kind: "groups", all: 7, groups: [2, 2], other: 1 });
  });
  it("equal group probabilities break by fit, then by name", () => {
    // Wolf and Owl share s = 1000 (as live Jev gives clear members); the clearer fit comes first.
    const c = committed(zooSpec, { "1": 1000, "2": 1000 }, { "1": 0, "2": 0 }, { "1": 700, "2": 950 });
    const lib2 = { owned: { "1": zoo.owned["1"]!, "2": zoo.owned["2"]! }, elements: zoo.elements };
    const got = orderLibrary({ ...base, ...lib2, sort: "custom", custom: custom(c) });
    expect(names(zoo, got.ids)).toEqual(["Wolf", "Owl"]);
    const tied = committed(zooSpec, { "1": 1000, "2": 1000 }, { "1": 0, "2": 0 }, { "1": 900, "2": 900 });
    const byName = orderLibrary({ ...base, ...lib2, sort: "custom", custom: custom(tied) });
    expect(names(zoo, byName.ids)).toEqual(["Owl", "Wolf"]);
  });
  it("with Other off every element joins its closest group", () => {
    const got = orderLibrary({ ...base, ...zoo, sort: "custom", custom: custom(zooC, { other: false }) });
    expect(names(zoo, got.ids)).toEqual(["Wolf", "Owl", "Sword", "Bread", "Apple", "Stone", "Brick"]);
    expect(got.counts).toEqual({ kind: "groups", all: 7, groups: [3, 2], other: 0 });
  });
  it("group and Other buckets keep pending ids", () => {
    const pending = new Set(["6"]);
    const food = orderLibrary({ ...base, ...zoo, sort: "custom", custom: custom(zooC, { pending, bucket: 1 }) });
    expect(names(zoo, food.ids)).toEqual(["Stone", "Bread", "Apple"]);
    expect(food.counts).toEqual({ kind: "groups", all: 7, groups: [2, 2], other: 1 });
    const other = orderLibrary({ ...base, ...zoo, sort: "custom", custom: custom(zooC, { pending, bucket: -1 as Bucket }) });
    expect(names(zoo, other.ids)).toEqual(["Stone", "Sword"]);
  });
  it("uses the committed kind, never the active spec's", () => {
    // A rank bucket on a committed groups order (the new rank spec is still weighing) is ignored.
    const got = orderLibrary({ ...base, ...zoo, sort: "custom", custom: custom(zooC, { bucket: "matches" }) });
    expect(got.counts?.kind).toBe("groups");
    expect(got.ids).toHaveLength(7);
    const rankOnRank = orderLibrary({ ...base, ...spooky, sort: "custom", custom: custom(spookyC, { bucket: 0 }) });
    expect(rankOnRank.ids).toHaveLength(8);
  });
  it("search prefix still comes first", () => {
    const got = orderLibrary({ ...base, ...zoo, query: "b", sort: "custom", custom: custom(zooC) });
    expect(names(zoo, got.ids)).toEqual(["Bread", "Brick"]);
  });
});

describe("groupOf / rankOf / levelLabel", () => {
  it("groupOf: undefined when unscored, -1 for weak fits only with Other on", () => {
    expect(groupOf(zooC, "1", true)).toBe(0);
    expect(groupOf(zooC, "4", true)).toBe(-1);
    expect(groupOf(zooC, "4", false)).toBe(0);
    expect(groupOf(zooC, "5", true)).toBe(1); // exactly at the threshold stays
    expect(groupOf(zooC, "7", true)).toBeUndefined();
    expect(groupOf(spookyC, "1", true)).toBeUndefined();
    const bad = committed(zooSpec, { "1": 1 }, { "1": 5 }, { "1": 900 });
    expect(groupOf(bad, "1", true)).toBeUndefined();
  });
  it("rankOf: among owned scored ids, ties share a rank, reverse counts from the bottom", () => {
    const c = committed(spookySpec, { "1": 900, "2": 800, "3": 800, "4": 100, gone: 1000 });
    const owned = spooky.owned;
    expect(rankOf(c, "1", false, owned)).toEqual({ rank: 1, of: 4 });
    expect(rankOf(c, "3", false, owned)).toEqual({ rank: 2, of: 4 });
    expect(rankOf(c, "4", false, owned)).toEqual({ rank: 4, of: 4 });
    expect(rankOf(c, "4", true, owned)).toEqual({ rank: 1, of: 4 });
    expect(rankOf(c, "5", false, owned)).toBeNull();
    expect(rankOf(c, "gone", false, owned)).toBeNull();
  });
  it("rankOf with names: ties break by name like the grid, so every tile has its own place", () => {
    const c = committed(spookySpec, { "1": 900, "2": 800, "3": 800, "4": 100, gone: 1000 });
    const owned = spooky.owned;
    const nameOf = (id: string) => spooky.elements[id]!.name;
    const grid = orderLibrary({ ...base, ...spooky, sort: "custom", custom: custom(c) }).ids;
    for (const reverse of [false, true]) {
      const order = reverse ? orderLibrary({ ...base, ...spooky, sort: "custom", custom: { ...custom(c), reverse: true } }).ids : grid;
      const scored = order.filter((id) => c.scores.has(id));
      expect(scored.map((id) => rankOf(c, id, reverse, owned, nameOf)!.rank)).toEqual(scored.map((_, i) => i + 1));
    }
  });
  it("levelLabel maps 0..1000 onto the five levels", () => {
    expect([0, 124, 125, 374, 500, 625, 874, 875, 1000].map(levelLabel)).toEqual([
      "No match",
      "No match",
      "Slight match",
      "Slight match",
      "Partial match",
      "Clear match",
      "Clear match",
      "Perfect match",
      "Perfect match",
    ]);
  });
  it("levelLabel: everything in Matches says at least Clear match", () => {
    expect(SORT_MATCH_THRESHOLD).toBe(600);
    expect([599, 600, 612, 624].map(levelLabel)).toEqual(["Partial match", "Clear match", "Clear match", "Clear match"]);
    expect([-5, 1200].map(levelLabel)).toEqual(["No match", "Perfect match"]);
  });
});

/** Scores, groups, fits and pending ids over a random library, with ties and a few junk values. */
function randomCustom(f: Fixture, seed: number) {
  let x = (seed * 7919) >>> 0;
  const rnd = () => ((x = (Math.imul(x, 1664525) + 1013904223) >>> 0) / 2 ** 32);
  const s: Record<string, number> = {};
  const g: Record<string, number> = {};
  const n: Record<string, number> = {};
  const pending = new Set<ElementId>();
  for (const id of Object.keys(f.owned)) {
    const r = rnd();
    if (r < 0.1) pending.add(id);
    if (r < 0.75) {
      s[id] = [0, 250, 500, 600, 750, 1000][Math.floor(rnd() * 6)]! + (rnd() < 0.5 ? 0 : Math.floor(rnd() * 3));
      g[id] = rnd() < 0.05 ? 7 : Math.floor(rnd() * 3); // 7: no such group (defensive slot)
      n[id] = [100, SORT_FIT_THRESHOLD - 1, SORT_FIT_THRESHOLD, 900][Math.floor(rnd() * 4)]!;
    }
  }
  s.gone = 1000; // scored but no longer owned
  const rankC = committed({ kind: "rank", prompt: "x" }, s);
  const groupsC = committed({ kind: "groups", groups: ["A", "B", "C"] }, s, g, n);
  return { rankC, groupsC, pending, rnd };
}

describe("decorate-then-sort", () => {
  const filters = ["all", "pinned", "new", "firsts"] as const;
  const prevSorts = ["recent", "az", "rarity"] as const satisfies readonly BuiltInSort[];
  const buckets: (Bucket | null)[] = [null, "matches", 0, 2, -1, 5];
  /** Every custom input combination over a few random libraries, with random display options. */
  function* customInputs(): Generator<LibraryOrderInput> {
    for (const seed of [1, 2, 3, 42, 99]) {
      const f = randomLibrary(180, seed);
      const { rankC, groupsC, pending, rnd } = randomCustom(f, seed);
      for (const c of [rankC, groupsC, null]) {
        for (const prevSort of prevSorts) {
          for (const filter of filters) {
            for (const query of ["", "fi", " ASH ", "zzz"]) {
              const key = [undefined, null, c?.key, "r:else"][Math.floor(rnd() * 4)];
              yield {
                owned: f.owned,
                elements: f.elements,
                pins: f.pins,
                filter,
                sort: "custom",
                query,
                now: NOW,
                custom: {
                  committed: c,
                  pending,
                  reverse: rnd() < 0.5,
                  other: rnd() < 0.5,
                  bucket: buckets[Math.floor(rnd() * buckets.length)]!,
                  prevSort,
                  key,
                },
              };
            }
          }
        }
      }
    }
  }

  it("custom orders and counts match the previous implementation exactly", () => {
    let n = 0;
    for (const input of customInputs()) {
      const got = orderLibrary(input);
      const want = previousOrder(input);
      expect(got.ids).toEqual(want.ids);
      expect(got.counts).toEqual(want.counts);
      n++;
    }
    expect(n).toBe(5 * 3 * 3 * 4 * 4);
  });

  it("topOf is the head of orderLibrary and countsOf its counts, for every sort", () => {
    const builtIns = (function* (): Generator<LibraryOrderInput> {
      for (const seed of [5, 6]) {
        const f = randomLibrary(150, seed);
        for (const sort of ["recent", "az", "rarity"] as const) {
          for (const filter of filters) {
            for (const query of ["", "st", "zzz"]) yield { owned: f.owned, elements: f.elements, pins: f.pins, filter, sort, query, now: NOW, custom: null };
          }
        }
      }
    })();
    for (const input of [...customInputs(), ...builtIns]) {
      const full = orderLibrary(input);
      for (const k of [0, 1, 3, 7]) expect(topOf(input, k)).toEqual(full.ids.slice(0, k));
      expect(countsOf(input)).toEqual(full.counts);
    }
  });

  it("topOf keeps the input order between rows that compare equal (like the stable sort)", () => {
    // Same name, same score, same time: only the input order separates them.
    const f = lib([
      ["1", "Ash", 5],
      ["2", "Ash", 5],
      ["3", "Ash", 5],
    ]);
    const c = committed(spookySpec, { "1": 500, "2": 500, "3": 500 });
    const input: LibraryOrderInput = { ...base, ...f, sort: "custom", custom: custom(c) };
    expect(orderLibrary(input).ids).toEqual(["1", "2", "3"]);
    expect(topOf(input, 2)).toEqual(["1", "2"]);
  });

  it("stays fast at 25k elements (sanity budget, generous on purpose)", () => {
    const N = 25_000;
    const owned: Record<ElementId, Owned> = {};
    const elements: Record<ElementId, ElementDTO> = {};
    let x = 12345;
    const rnd = () => ((x = (Math.imul(x, 1664525) + 1013904223) >>> 0) / 2 ** 32);
    const s: Record<string, number> = {};
    const g: Record<string, number> = {};
    const fit: Record<string, number> = {};
    for (let i = 0; i < N; i++) {
      const id = String(i);
      owned[id] = { discoveredAt: new Date(NOW - Math.floor(rnd() * 1e9)).toISOString(), first: false };
      elements[id] = el(id, `Element ${Math.floor(rnd() * 20_000)}`, { rarity: RARITY_ORDER[i % RARITY_ORDER.length] as Rarity });
      s[id] = rnd() < 0.6 ? 1000 : Math.floor(rnd() * 1000);
      g[id] = i % 4;
      fit[id] = Math.floor(rnd() * 1000);
    }
    const groupsC = committed({ kind: "groups", groups: ["A", "B", "C", "D"] }, s, g, fit);
    const rankC = committed(spookySpec, s);
    const time = (fn: () => unknown) => {
      const runs: number[] = [];
      for (let r = 0; r < 3; r++) {
        const t0 = performance.now();
        fn();
        runs.push(performance.now() - t0);
      }
      return runs.sort((a, b) => a - b)[1]!;
    };
    const inputs = {
      recent: { ...base, owned, elements, sort: "recent" as const },
      rank: { ...base, owned, elements, sort: "custom" as const, custom: custom(rankC) },
      groups: { ...base, owned, elements, sort: "custom" as const, custom: custom(groupsC) },
    };
    const report: string[] = [];
    for (const [name, input] of Object.entries(inputs)) {
      const now = time(() => orderLibrary(input));
      const before = time(() => previousOrder(input));
      const head = time(() => topOf(input, 3));
      report.push(`${name}: ${now.toFixed(1)} ms (before: ${before.toFixed(1)} ms, topOf(3): ${head.toFixed(1)} ms)`);
      // Orders of magnitude above the measured cost: this only catches an accidental O(n²).
      expect(now).toBeLessThan(2_000);
      expect(head).toBeLessThan(2_000);
    }
    console.info(`[librarySort] 25k elements, median of 3 → ${report.join("; ")}`);
  });
});
