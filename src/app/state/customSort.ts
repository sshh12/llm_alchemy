// Custom library sort engine ("Sort by anything"): the store the UI reads, its actions, and
// the only scheduler of /api/sort traffic.
//
// Invariants:
// - `reconcile()` is the only place work is scheduled. It runs on owned/status/sort changes,
//   after every response, on timers it set itself (backoff, rate-limit wait, auto retry, the
//   select hold), when the sort sheet closes during a hold, and on the player's own actions.
//   Outside `sort === "custom"` it schedules nothing and drops the queue.
// - "Cached" means a whole order (an entry a full run or a mirror filled), never a few
//   piggybacked scores.
// - At most one incremental request is in flight (active key only), and never alongside a full
//   run of the same key. Full runs are not aborted by a spec change: their result is cached under
//   its own key, so switching back is free. At most 2 full runs at once.
// - A response only ever merges into the entry of the key it was sent for, and only commits when
//   that key is still the active one. A player switch or library reset bumps `gen`, so anything
//   still in flight from before is dropped, and every cache (memory and session mirror) is cleared:
//   one player's scores are never shown to another.
// - Failures never clear `committed`: the last order stays visible.
import { create } from "zustand";
import { SORT_IDS_MAX, type CombineResponse, type ElementId, type SortResponse, type SortSpec } from "../../shared/api.ts";
import { normalizeSpec, specKey, specLabel } from "../../shared/sortSpec.ts";
import { track } from "../lib/analytics.ts";
import { ApiFailure, scoreLibrary, type FailureCode } from "../lib/api.ts";
import {
  decodeMirror,
  encodeMirror,
  mergeFullResponse,
  mergeOne,
  mergeResponse,
  newEntry,
  pushRecent,
  readStoredSort,
  writeStoredSort,
  type BuiltInSort,
  type Entry,
  type SavedSort,
} from "../lib/customSort.ts";
import { formatCount } from "../lib/format.ts";
import { countsOf, groupOf, rankOf, topOf, type Bucket, type Committed, type LibraryOrderInput } from "../lib/librarySort.ts";
import { KEYS, readJSON, removeKey, writeJSON } from "../lib/storage.ts";
import { useGame } from "./game.ts";
import { announce, setLibraryView, useUi } from "./ui.ts";

export type SortStatus = "idle" | "scoring" | "ready" | "error";
export type SortSource = "typed" | "example" | "recent" | "search" | "select";

export interface SortFailure {
  code: FailureCode;
  /** Epoch ms: nothing is sent before this (rate limit, budget); then one automatic retry. */
  until?: number;
  scope: "full" | "incremental";
}

export interface CustomSortState {
  /** Active (or last) custom spec, normalized; persisted. */
  spec: SortSpec | null;
  key: string | null;
  /** Persisted display options (never trigger a request). */
  view: { reverse: boolean; other: boolean };
  /** Session only; reset on spec change, clear and leaving custom. */
  bucket: Bucket | null;
  recent: SavedSort[];
  prevSort: BuiltInSort;
  seen: boolean;
  /** The order on screen. May lag `key` while a new spec is weighing; never cleared by failures. */
  committed: Committed | null;
  /** Ids being weighed for `key` (queued, in flight or waiting to be retried). */
  pending: ReadonlySet<ElementId>;
  /** Bumped on a full commit of a new key and on reverse/other toggles (tile stagger, scroll to top). */
  epoch: number;
  /** "scoring" only while a full run for `key` is under way and `committed?.key !== key`. */
  status: SortStatus;
  failure: SortFailure | null;
  /** Owned ids of the active spec that couldn't be weighed after every retry. */
  unweighed: number;
  /** The last full run hit SORT_MAX_ELEMENTS. */
  truncated: boolean;
  /** A full run has been weighing for more than 6 s. */
  slow: boolean;
}

const stored = readStoredSort();

export const useCustomSort = create<CustomSortState>(() => ({
  spec: stored.spec,
  key: stored.spec ? specKey(stored.spec) : null,
  view: stored.view,
  bucket: null,
  recent: stored.recent,
  prevSort: stored.prevSort,
  seen: stored.seen,
  committed: null,
  pending: new Set(),
  epoch: 0,
  status: "idle",
  failure: null,
  unweighed: 0,
  truncated: false,
  slow: false,
}));

const get = useCustomSort.getState;
const set = useCustomSort.setState;

// ------------------------------------------------------------------ module state (non-reactive)

const LRU_SIZE = 4;
const MAX_FULL_RUNS = 2;
const FLUSH_DEBOUNCE_MS = 2_500;
const FLUSH_MAX_WAIT_MS = 8_000;
const FLUSH_AT_COUNT = 100;
const FULL_RETRY_MS = 5_000;
const SLOW_MS = 6_000;
const MIRROR_DEBOUNCE_MS = 1_000;
const NEW_LINE_DELAY_MS = 1_500;
const RATE_LIMIT_DEFAULT_MS = 20_000;
const BUDGET_DEFAULT_MS = 3_600_000;
const MAX_TIMER_MS = 2_147_000_000; // setTimeout's 32-bit ceiling
/** How long the select's ✦ option waits before its network start (see applyCustomSort). */
const SELECT_HOLD_MS = 400;
/** A rate limit longer than this (an hour or day rule) doesn't show queued ids as pending until this close to `until`. */
const LONG_RATE_LIMIT_MS = 30_000;

type Timer = ReturnType<typeof setTimeout> | undefined;

interface FullRun {
  ctrl: AbortController;
}
interface Incremental {
  key: string;
  spec: SortSpec;
  ids: ElementId[];
  ctrl: AbortController;
  gen: number;
}

/** Score entries by spec key, least recently used first. */
const cache = new Map<string, Entry>();
/** Active key only: ids waiting for the next incremental flush. */
const queue = new Set<ElementId>();
/** Active key only: ids of the one incremental request in flight. */
const inflight = new Set<ElementId>();
/** Active key only: ids the server couldn't score yet → not before this time. */
const backoff = new Map<ElementId, number>();
const full = new Map<string, FullRun>();
let inc: Incremental | null = null;
/** Bumped by a player switch or library reset: older responses are dropped on arrival. */
let gen = 0;
/** The player the caches belong to. */
let enginePlayer: string | null = null;
/** A failed full run's silent second try. */
let autoRetry: { key: string; at: number } | null = null;
/** Keys whose full run already used its automatic retry (the next failure is shown). */
const autoRetried = new Set<string>();
/** A select activation that isn't cached: nothing is sent for `key` before `at`. */
let hold: { key: string; at: number } | null = null;
let scoringSince: { key: string; at: number } | null = null;
let firstQueuedAt = 0;
let lastQueuedAt = 0;
let flushTimer: Timer;
let wakeTimer: Timer;
let slowTimer: Timer;
let mirrorTimer: Timer;
let lineTimer: Timer;
/** The apply/activation whose run will send the analytics event when it commits or fails. */
let pendingTrack: { key: string; params: Record<string, string | number | boolean> } | null = null;

const own = (owned: Record<ElementId, unknown>, id: ElementId) => Object.hasOwn(owned, id);

function persist(): void {
  const s = get();
  writeStoredSort({ v: 1, spec: s.spec, view: s.view, recent: s.recent, prevSort: s.prevSort, seen: s.seen });
}

/** Insert or touch `key` in the LRU, evicting the least recently used other than the active key. */
function remember(key: string, e: Entry): void {
  cache.delete(key);
  cache.set(key, e);
  const active = get().key;
  for (const k of cache.keys()) {
    if (cache.size <= LRU_SIZE) break;
    if (k !== active && k !== key) cache.delete(k);
  }
}

/**
 * The active key is still in a select activation's hold: until `at`, and for as long as the sort
 * sheet is open (arrowing past ✦ onto "Custom…" and opening it: the sheet usually applies
 * another spec, and the hold then never sends). Closing the sheet reconciles (useUi below).
 */
function holding(now = Date.now()): boolean {
  if (!hold || hold.key !== get().key) return false;
  return hold.at > now || useUi.getState().sheet === "customSort";
}

/**
 * This tab's session mirror for `key`, when it belongs to the engine's player. Reads and parses
 * sessionStorage: callers ask only when the memory cache has no entry.
 */
function mirrorEntry(key: string, kind: SortSpec["kind"]): Entry | null {
  const pid = useGame.getState().player?.id;
  if (!pid || pid !== enginePlayer) return null;
  return decodeMirror(readJSON<unknown>(KEYS.customSortScores, null, "session"), pid, key, kind);
}

function commit(key: string, spec: SortSpec, e: Entry, bump: boolean): void {
  const committed: Committed = {
    key,
    kind: e.kind,
    spec,
    scores: new Map(e.s),
    groups: e.g && new Map(e.g),
    fit: e.n && new Map(e.n),
  };
  set((s) => ({ committed, epoch: bump ? s.epoch + 1 : s.epoch }));
}

function sameSet(a: ReadonlySet<ElementId>, b: ReadonlySet<ElementId>): boolean {
  if (a.size !== b.size) return false;
  for (const x of b) if (!a.has(x)) return false;
  return true;
}

/** Push the derived fields (pending, status, slow, unweighed) to the store. */
function publish(): void {
  const s = get();
  const key = s.key;
  const now = Date.now();
  const running = !!key && (full.has(key) || autoRetry?.key === key);
  // A select hold already reads as weighing (no "idle" flash before its run starts), but only a
  // run in progress counts towards "slow".
  const status: SortStatus = !key
    ? "idle"
    : s.committed?.key === key
      ? "ready"
      : running || holding(now)
        ? "scoring"
        : s.failure
          ? "error"
          : "idle";
  if (status !== "scoring" || !running) scoringSince = null;
  else if (scoringSince?.key !== key) scoringSince = { key: key!, at: now };
  const slowAt = scoringSince ? scoringSince.at + SLOW_MS : Infinity;
  const slow = now >= slowAt;
  clearTimeout(slowTimer);
  slowTimer = undefined;
  if (!slow && slowAt !== Infinity && useUi.getState().sort === "custom") {
    slowTimer = setTimeout(() => {
      slowTimer = undefined;
      publish();
    }, slowAt - now);
  }
  let unweighed = 0;
  const e = key ? cache.get(key) : undefined;
  if (e) {
    const owned = useGame.getState().owned;
    for (const id of e.failed) if (own(owned, id)) unweighed++;
  }
  // Under a long rate limit (an hour or day rule) queued ids sort as unscored rather than
  // shimmering at the top of the grid for the whole wait; the wake timer shows them as pending
  // again LONG_RATE_LIMIT_MS before the flush at `until`.
  const f = s.failure;
  const longWait = f?.code === "rate_limited" && f.until !== undefined && f.until - now > LONG_RATE_LIMIT_MS;
  const ids = new Set<ElementId>([...(longWait ? [] : queue), ...inflight, ...backoff.keys()]);
  const pending = sameSet(s.pending, ids) ? s.pending : ids;
  if (status !== s.status || slow !== s.slow || unweighed !== s.unweighed || pending !== s.pending) {
    set({ status, slow, unweighed, pending });
  }
}

function toFailure(e: unknown, scope: SortFailure["scope"]): SortFailure {
  const f = e instanceof ApiFailure ? e : new ApiFailure("network", "network");
  const now = Date.now();
  if (f.code === "rate_limited") return { code: f.code, until: now + Math.max(1_000, f.retryAfterMs ?? RATE_LIMIT_DEFAULT_MS), scope };
  if (f.code === "budget_exhausted") return { code: f.code, until: now + Math.max(1_000, f.retryAfterMs ?? BUDGET_DEFAULT_MS), scope };
  return { code: f.code, scope };
}

/** A standing failure holds every send: until its `until`, or until Retry / online / a new apply. */
function sendBlocked(now = Date.now()): boolean {
  const f = get().failure;
  return !!f && (f.until === undefined || f.until > now);
}

/** "m:ss" for a wait. */
export function formatWait(ms: number): string {
  const s = Math.max(0, Math.ceil(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

/** Friendly copy for a failure (the bar message and the assertive announcement). */
export function customSortFailureText(f: SortFailure, now = Date.now()): string {
  switch (f.code) {
    case "rate_limited":
      return `Easy there, alchemist. Weighing resumes in ${formatWait((f.until ?? now) - now)}.`;
    case "budget_exhausted":
      return "Custom sorting is resting until tomorrow. Your other sorts still work.";
    case "network":
      return "You're offline. Showing your last order.";
    case "unauthorized":
      return "Your session expired. Reload to keep playing.";
    default:
      return "The lab's scales are busy. Your order is safe.";
  }
}

function setFailure(f: SortFailure): void {
  set({ failure: f });
  if (useUi.getState().sort === "custom") announce(customSortFailureText(f), true);
}

const sizeBucket = (n: number) => (n < 100 ? "lt100" : n < 1_000 ? "lt1k" : n < 5_000 ? "lt5k" : "5k+");

function finishTrack(key: string, outcome: "ok" | FailureCode): void {
  if (pendingTrack?.key !== key) return;
  track("custom_sort", { ...pendingTrack.params, outcome });
  pendingTrack = null;
}

// ------------------------------------------------------------------ the scheduler

/** Not in custom (or no spec, or not booted): drop queued work and every timer that could send. */
function idle(): void {
  queue.clear();
  backoff.clear();
  hold = null; // left custom inside a select hold: that activation sends nothing
  firstQueuedAt = 0;
  clearTimeout(flushTimer);
  clearTimeout(wakeTimer);
  clearTimeout(lineTimer);
  flushTimer = wakeTimer = lineTimer = undefined;
  if (mirrorTimer !== undefined) writeMirror(); // write it now rather than leave a timer behind
}

function reconcile(opts: { flushNow?: boolean } = {}): void {
  const g = useGame.getState();
  const s = get();
  if (g.status !== "ready" || useUi.getState().sort !== "custom" || !s.spec || !s.key) {
    idle();
    publish();
    return;
  }
  const { spec, key } = s;
  const now = Date.now();
  if (s.failure?.until !== undefined && s.failure.until <= now) set({ failure: null });
  if (hold && !holding(now)) hold = null;

  // 1. The entry; a new one may be filled at once from this tab's session mirror. This commit is
  // the silent restore of a reload (custom already on screen); an activation that finds its
  // scores in the mirror takes applyCustomSort's cached path instead.
  let e = cache.get(key);
  if (e) remember(key, e);
  else {
    const mirrored = mirrorEntry(key, spec.kind);
    e = mirrored ?? newEntry(spec.kind);
    remember(key, e);
    if (mirrored && mirrored.s.size > 0) {
      commit(key, spec, mirrored, false);
      set({ truncated: mirrored.truncated });
    }
  }

  // 2. A run (full, or incremental of this key) is under way: its completion reconciles again.
  if (full.has(key) || inc?.key === key) {
    scheduleWake(now);
    publish();
    return;
  }

  // 3. What is owned but neither known nor on its way.
  for (const [id, at] of backoff) if (at <= now) backoff.delete(id);
  const ownedIds = Object.keys(g.owned);
  const missing = ownedIds.filter(
    (id) => !e.s.has(id) && !e.unscorable.has(id) && !e.failed.has(id) && !queue.has(id) && !inflight.has(id) && !backoff.has(id),
  );

  // 4. A full run when there's little to go on; it waits out failures, the silent auto retry and
  // a select activation's hold.
  if (missing.length > 0 && (e.s.size === 0 || missing.length > SORT_IDS_MAX || missing.length > ownedIds.length / 2)) {
    const waiting = sendBlocked(now) || (autoRetry?.key === key && autoRetry.at > now) || holding(now);
    if (!waiting) startFull(key, spec, ownedIds);
  } else {
    // Scores for this key exist but aren't on screen (e.g. a run finished while away).
    if (get().committed?.key !== key && e.s.size > 0) commit(key, spec, e, true);
    // 5. Otherwise queue the rest. A rate limit only delays the flush; other failures don't queue
    // (those ids stay unscored at the end of the list rather than shimmering for hours).
    const f = get().failure;
    if (f && f.code !== "rate_limited") queue.clear();
    else if (missing.length > 0) {
      for (const id of missing) queue.add(id);
      lastQueuedAt = now;
      if (!firstQueuedAt) firstQueuedAt = now;
    }
    scheduleFlush(opts.flushNow);
  }
  scheduleWake(now);
  publish();
}

/**
 * One timer for everything time-based: failure `until` (and, for a long rate limit, the moment
 * its queued ids show as pending again), the full-run auto retry, a select hold, per-id backoff.
 */
function scheduleWake(now: number): void {
  let at = Infinity;
  const f = get().failure;
  if (f?.until !== undefined && f.until > now) at = f.until;
  if (f?.code === "rate_limited" && f.until !== undefined && f.until - LONG_RATE_LIMIT_MS > now) at = f.until - LONG_RATE_LIMIT_MS;
  if (autoRetry && autoRetry.at > now) at = Math.min(at, autoRetry.at);
  if (hold && hold.key === get().key && hold.at > now) at = Math.min(at, hold.at);
  for (const t of backoff.values()) if (t > now) at = Math.min(at, t);
  clearTimeout(wakeTimer);
  wakeTimer = undefined;
  if (at === Infinity) return;
  wakeTimer = setTimeout(
    () => {
      wakeTimer = undefined;
      reconcile();
    },
    Math.min(MAX_TIMER_MS, at - now),
  );
}

/** Debounce 2.5 s after the last addition, at most 8 s after the first, at once at 100 ids. */
function scheduleFlush(now = false): void {
  clearTimeout(flushTimer);
  flushTimer = undefined;
  if (queue.size === 0) {
    firstQueuedAt = 0;
    return;
  }
  // The request in flight (its completion) or the wake timer (failure until, hold) reconciles again.
  if (inc || sendBlocked() || holding()) return;
  const t = Date.now();
  const at = now || queue.size >= FLUSH_AT_COUNT ? t : Math.min(lastQueuedAt + FLUSH_DEBOUNCE_MS, firstQueuedAt + FLUSH_MAX_WAIT_MS);
  flushTimer = setTimeout(
    () => {
      flushTimer = undefined;
      void flush();
    },
    Math.max(0, at - t),
  );
}

async function flush(): Promise<void> {
  const g = useGame.getState();
  const s = get();
  if (g.status !== "ready" || useUi.getState().sort !== "custom" || !s.spec || !s.key) {
    idle();
    publish();
    return;
  }
  if (inc || full.has(s.key) || sendBlocked() || holding()) return;
  for (const id of queue) if (!own(g.owned, id)) queue.delete(id);
  const ids = [...queue].slice(0, SORT_IDS_MAX);
  if (ids.length === 0) {
    firstQueuedAt = 0;
    publish();
    return;
  }
  for (const id of ids) {
    queue.delete(id);
    inflight.add(id);
  }
  // Leftovers beyond SORT_IDS_MAX go out right after this one.
  firstQueuedAt = queue.size ? Date.now() - FLUSH_MAX_WAIT_MS : 0;
  const req: Incremental = { key: s.key, spec: s.spec, ids, ctrl: new AbortController(), gen };
  inc = req;
  publish();
  let res: SortResponse | null = null;
  let err: unknown = null;
  try {
    res = await scoreLibrary({ spec: req.spec, ids }, req.ctrl.signal);
  } catch (e) {
    err = e;
  }
  if (req.gen !== gen) return; // player switch / reset: its sets were already cleared
  if (inc === req) {
    inc = null;
    for (const id of ids) inflight.delete(id);
  }
  const e = cache.get(req.key);
  const st = get();
  if (res && e) {
    const { requeue } = mergeResponse(e, res, ids);
    if (st.key === req.key) {
      if (st.failure) set({ failure: null });
      const now = Date.now();
      for (const r of requeue) backoff.set(r.id, now + r.delayMs);
      if (st.committed?.key === req.key) commit(req.key, req.spec, e, false);
      scheduleMirror();
      if (res.ids.length === 1) announceNewLater(res.ids[0]!);
    }
  } else if (!res && e && !req.ctrl.signal.aborted && st.key === req.key) {
    const f = toFailure(err, "incremental");
    if (f.code === "rate_limited" || f.code === "budget_exhausted" || f.code === "network" || f.code === "unauthorized") {
      setFailure(f); // reconcile re-queues the ids only under a rate limit
    } else {
      const { requeue } = mergeResponse(e, { engine: "", ids: [], s: [], retry: ids }, ids);
      const now = Date.now();
      for (const r of requeue) backoff.set(r.id, now + r.delayMs);
    }
  }
  reconcile();
}

function startFull(key: string, spec: SortSpec, snapshot: ElementId[]): void {
  if (full.size >= MAX_FULL_RUNS) {
    for (const [k, run] of full) {
      if (k === key) continue;
      run.ctrl.abort();
      full.delete(k);
      break;
    }
  }
  const retrying = autoRetry?.key === key;
  if (retrying) autoRetry = null;
  // The snapshot covers everything owned now; the post-commit reconcile catches anything newer.
  queue.clear();
  backoff.clear();
  clearTimeout(flushTimer);
  flushTimer = undefined;
  firstQueuedAt = 0;
  const run: FullRun = { ctrl: new AbortController() };
  full.set(key, run);
  if (!retrying && get().committed?.key !== key) {
    announce(`Weighing ${formatCount(snapshot.length)} elements for “${specLabel(spec)}”.`);
  }
  void runFull(key, spec, snapshot, run, gen);
}

async function runFull(key: string, spec: SortSpec, snapshot: ElementId[], run: FullRun, runGen: number): Promise<void> {
  let res: SortResponse | null = null;
  let err: unknown = null;
  try {
    res = await scoreLibrary({ spec }, run.ctrl.signal);
  } catch (e) {
    err = e;
  }
  if (runGen !== gen) return; // player switch / reset
  if (full.get(key) === run) full.delete(key);
  if (!res && run.ctrl.signal.aborted) {
    publish(); // aborted as the oldest of three runs: nothing to keep
    return;
  }
  const s = get();
  const isActive = s.key === key;
  if (res) {
    const e = cache.get(key) ?? newEntry(spec.kind);
    remember(key, e);
    const { requeue } = mergeFullResponse(e, res, snapshot);
    autoRetried.delete(key);
    if (isActive) {
      const now = Date.now();
      for (const r of requeue) backoff.set(r.id, now + r.delayMs);
      const showing = useUi.getState().sort === "custom";
      const fresh = s.committed?.key !== key;
      if (s.failure) set({ failure: null });
      // No epoch bump outside custom: it would replay the stagger and scroll a built-in list.
      commit(key, spec, e, showing && fresh);
      set({ truncated: e.truncated });
      if (showing && fresh) announceDone();
      finishTrack(key, "ok");
      scheduleMirror();
    }
  } else if (isActive) {
    const f = toFailure(err, "full");
    const transient = !["rate_limited", "budget_exhausted", "network", "unauthorized"].includes(f.code);
    if (transient && !autoRetried.has(key)) {
      autoRetried.add(key);
      autoRetry = { key, at: Date.now() + FULL_RETRY_MS };
    } else {
      setFailure(f);
      finishTrack(key, f.code);
    }
  }
  reconcile();
}

// ------------------------------------------------------------------ mirror + announcements

function writeMirror(): void {
  clearTimeout(mirrorTimer);
  mirrorTimer = undefined;
  const s = get();
  const g = useGame.getState();
  const pid = g.player?.id;
  if (!pid || pid !== enginePlayer || !s.key) return;
  const e = cache.get(s.key);
  if (!e || e.s.size === 0) return;
  writeJSON(KEYS.customSortScores, encodeMirror(pid, s.key, e, g.owned), "session");
}

function scheduleMirror(): void {
  clearTimeout(mirrorTimer);
  mirrorTimer = setTimeout(writeMirror, MIRROR_DEBOUNCE_MS);
}

/**
 * What the grid orders right now (for "First: …" and group counts). Announcements read it with
 * topOf/countsOf, linear passes over the grid's own comparator: the grid sorts it once already.
 */
function viewInput(): LibraryOrderInput {
  const g = useGame.getState();
  const ui = useUi.getState();
  const s = get();
  return {
    owned: g.owned,
    elements: g.elements,
    pins: ui.pins,
    filter: ui.filter,
    sort: ui.sort,
    query: ui.query,
    now: Date.now(),
    custom: {
      committed: s.committed,
      pending: s.pending,
      reverse: s.view.reverse,
      other: s.view.other,
      bucket: s.bucket,
      prevSort: s.prevSort,
      key: s.key,
    },
  };
}

const nameOf = (id: ElementId) => useGame.getState().elements[id]?.name ?? "";

function announceDone(): void {
  const s = get();
  const c = s.committed;
  if (!c) return;
  if (c.spec.kind === "rank") {
    const first = topOf(viewInput(), 3).map(nameOf).filter(Boolean);
    announce(`Sorted by “${specLabel(c.spec)}”.${first.length ? ` First: ${first.join(", ")}.` : ""}`);
    return;
  }
  const counts = countsOf(viewInput());
  if (counts?.kind !== "groups") return;
  const parts = c.spec.groups.map((g, j) => `${formatCount(counts.groups[j] ?? 0)} ${g}`);
  if (s.view.other) parts.push(`${formatCount(counts.other)} Other`);
  announce(`Grouped: ${parts.join(", ")}.`);
}

/** "Mud ranks #212 of 341 for “spookiest”." once the discovery has settled into the list. */
function announceNewLater(id: ElementId): void {
  clearTimeout(lineTimer);
  lineTimer = setTimeout(() => {
    lineTimer = undefined;
    const s = get();
    const c = s.committed;
    const g = useGame.getState();
    if (useUi.getState().sort !== "custom" || !c || c.key !== s.key || !own(g.owned, id)) return;
    const name = nameOf(id);
    if (!name) return;
    if (c.spec.kind === "rank") {
      const r = rankOf(c, id, s.view.reverse, g.owned, nameOf);
      if (r) announce(`${name} ranks #${formatCount(r.rank)} of ${formatCount(r.of)} for “${specLabel(c.spec)}”.`);
      return;
    }
    const gi = groupOf(c, id, s.view.other);
    if (gi === undefined) return;
    announce(gi === -1 ? `${name} goes in Other.` : `${name} goes in ${c.spec.groups[gi]}.`);
  }, NEW_LINE_DELAY_MS);
}

// ------------------------------------------------------------------ player / library resets

/** Forget every score and abandon everything in flight (another player, or a reset library). */
function resetEngine(): void {
  gen++;
  for (const run of full.values()) run.ctrl.abort();
  full.clear();
  inc?.ctrl.abort();
  inc = null;
  inflight.clear();
  queue.clear();
  backoff.clear();
  firstQueuedAt = 0;
  autoRetry = null;
  autoRetried.clear();
  hold = null;
  scoringSince = null;
  pendingTrack = null;
  for (const t of [flushTimer, wakeTimer, slowTimer, mirrorTimer, lineTimer]) clearTimeout(t);
  flushTimer = wakeTimer = slowTimer = mirrorTimer = lineTimer = undefined;
  cache.clear();
  removeKey(KEYS.customSortScores, "session");
  set({ committed: null, pending: new Set(), status: "idle", failure: null, unweighed: 0, truncated: false, slow: false, bucket: null });
}

/** A new key takes over: incremental work belongs to the old one (full runs keep going). */
function leaveKey(): void {
  if (mirrorTimer !== undefined) writeMirror(); // still the old key's entry
  inc?.ctrl.abort();
  inc = null;
  inflight.clear();
  queue.clear();
  backoff.clear();
  firstQueuedAt = 0;
  clearTimeout(flushTimer);
  clearTimeout(lineTimer);
  flushTimer = lineTimer = undefined;
  autoRetry = null;
  hold = null;
}

// ------------------------------------------------------------------ triggers

useGame.subscribe((s, p) => {
  const pid = s.player?.id ?? null;
  const switched = pid !== null && enginePlayer !== null && pid !== enginePlayer;
  // `owned` only ever grows, except for a progress reset (or a wholesale replace by bootstrap).
  const shrank = s.owned !== p.owned && Object.keys(p.owned).some((id) => !own(s.owned, id));
  if (switched || shrank) resetEngine();
  if (pid !== null) enginePlayer = pid;
  if (switched || shrank || s.owned !== p.owned || s.status !== p.status) reconcile();
});

useUi.subscribe((s, p) => {
  if (s.sort === p.sort) {
    // The sort sheet closed during a select hold: the activation starts now if it still stands.
    if (hold && p.sheet === "customSort" && s.sheet !== "customSort") reconcile();
    return;
  }
  if (p.sort === "custom" && get().bucket !== null) set({ bucket: null });
  reconcile();
});

function onOnline(): void {
  if (get().failure?.code !== "network") return;
  set({ failure: null });
  reconcile({ flushNow: true });
}
/** A reload inside the mirror's 1 s debounce would otherwise lose it and re-weigh everything. */
function onPageHide(): void {
  if (mirrorTimer !== undefined) writeMirror();
}
if (typeof window !== "undefined") {
  window.addEventListener("online", onOnline);
  window.addEventListener("pagehide", onPageHide);
}

// ------------------------------------------------------------------ actions

const SORT_NAMES: Record<BuiltInSort, string> = { recent: "Recent", az: "A–Z", rarity: "Rarity" };

/** Sort the library by `spec` (from cache at once when it has scores, else one full run). */
export function applyCustomSort(spec: SortSpec, opts: { other?: boolean; source?: SortSource; bucket?: Bucket | null } = {}): void {
  const n = normalizeSpec(spec);
  if (!n.ok) return;
  const next = n.spec;
  const key = specKey(next);
  const s = get();
  const ui = useUi.getState();
  const changed = key !== s.key;
  if (changed) leaveKey();
  const now = Date.now();
  // Applying is also a manual retry; only a rate limit or budget still standing carries over.
  const failure = s.failure?.until !== undefined && s.failure.until > now ? s.failure : null;
  autoRetried.delete(key);
  if (autoRetry?.key === key) autoRetry = null;
  const other = opts.other ?? (next.kind === "groups" ? s.view.other : true);
  set({
    spec: next,
    key,
    // The Matches bucket (the search bridge) means "best matches first", and its chip is hidden
    // while reversed: never reverse together with "matches" (toggleReverse keeps the same rule).
    view: { reverse: changed || opts.bucket === "matches" ? false : s.view.reverse, other },
    bucket: opts.bucket ?? null,
    recent: pushRecent(s.recent, next.kind === "groups" ? { spec: next, other } : { spec: next }),
    prevSort: ui.sort !== "custom" ? ui.sort : s.prevSort,
    failure,
    truncated: changed ? false : s.truncated,
  });
  // Scores only in this tab's session mirror (e.g. a reload taken in a built-in sort): an
  // activation from there is a cache hit like any other (epoch bump, announcement, analytics),
  // not reconcile's silent restore for a reload that is already showing custom.
  const e = cache.get(key) ?? mirrorEntry(key, next.kind);
  // Only a whole-library run (or a mirror of one) is a cached order: an entry with a few
  // piggybacked scores still needs its run, and that run's commit announces.
  const cached = !!e && e.complete && e.s.size > 0;
  // A closed native select applies on every arrow key (Windows): arrowing past the ✦ option must
  // cost nothing, so its network start waits SELECT_HOLD_MS, and reconcile skips it when the
  // player has moved on (another sort, or another spec) by then.
  hold = opts.source === "select" && !cached && !failure ? { key, at: now + SELECT_HOLD_MS } : null;
  pendingTrack = {
    key,
    params: {
      kind: next.kind,
      groups: next.kind === "groups" ? next.groups.length : 0,
      source: opts.source ?? "typed",
      size: sizeBucket(Object.keys(useGame.getState().owned).length),
      cached,
    },
  };
  if (cached) {
    remember(key, e);
    commit(key, next, e, true);
    set({ truncated: e.truncated });
    scheduleMirror();
    finishTrack(key, "ok");
  }
  persist();
  setLibraryView({ sort: "custom" });
  if (cached) announceDone();
  reconcile();
  // Nothing can be sent until the budget resets: report the attempt now.
  if (!cached && budgetBlocked()) finishTrack(key, "budget_exhausted");
}

/** The select's "✦ {label}" option: re-apply the stored spec (usually from memory). */
export function activateCustom(): void {
  const s = get();
  if (s.spec) applyCustomSort(s.spec, { other: s.view.other, source: "select" });
}

/** Back to the built-in sort that was active before custom. */
export function clearCustomSort(): void {
  const { prevSort } = get();
  set({ bucket: null });
  setLibraryView({ sort: prevSort });
  announce(`Back to ${SORT_NAMES[prevSort]}.`);
}

/** Rank only: weakest match first. Client-side, no request. */
export function toggleReverse(): void {
  const s = get();
  if (s.spec?.kind !== "rank") return;
  const reverse = !s.view.reverse;
  // The Matches chip is hidden while reversed, so its filter can't stay on.
  set({ view: { ...s.view, reverse }, epoch: s.epoch + 1, bucket: reverse && s.bucket === "matches" ? null : s.bucket });
  persist();
  if (useUi.getState().sort !== "custom") return;
  const first = nameOf(topOf(viewInput(), 1)[0] ?? "");
  if (first) announce(reverse ? `Reversed. ${first} comes first.` : `${first} comes first.`);
}

/** Groups: "Put weak fits in Other". Client-side, no request. */
export function setOtherView(other: boolean): void {
  const s = get();
  if (s.view.other === other) return;
  const head = s.recent[0];
  const recent = head && s.key && specKey(head.spec) === s.key && head.spec.kind === "groups" ? [{ ...head, other }, ...s.recent.slice(1)] : s.recent;
  set({ view: { ...s.view, other }, epoch: s.epoch + 1, bucket: !other && s.bucket === -1 ? null : s.bucket, recent });
  persist();
}

export function setBucket(b: Bucket | null): void {
  set({ bucket: b });
}

/** The bar's Retry: forget failures (and given-up ids) of the active spec and try again now. */
export function retryCustomSort(): void {
  const s = get();
  const e = s.key ? cache.get(s.key) : undefined;
  if (e) {
    for (const id of e.failed) e.attempts.delete(id);
    e.failed.clear();
  }
  if (s.key) {
    autoRetried.delete(s.key);
    if (autoRetry?.key === s.key) autoRetry = null;
  }
  hold = null;
  set({ failure: null });
  reconcile({ flushNow: true });
}

export function markCustomSortSeen(): void {
  if (get().seen) return;
  set({ seen: true });
  persist();
}

/**
 * Applying `spec` shows a whole order at once, from memory or this tab's mirror (no full run).
 * The sheet asks only while budget-blocked, so the mirror read is rare.
 */
export function isCached(spec: SortSpec): boolean {
  const n = normalizeSpec(spec);
  if (!n.ok) return false;
  const key = specKey(n.spec);
  const e = cache.get(key) ?? mirrorEntry(key, n.spec.kind);
  return !!e && e.complete && e.s.size > 0;
}

export function budgetBlocked(): boolean {
  const f = get().failure;
  return f?.code === "budget_exhausted" && (f.until ?? 0) > Date.now();
}

/** The spec to piggyback on POST /api/combine (scores a new discovery in the same call). */
export function customSortForCombine(): { spec: SortSpec; key: string } | null {
  const s = get();
  if (useUi.getState().sort !== "custom" || !s.spec || !s.key || budgetBlocked()) return null;
  return { spec: s.spec, key: s.key };
}

/** Fold a combine response's `sortScore` in before `applyCombine` adds the element to `owned`. */
export function ingestSortScore(sentKey: string, res: CombineResponse): void {
  if (!res.newForPlayer || !res.sortScore) return;
  const e = cache.get(sentKey);
  if (!e) return;
  const id = res.result.id;
  mergeOne(e, id, res.sortScore);
  if (!e.s.has(id)) return;
  const s = get();
  if (s.key !== sentKey) return;
  queue.delete(id);
  backoff.delete(id);
  // While a new spec is still weighing, the full run's commit will carry this score along.
  if (s.committed?.key === sentKey && s.spec) {
    commit(sentKey, s.spec, e, false);
    // The player may have left custom while the combine was out: then schedule nothing.
    if (useUi.getState().sort === "custom") {
      scheduleMirror();
      announceNewLater(id);
    } else writeMirror();
  }
  publish();
}
