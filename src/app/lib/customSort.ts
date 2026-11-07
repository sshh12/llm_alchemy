// Pure pieces of the custom library sort ("Sort by anything"): the persisted preferences
// (localStorage, ~1 KB: the spec, view toggles, recents), the in-memory score entry for one
// spec and how server responses merge into it, and the sessionStorage score mirror that makes
// a reload instant. Scores never go to localStorage (it already holds the multi-MB legacy blob).
import { SORT_GROUPS_MAX, SORT_RUBRIC, type ElementId, type SortResponse, type SortScore, type SortSpec } from "../../shared/api.ts";
import { normalizeSpec, specKey } from "../../shared/sortSpec.ts";
import { KEYS, readJSON, writeJSON } from "./storage.ts";

export type BuiltInSort = "recent" | "az" | "rarity";

export interface SavedSort {
  spec: SortSpec;
  /** groups only: the "Put weak fits in Other" switch it was applied with. */
  other?: boolean;
}

export interface StoredSort {
  v: 1;
  /** Active (or last) custom spec, always normalized. */
  spec: SortSpec | null;
  view: { reverse: boolean; other: boolean };
  /** Newest first, unique by specKey, at most RECENT_MAX. */
  recent: SavedSort[];
  /** The built-in sort to go back to when custom is cleared. */
  prevSort: BuiltInSort;
  /** The player has opened the custom sort sheet (hides the "new" dot). */
  seen: boolean;
}

export const RECENT_MAX = 5;

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);

/** A stored spec, re-validated exactly like a typed one; anything off → null. */
export function parseSpec(v: unknown): SortSpec | null {
  if (!isObj(v)) return null;
  let spec: SortSpec;
  if (v.kind === "rank" && typeof v.prompt === "string") spec = { kind: "rank", prompt: v.prompt };
  else if (v.kind === "groups" && Array.isArray(v.groups) && v.groups.every((g) => typeof g === "string")) spec = { kind: "groups", groups: v.groups as string[] };
  else return null;
  const n = normalizeSpec(spec);
  return n.ok ? n.spec : null;
}

const isBuiltIn = (v: unknown): v is BuiltInSort => v === "recent" || v === "az" || v === "rarity";

export const defaultStoredSort = (): StoredSort => ({
  v: 1,
  spec: null,
  view: { reverse: false, other: true },
  recent: [],
  prevSort: "recent",
  seen: false,
});

/** Read the persisted preferences, validating every field on its own (garbage → that field's default). */
export function readStoredSort(raw: unknown = readJSON<unknown>(KEYS.customSort, null)): StoredSort {
  const d = defaultStoredSort();
  if (!isObj(raw) || raw.v !== 1) return d;
  const view = isObj(raw.view) ? raw.view : {};
  let recent: SavedSort[] = [];
  if (Array.isArray(raw.recent)) {
    for (const r of raw.recent) {
      if (!isObj(r)) continue;
      const spec = parseSpec(r.spec);
      if (!spec) continue;
      const saved: SavedSort = spec.kind === "groups" && typeof r.other === "boolean" ? { spec, other: r.other } : { spec };
      // Stored newest first: keep that order, dropping invalid rows and later duplicates.
      if (!recent.some((x) => specKey(x.spec) === specKey(spec))) recent = [...recent, saved];
    }
    recent = recent.slice(0, RECENT_MAX);
  }
  return {
    v: 1,
    spec: parseSpec(raw.spec),
    view: {
      reverse: typeof view.reverse === "boolean" ? view.reverse : d.view.reverse,
      other: typeof view.other === "boolean" ? view.other : d.view.other,
    },
    recent,
    prevSort: isBuiltIn(raw.prevSort) ? raw.prevSort : d.prevSort,
    seen: raw.seen === true,
  };
}

export function writeStoredSort(s: StoredSort): void {
  writeJSON(KEYS.customSort, s);
}

/** Dedupe by specKey, newest first, at most RECENT_MAX. */
export function pushRecent(recent: readonly SavedSort[], s: SavedSort): SavedSort[] {
  const k = specKey(s.spec);
  return [s, ...recent.filter((r) => specKey(r.spec) !== k)].slice(0, RECENT_MAX);
}

// ------------------------------------------------------------------ score entries

/** Everything known about one spec's scores for the current player (in memory only). */
export interface Entry {
  kind: SortSpec["kind"];
  /** 0..1000 per scored id (rank: match strength; groups: probability of the chosen group). */
  s: Map<ElementId, number>;
  /** groups only: best group index. */
  g: Map<ElementId, number> | null;
  /** groups only: 0..1000 fit (below SORT_FIT_THRESHOLD → Other). */
  n: Map<ElementId, number> | null;
  /** The server said these are not owned/active (or beyond SORT_MAX_ELEMENTS): never request them again. */
  unscorable: Set<ElementId>;
  /** Gave up after RETRY_DELAYS_MS.length + 1 attempts; only a manual Retry asks again. */
  failed: Set<ElementId>;
  /** Unanswered attempts per id (cleared once it is scored). */
  attempts: Map<ElementId, number>;
  /**
   * A whole-library run has merged into this entry (or it came from an accepted mirror). Only a
   * complete entry counts as cached: piggybacked or incremental scores alone cover a few ids.
   */
  complete: boolean;
  /** The last whole-library run hit SORT_MAX_ELEMENTS (its oldest ids are in `unscorable`). */
  truncated: boolean;
}

export function newEntry(kind: SortSpec["kind"]): Entry {
  const groups = kind === "groups";
  return {
    kind,
    s: new Map(),
    g: groups ? new Map() : null,
    n: groups ? new Map() : null,
    unscorable: new Set(),
    failed: new Set(),
    attempts: new Map(),
    complete: false,
    truncated: false,
  };
}

/** Backoff before re-asking for an id the server could not score (1st, 2nd retry); the 3rd miss fails it. */
export const RETRY_DELAYS_MS = [4_000, 20_000] as const;

/** A score as a clean 0..1000 integer, or null when the value is unusable. */
function permille(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? Math.min(1000, Math.max(0, Math.round(v))) : null;
}
const groupIndex = (v: unknown): number | null =>
  typeof v === "number" && Number.isInteger(v) && v >= 0 && v < SORT_GROUPS_MAX ? v : null;

function store(e: Entry, id: ElementId, sc: { s: unknown; g?: unknown; n?: unknown }): boolean {
  const s = permille(sc.s);
  if (s === null) return false;
  if (e.kind === "groups") {
    const g = groupIndex(sc.g);
    const n = permille(sc.n);
    if (g === null || n === null) return false;
    e.g!.set(id, g);
    e.n!.set(id, n);
  }
  e.s.set(id, s);
  e.failed.delete(id);
  e.attempts.delete(id);
  e.unscorable.delete(id);
  return true;
}

/** One more unanswered attempt for `id`: the delay before asking again, or null once it has failed. */
function miss(e: Entry, id: ElementId): number | null {
  const a = (e.attempts.get(id) ?? 0) + 1;
  e.attempts.set(id, a);
  const delay = RETRY_DELAYS_MS[a - 1];
  if (delay === undefined) {
    e.failed.add(id);
    return null;
  }
  return delay;
}

/**
 * Merge a /api/sort response. `requested` is what the request covered: the owned snapshot of
 * a full run, or the ids sent. Returns the ids to ask for again and after how long.
 * - scored ids: stored (a malformed value counts as a miss, like a retry id);
 * - `retry` ids: re-queued after 4 s, then 20 s, then failed;
 * - requested ids in neither list: unscorable (not owned/active, or cut by `truncated`).
 * A retry (or malformed value) for an id that already has a score keeps that score: the server
 * re-scores the whole library on every full run, so a transient miss there is not a reason to
 * show a ranked tile as weighing again or to count it towards "couldn't be weighed".
 */
export function mergeResponse(
  e: Entry,
  res: SortResponse,
  requested: readonly ElementId[],
): { requeue: { id: ElementId; delayMs: number }[] } {
  const requeue: { id: ElementId; delayMs: number }[] = [];
  const answered = new Set<ElementId>();
  const again = (id: ElementId) => {
    if (e.s.has(id)) return;
    const delayMs = miss(e, id);
    if (delayMs !== null) requeue.push({ id, delayMs });
  };
  const ids = Array.isArray(res.ids) ? res.ids : [];
  ids.forEach((id, i) => {
    if (typeof id !== "string" || answered.has(id)) return;
    answered.add(id);
    if (!store(e, id, { s: res.s?.[i], g: res.g?.[i], n: res.n?.[i] })) again(id);
  });
  for (const id of Array.isArray(res.retry) ? res.retry : []) {
    if (typeof id !== "string" || answered.has(id)) continue;
    answered.add(id);
    again(id);
  }
  for (const id of requested) if (!answered.has(id)) e.unscorable.add(id);
  return { requeue };
}

/** A whole-library response (`snapshot` = owned ids when it was sent): merged, and the entry is now complete. */
export function mergeFullResponse(e: Entry, res: SortResponse, snapshot: readonly ElementId[]): { requeue: { id: ElementId; delayMs: number }[] } {
  const out = mergeResponse(e, res, snapshot);
  e.complete = true;
  e.truncated = res.truncated === true;
  return out;
}

/** Merge one piggybacked score (POST /api/combine). Malformed scores are ignored. */
export function mergeOne(e: Entry, id: ElementId, sc: SortScore): void {
  store(e, id, sc);
}

// ------------------------------------------------------------------ session mirror

/** Scores of the active spec, mirrored to sessionStorage for an instant order after a reload. */
export interface MirrorV1 {
  v: 1;
  /** SORT_RUBRIC the scores were made with. */
  r: string;
  /** Player id: a mirror never shows one player's scores to another. */
  p: string;
  /** specKey. */
  k: string;
  ids: string[];
  s: number[];
  g?: number[];
  n?: number[];
  /**
   * Owned ids the server ruled out (not active, or cut by SORT_MAX_ELEMENTS). Without them a
   * reload would count a truncated library's oldest ids as missing and re-weigh everything.
   */
  u?: string[];
  /** The last whole-library run was truncated. */
  t?: true;
}

/** Only ids that are both owned and scored (or owned and unscorable). */
export function encodeMirror(playerId: string, key: string, e: Entry, owned: Record<ElementId, unknown>): MirrorV1 {
  const ids = [...e.s.keys()].filter((id) => Object.hasOwn(owned, id));
  const m: MirrorV1 = { v: 1, r: SORT_RUBRIC, p: playerId, k: key, ids, s: ids.map((id) => e.s.get(id)!) };
  if (e.kind === "groups") {
    m.g = ids.map((id) => e.g!.get(id)!);
    m.n = ids.map((id) => e.n!.get(id)!);
  }
  const u = [...e.unscorable].filter((id) => Object.hasOwn(owned, id) && !e.s.has(id));
  if (u.length) m.u = u;
  if (e.truncated) m.t = true;
  return m;
}

/**
 * A mirror for exactly this player, spec and rubric, with aligned arrays; anything else → null.
 * The entry counts as complete: a mirror is only written from an order that was on screen.
 */
export function decodeMirror(raw: unknown, playerId: string, key: string, kind: SortSpec["kind"]): Entry | null {
  if (!isObj(raw) || raw.v !== 1 || raw.r !== SORT_RUBRIC || raw.p !== playerId || raw.k !== key) return null;
  if (key.startsWith("r:") !== (kind === "rank")) return null;
  const { ids, s, g, n, u } = raw;
  if (!Array.isArray(ids) || !Array.isArray(s) || ids.length !== s.length) return null;
  if (kind === "groups" && (!Array.isArray(g) || !Array.isArray(n) || g.length !== ids.length || n.length !== ids.length)) return null;
  // Optional (older mirrors have none); a present but non-array value means the record is off.
  if (u !== undefined && !Array.isArray(u)) return null;
  const e = newEntry(kind);
  for (let i = 0; i < ids.length; i++) {
    const id = ids[i];
    if (typeof id !== "string") return null;
    if (!store(e, id, { s: s[i], g: (g as unknown[] | undefined)?.[i], n: (n as unknown[] | undefined)?.[i] })) return null;
  }
  for (const id of (u as unknown[] | undefined) ?? []) if (typeof id === "string" && !e.s.has(id)) e.unscorable.add(id);
  e.complete = true;
  e.truncated = raw.t === true;
  return e;
}
