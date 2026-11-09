// The visible library order (filter, search, pins, built-in sorts and the custom sort), as a
// pure function so both layouts and the custom-sort engine (announcements) share it.
import { SORT_FIT_THRESHOLD, SORT_MATCH_THRESHOLD, type ElementDTO, type ElementId, type SortSpec } from "../../shared/api.ts";
import { RARITY_ORDER } from "../../shared/rarity.ts";
import { starterRank } from "../../shared/starters.ts";
import type { Owned } from "../state/game.ts";
import type { LibraryFilter, LibrarySort } from "../state/ui.ts";
import type { BuiltInSort } from "./customSort.ts";

export const NEW_WINDOW_MS = 24 * 3_600_000;

/** A custom-sort bucket: "matches" (rank), or a group index (-1 = Other). */
export type Bucket = "matches" | number;

/** The scores the grid is ordered by. Can lag the active spec while a new one is weighing. */
export interface Committed {
  key: string;
  kind: SortSpec["kind"];
  spec: SortSpec;
  scores: ReadonlyMap<ElementId, number>;
  groups: ReadonlyMap<ElementId, number> | null;
  fit: ReadonlyMap<ElementId, number> | null;
}

export interface CustomOrder {
  committed: Committed | null;
  /** Ids being weighed for the active spec (shown first). */
  pending: ReadonlySet<ElementId>;
  reverse: boolean;
  other: boolean;
  bucket: Bucket | null;
  prevSort: BuiltInSort;
  /**
   * The active spec's key. When given, a bucket only filters a committed order of that same key
   * (so "Matches" for a new prompt never filters by the previous prompt's scores).
   */
  key?: string | null;
}

export type CustomCounts =
  | { kind: "rank"; all: number; matches: number }
  | { kind: "groups"; all: number; groups: number[]; other: number };

export interface LibraryOrderInput {
  owned: Record<ElementId, Owned>;
  elements: Record<ElementId, ElementDTO>;
  pins: ReadonlySet<ElementId>;
  filter: LibraryFilter;
  sort: LibrarySort;
  query: string;
  now: number;
  /** Required for sort "custom" (null falls back to Recent order). */
  custom: CustomOrder | null;
}

/** Group index for `id` (-1 = Other when `other` is on and the fit is weak); undefined when unscored. */
export function groupOf(c: Committed, id: ElementId, other: boolean): number | undefined {
  const g = c.groups?.get(id);
  if (g === undefined || c.spec.kind !== "groups" || g >= c.spec.groups.length) return undefined;
  if (other && (c.fit?.get(id) ?? 0) < SORT_FIT_THRESHOLD) return -1;
  return g;
}

/**
 * 1-based rank of `id` among the owned scored ids, best first, or worst first when reversed.
 * With `nameOf`, equal scores are broken by name exactly as the grid orders them, so "#r of n"
 * matches the tile's place among scored tiles; without it, ties share a rank. Null when `id`
 * is not owned or not scored.
 */
export function rankOf(
  c: Committed,
  id: ElementId,
  reverse: boolean,
  owned: Record<ElementId, unknown>,
  nameOf?: (id: ElementId) => string,
): { rank: number; of: number } | null {
  const mine = c.scores.get(id);
  if (mine === undefined || !Object.hasOwn(owned, id)) return null;
  const myName = nameOf?.(id);
  let ahead = 0;
  let of = 0;
  for (const [other, s] of c.scores) {
    if (!Object.hasOwn(owned, other)) continue;
    of++;
    if (reverse ? s < mine : s > mine) ahead++;
    else if (s === mine && myName !== undefined && other !== id && nameOf!(other).localeCompare(myName) < 0) ahead++;
  }
  return { rank: ahead + 1, of };
}

const LEVELS = ["No match", "Slight match", "Partial match", "Clear match", "Perfect match"] as const;

/**
 * Level words for a 0..1000 score (the five rubric levels). Anything in Matches says at least
 * "Clear match": plain rounding would call 600–624 "Partial match" next to the Matches chip.
 */
export const levelLabel = (s: number): string =>
  LEVELS[s >= SORT_MATCH_THRESHOLD ? (s >= 875 ? 4 : 3) : Math.max(0, Math.round(s / 250))]!;

/**
 * One visible id with every sort key computed once. The comparators then only read plain
 * fields: at 20-25k elements, Map/Set lookups and Date.parse per comparison cost several times
 * the sort itself, on every discovery.
 */
interface Row {
  id: ElementId;
  name: string;
  /** 0 when the name starts with the query (or there is no query), else 1. */
  prefix: number;
  /** 0 when pinned (or under the Pinned filter, where pins don't reorder), else 1. */
  pin: number;
  /** discoveredAt in epoch ms (0 when unparseable); only filled when an order reads it. */
  time: number;
  /** Index in RARITY_ORDER, and depth (rarity order only). */
  rarity: number;
  depth: number;
  /** A starter's shelf position (STARTER_ORDER), -1 for every other element. */
  starter: number;
  /** Custom: 0 = being weighed, 1 = scored, 2 = not scored and not pending (by the previous sort). */
  tier: number;
  /** Custom: the score, -1 when unscored. */
  s: number;
  /** Custom groups: group index (-1 = Other), undefined without a usable group; its display slot; the fit. */
  group: number | undefined;
  slot: number;
  n: number;
}

interface Prepared {
  /** The visible rows (filtered, bucket applied), unsorted. */
  rows: Row[];
  /** The total order of the grid: ties end in the name, then the stable input order. */
  cmp: (a: Row, b: Row) => number;
  counts: CustomCounts | null;
}

/** Filter, decorate and count once; orderLibrary, topOf and countsOf share it so they never disagree. */
function prepare(i: LibraryOrderInput, countsOnly = false): Prepared {
  const { owned, elements: els, pins, filter, sort, query, now, custom } = i;
  const q = query.trim().toLowerCase();
  const cutoff = now - NEW_WINDOW_MS;
  const c = sort === "custom" ? (custom?.committed ?? null) : null;
  // Built-in sorts, or custom with nothing weighed yet: the previous sort's order.
  const base: BuiltInSort = sort === "custom" ? (custom?.prevSort ?? "recent") : sort;
  // Always the committed kind: committed scores can lag behind a new spec.
  const groupsMode = c?.kind === "groups";
  const groupCount = c?.spec.kind === "groups" ? c.spec.groups.length : 0;
  const pending = custom?.pending;
  const other = custom?.other ?? true;
  const needTime = base === "recent" || c !== null; // custom: the pending tier is newest first
  const needRarity = base === "rarity";

  let rows: Row[] = [];
  for (const id of Object.keys(owned)) {
    const el = els[id];
    if (!el) continue;
    const o = owned[id]!;
    if (filter === "pinned" && !pins.has(id)) continue;
    if (filter === "firsts" && !o.first) continue;
    if (filter === "new" && (el.starter || Date.parse(o.discoveredAt) < cutoff)) continue;
    const lower = q ? el.name.toLowerCase() : "";
    if (q && !lower.includes(q)) continue;
    const row: Row = {
      id,
      name: el.name,
      // Prefix matches first while searching.
      prefix: q && !lower.startsWith(q) ? 1 : 0,
      pin: filter !== "pinned" && !pins.has(id) ? 1 : 0,
      time: needTime ? Date.parse(o.discoveredAt) || 0 : 0,
      rarity: needRarity ? RARITY_ORDER.indexOf(el.rarity) : 0,
      // Within a tier, deeper is rarer. Starters are always the least rare; elements whose depth
      // is unknown (no current path from the starters) sit just above them.
      depth: needRarity ? (el.starter ? -1 : (el.depth ?? 0.5)) : 0,
      starter: el.starter ? starterRank(el.name) : -1,
      tier: 1,
      s: -1,
      group: undefined,
      slot: 0,
      n: 0,
    };
    if (c) {
      const sc = c.scores.get(id);
      row.tier = pending!.has(id) ? 0 : sc !== undefined ? 1 : 2;
      row.s = sc ?? -1;
      if (groupsMode) {
        const g = groupOf(c, id, other);
        row.group = g;
        // Real groups in display order, then Other, then (defensively) scored ids with no usable group.
        row.slot = g === undefined ? groupCount + 1 : g === -1 ? groupCount : g;
        row.n = c.fit?.get(id) ?? 0;
      }
    }
    rows.push(row);
  }

  const byName = (a: Row, b: Row) => a.name.localeCompare(b.name);
  // Starters tie on time and rarity (they arrive together), so those orders show them in shelf
  // order (STARTER_ORDER: the onboarding pair first) rather than alphabetically. A–Z stays A–Z.
  const byShelf = (a: Row, b: Row) => (a.starter >= 0 && b.starter >= 0 ? a.starter - b.starter : 0);
  const bySort: (a: Row, b: Row) => number =
    base === "az"
      ? byName
      : base === "rarity"
        ? (a, b) => b.rarity - a.rarity || b.depth - a.depth || byShelf(a, b) || byName(a, b)
        : (a, b) => b.time - a.time || byShelf(a, b) || byName(a, b);

  if (!c || !custom) {
    return { rows, counts: null, cmp: (a, b) => a.prefix - b.prefix || a.pin - b.pin || bySort(a, b) };
  }

  let counts: CustomCounts;
  if (groupsMode) {
    const perGroup = Array.from({ length: groupCount }, () => 0);
    let otherN = 0;
    for (const r of rows) {
      if (r.group === undefined) continue;
      if (r.group === -1) otherN++;
      else perGroup[r.group]!++;
    }
    counts = { kind: "groups", all: rows.length, groups: perGroup, other: otherN };
  } else {
    let matches = 0;
    for (const r of rows) if (r.s >= SORT_MATCH_THRESHOLD) matches++;
    counts = { kind: "rank", all: rows.length, matches };
  }
  if (countsOnly) return { rows, counts, cmp: () => 0 };

  const { reverse, bucket } = custom;
  const bucketApplies =
    bucket !== null && (custom.key == null || custom.key === c.key) && (groupsMode ? typeof bucket === "number" : bucket === "matches");
  if (bucketApplies) {
    rows = rows.filter((r) => r.tier === 0 || (bucket === "matches" ? r.s >= SORT_MATCH_THRESHOLD : r.group === bucket));
  }

  const prev = bySort; // the previous sort orders the unscored tier
  const newestFirst = (a: Row, b: Row) => b.time - a.time || byShelf(a, b) || byName(a, b);
  if (!groupsMode) {
    const cmp = (a: Row, b: Row) => {
      const head = a.prefix - b.prefix || a.pin - b.pin || a.tier - b.tier;
      if (head) return head;
      if (a.tier === 0) return newestFirst(a, b);
      if (a.tier === 2) return prev(a, b);
      return (reverse ? a.s - b.s : b.s - a.s) || byName(a, b);
    };
    return { rows, counts, cmp };
  }

  const cmp = (a: Row, b: Row) => {
    let d = a.prefix - b.prefix || a.tier - b.tier;
    if (d) return d;
    if (a.tier === 1) {
      d = a.slot - b.slot;
      if (d) return d;
    }
    d = a.pin - b.pin;
    if (d) return d;
    if (a.tier === 0) return newestFirst(a, b);
    if (a.tier === 2) return prev(a, b);
    // The group probability saturates for clear members (live Jev gives most of them 1000), so
    // the fit (how clearly it belongs in any group) breaks those ties before the name does.
    if (a.slot < groupCount) return b.s - a.s || b.n - a.n || byName(a, b);
    return byName(a, b);
  };
  return { rows, counts, cmp };
}

/** Ordered visible ids, plus custom-sort bucket counts (null unless a custom order is committed). */
export function orderLibrary(i: LibraryOrderInput): { ids: ElementId[]; counts: CustomCounts | null } {
  const { rows, cmp, counts } = prepare(i);
  rows.sort(cmp);
  return { ids: rows.map((r) => r.id), counts };
}

/**
 * The first `k` ids of orderLibrary(i) in one linear pass, without sorting (the engine's
 * "First: …" and "… comes first" lines, next to the grid's own sort). Equal rows keep their
 * input order, exactly like the stable sort.
 */
export function topOf(i: LibraryOrderInput, k: number): ElementId[] {
  if (k <= 0) return [];
  const { rows, cmp } = prepare(i);
  const top: Row[] = [];
  for (const r of rows) {
    if (top.length === k && cmp(r, top[k - 1]!) >= 0) continue;
    let at = top.length;
    while (at > 0 && cmp(r, top[at - 1]!) < 0) at--;
    top.splice(at, 0, r);
    if (top.length > k) top.pop();
  }
  return top.map((r) => r.id);
}

/** orderLibrary(i).counts without sorting (the groups "done" announcement). */
export function countsOf(i: LibraryOrderInput): CustomCounts | null {
  return prepare(i, true).counts;
}
