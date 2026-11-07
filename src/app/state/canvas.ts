// Workbench layout state. Tile positions are rest positions (tile centers, canvas-local
// px); per-frame motion lives in TilePose (features/workbench/poses.ts), never in React.
// Undo/redo covers the layout only (discoveries are permanent server-side).
import { create } from "zustand";
import type { ElementId } from "../../shared/api.ts";
import { clampPt, keepClear, relax, rescale, tidyLayout, type Bounds, type Pt, type Rect } from "../lib/geometry.ts";
import { KEYS, readJSON, writeJSON } from "../lib/storage.ts";

export const MAX_CANVAS_TILES = 60;
const UNDO_DEPTH = 50;

export type TileFx = "drop" | "spawn" | "pop" | "new" | "first" | "restore";

export interface SavedTile {
  uid: string;
  elementId: ElementId;
  x: number;
  y: number;
}

export interface PendingMerge {
  ingredients: ElementId[];
  /** The input tiles as they were before the merge (restored if the combine fails). */
  inputs: SavedTile[];
}

export interface Tile {
  uid: string;
  /** null while a merge is pending. */
  elementId: ElementId | null;
  x: number;
  y: number;
  z: number;
  pending?: PendingMerge;
  /** Being absorbed into / faded out at this point; removed when the animation ends. */
  leaving?: Pt;
  /** Mount animation starts here instead of at the rest position. */
  enterFrom?: Pt;
  /** One-shot visual effect, re-triggered whenever fxKey changes. */
  fx?: TileFx;
  fxKey?: number;
}

export interface CanvasState {
  tiles: Tile[];
  /** Canvas size the stored positions refer to (for proportional rescale). */
  size: { w: number; h: number } | null;
  bounds: Bounds | null;
  /** Canvas-local rects tiles must not sit under (the floating toolbar). */
  obstacles: Rect[];
  /** Tile size in px (76 phone, 88 desktop). */
  T: number;
  selection: string[];
  /** "⊕ More" mode: taps add to the selection instead of combining immediately. */
  multi: boolean;
  focusUid: string | null;
  undo: SavedTile[][];
  redo: SavedTile[][];
}

let seq = 0;
export const newUid = () => `t${Date.now().toString(36)}${(seq++).toString(36)}`;
let zTop = 1;
let fxSeq = 1;
export const nextFxKey = () => fxSeq++;

interface Persisted {
  w: number;
  h: number;
  tiles: { e: string; x: number; y: number }[];
}

function loadPersisted(): { tiles: Tile[]; size: CanvasState["size"] } {
  const raw = readJSON<Persisted | null>(KEYS.canvas, null);
  if (!raw || !Array.isArray(raw.tiles) || !(raw.w > 0) || !(raw.h > 0)) return { tiles: [], size: null };
  const tiles: Tile[] = [];
  for (const t of raw.tiles.slice(0, MAX_CANVAS_TILES)) {
    if (typeof t?.e !== "string" || !Number.isFinite(t.x) || !Number.isFinite(t.y)) continue;
    tiles.push({ uid: newUid(), elementId: t.e, x: t.x, y: t.y, z: zTop++ });
  }
  return { tiles, size: { w: raw.w, h: raw.h } };
}

function loadUndo(): SavedTile[][] {
  const raw = readJSON<unknown>(KEYS.undo, [], "session");
  return Array.isArray(raw) ? (raw as SavedTile[][]).slice(-UNDO_DEPTH) : [];
}

const initial = loadPersisted();

export const useCanvas = create<CanvasState>(() => ({
  tiles: initial.tiles,
  size: initial.size,
  bounds: null,
  obstacles: [],
  T: 76,
  selection: [],
  multi: false,
  focusUid: null,
  undo: loadUndo(),
  redo: [],
}));

const get = () => useCanvas.getState();
const set = useCanvas.setState;

/** Settled, combinable tiles (not pending, not leaving). */
export const isSettled = (t: Tile): t is Tile & { elementId: ElementId } => !!t.elementId && !t.pending && !t.leaving;

/** Layout snapshot for undo: settled tiles plus the inputs of in-flight merges. */
function snapshotTiles(tiles: readonly Tile[]): SavedTile[] {
  const out: SavedTile[] = [];
  for (const t of tiles) {
    if (isSettled(t)) out.push({ uid: t.uid, elementId: t.elementId, x: t.x, y: t.y });
    else if (t.pending) out.push(...t.pending.inputs);
  }
  return out;
}

let saveTimer: ReturnType<typeof setTimeout> | undefined;
/** Debounced persistence of the layout (and the undo stack, per tab). */
function persist(): void {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    const { tiles, size, undo } = get();
    if (!size) return;
    writeJSON(KEYS.canvas, {
      w: Math.round(size.w),
      h: Math.round(size.h),
      tiles: snapshotTiles(tiles).map((t) => ({ e: t.elementId, x: Math.round(t.x), y: Math.round(t.y) })),
    } satisfies Persisted);
    writeJSON(KEYS.undo, undo.slice(-UNDO_DEPTH), "session");
  }, 300);
}
useCanvas.subscribe((s, prev) => {
  if (s.tiles !== prev.tiles || s.undo !== prev.undo) persist();
});

/** Record the current layout before a committed action. */
export function pushUndo(): void {
  const snap = snapshotTiles(get().tiles);
  set((s) => ({ undo: [...s.undo, snap].slice(-UNDO_DEPTH), redo: [] }));
}

export const canUndo = (s: CanvasState = get()) => s.undo.length > 0 && !s.tiles.some((t) => t.pending);
export const canRedo = (s: CanvasState = get()) => s.redo.length > 0 && !s.tiles.some((t) => t.pending);

function restoreSnapshot(snap: SavedTile[]): void {
  set((s) => {
    const want = new Map(snap.map((t) => [t.uid, t]));
    const tiles: Tile[] = [];
    for (const t of s.tiles) {
      const w = want.get(t.uid);
      if (w) {
        tiles.push({ ...t, x: w.x, y: w.y, leaving: undefined });
        want.delete(t.uid);
      } else if (isSettled(t)) {
        tiles.push({ ...t, leaving: { x: t.x, y: t.y } }); // fade out in place
      } else {
        tiles.push(t);
      }
    }
    for (const w of want.values()) tiles.push({ ...w, z: zTop++, fx: "restore", fxKey: nextFxKey() });
    return { tiles, selection: [], multi: false };
  });
}

export function undo(): boolean {
  const s = get();
  if (!canUndo(s)) return false;
  const snap = s.undo[s.undo.length - 1]!;
  set({ undo: s.undo.slice(0, -1), redo: [...s.redo, snapshotTiles(s.tiles)] });
  restoreSnapshot(snap);
  return true;
}

export function redo(): boolean {
  const s = get();
  if (!canRedo(s)) return false;
  const snap = s.redo[s.redo.length - 1]!;
  set({ redo: s.redo.slice(0, -1), undo: [...s.undo, snapshotTiles(s.tiles)] });
  restoreSnapshot(snap);
  return true;
}

export function bringToFront(uid: string): void {
  const z = zTop++;
  set((s) => ({ tiles: s.tiles.map((t) => (t.uid === uid ? { ...t, z } : t)) }));
}

export function addTile(t: Omit<Tile, "uid" | "z"> & { uid?: string }): string {
  const uid = t.uid ?? newUid();
  set((s) => ({ tiles: [...s.tiles.filter((x) => x.uid !== uid), { ...t, uid, z: zTop++ }] }));
  return uid;
}

export function patchTile(uid: string, patch: Partial<Tile>): void {
  set((s) => ({ tiles: s.tiles.map((t) => (t.uid === uid ? { ...t, ...patch } : t)) }));
}

export function removeTiles(uids: readonly string[]): void {
  const drop = new Set(uids);
  set((s) => ({
    tiles: s.tiles.filter((t) => !drop.has(t.uid)),
    selection: s.selection.filter((u) => !drop.has(u)),
    focusUid: s.focusUid && drop.has(s.focusUid) ? null : s.focusUid,
  }));
}

/** Animate tiles out (fade in place or absorb into `to`), then remove them. */
export function markLeaving(uids: readonly string[], to?: Pt): void {
  const drop = new Set(uids);
  set((s) => ({
    tiles: s.tiles.map((t) => (drop.has(t.uid) ? { ...t, leaving: to ?? { x: t.x, y: t.y } } : t)),
    selection: s.selection.filter((u) => !drop.has(u)),
  }));
}

/** Move a tile, then let overlapping neighbours make room (the moved tile stays put). */
export function placeTile(uid: string, p: Pt): void {
  const { tiles, bounds, T } = get();
  if (!bounds) return;
  const settled = tiles.filter((t) => t.uid === uid || (!t.leaving && (t.elementId || t.pending)));
  const pts = settled.map((t) => (t.uid === uid ? clampPt(p, bounds, T) : { x: t.x, y: t.y }));
  const idx = settled.findIndex((t) => t.uid === uid);
  const relaxed = keepClear(relax(pts, bounds, T, new Set([idx])), get().obstacles, bounds, T);
  const byUid = new Map(settled.map((t, i) => [t.uid, relaxed[i]!]));
  set((s) => ({ tiles: s.tiles.map((t) => (byUid.has(t.uid) ? { ...t, ...byUid.get(t.uid)! } : t)) }));
}

export function tidy(): void {
  const { tiles, bounds, T } = get();
  if (!bounds) return;
  const live = tiles.filter((t) => !t.leaving);
  const pts = keepClear(tidyLayout(live.length, bounds, T), get().obstacles, bounds, T);
  const byUid = new Map(live.map((t, i) => [t.uid, pts[i]!]));
  set((s) => ({ tiles: s.tiles.map((t) => (byUid.has(t.uid) ? { ...t, ...byUid.get(t.uid)! } : t)) }));
}

/**
 * New canvas measurements. When the size changed (resize/orientation), positions scale
 * proportionally, clamp, and relax. `keepLayout` skips the rescale (e.g. while the
 * on-screen keyboard temporarily shrinks the viewport).
 */
export function setBounds(bounds: Bounds, T: number, obstacles: Rect[], keepLayout = false): void {
  const s = get();
  const size = { w: bounds.w, h: bounds.h };
  if (keepLayout && s.size) {
    set({ bounds, T, obstacles });
    return;
  }
  const changed = !s.size || Math.abs(s.size.w - size.w) > 0.5 || Math.abs(s.size.h - size.h) > 0.5 || s.T !== T;
  if (!changed) {
    set({ bounds, obstacles });
    return;
  }
  const live = s.tiles.filter((t) => !t.leaving);
  const scaled = s.size ? rescale(live, s.size, size) : live.map((t) => ({ x: t.x, y: t.y }));
  const relaxed = keepClear(
    relax(
      scaled.map((p) => clampPt(p, bounds, T)),
      bounds,
      T,
    ),
    obstacles,
    bounds,
    T,
  );
  const byUid = new Map(live.map((t, i) => [t.uid, relaxed[i]!]));
  set({
    bounds,
    obstacles,
    T,
    size,
    tiles: s.tiles.map((t) => (byUid.has(t.uid) ? { ...t, ...byUid.get(t.uid)! } : t)),
  });
}

/** Drop tiles whose element this player no longer owns (other player, reset). */
export function pruneTiles(owned: Record<ElementId, unknown>): void {
  set((s) => ({
    tiles: s.tiles.filter((t) => !t.elementId || !!owned[t.elementId] || !!t.pending),
    undo: s.undo.map((snap) => snap.filter((t) => !!owned[t.elementId])),
    redo: [],
  }));
}

export function setSelection(selection: string[], multi = get().multi): void {
  set({ selection, multi: selection.length === 0 ? false : multi });
}

export function setFocus(uid: string | null): void {
  set({ focusUid: uid });
}
