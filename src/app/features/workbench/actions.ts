// Workbench actions: spawning, selection, merging (with the optimistic pending tile and
// all feedback tiers), removal, clear, tidy and undo/redo. The drag engine, keyboard
// handlers and buttons all funnel through here.
import type { CombineResponse, ElementId, Tier } from "../../../shared/api.ts";
import { localDay } from "../../../shared/dates.ts";
import { track, trackOncePerSession } from "../../lib/analytics.ts";
import { ApiFailure, combine } from "../../lib/api.ts";
import { findSpawn, type Pt } from "../../lib/geometry.ts";
import { haptic } from "../../lib/haptics.ts";
import { recipeCache } from "../../lib/recipes.ts";
import { playSound } from "../../lib/sound.ts";
import { SPRING } from "../../lib/spring.ts";
import { KEYS, writeString } from "../../lib/storage.ts";
import {
  addTile,
  isSettled,
  markLeaving,
  MAX_CANVAS_TILES,
  newUid,
  nextFxKey,
  patchTile,
  pushUndo,
  redo,
  removeTiles,
  setFocus,
  setSelection,
  tidy,
  undo,
  useCanvas,
  type SavedTile,
} from "../../state/canvas.ts";
import { customSortForCombine, ingestSortScore } from "../../state/customSort.ts";
import { applyCombine, openTargetIds, useGame } from "../../state/game.ts";
import { announce, celebrate, dismissToast, showToast, useUi } from "../../state/ui.ts";
import { canvasRect, layoutEls, libraryEdge } from "./layout.ts";
import { nextMove } from "./poses.ts";

const nameOf = (id: ElementId | null | undefined) => (id ? (useGame.getState().elements[id]?.name ?? "?") : "?");
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Focus this tile once it mounts (keyboard spawn). */
let focusOnMount: string | null = null;
export const consumeFocusOnMount = (uid: string) => {
  if (focusOnMount !== uid) return false;
  focusOnMount = null;
  return true;
};

// ------------------------------------------------------------------ undo snackbar

let undoToast: number | null = null;

function offerUndo(text: string, duration = 5_000): void {
  if (undoToast !== null) dismissToast(undoToast);
  undoToast = showToast({
    kind: "undo",
    text,
    duration,
    action: { label: "Undo", run: doUndo },
  });
}

/** Any new layout action replaces the previous undo offer. */
function commit(): void {
  if (undoToast !== null) dismissToast(undoToast);
  undoToast = null;
  pushUndo();
}

export function doUndo(): void {
  if (undoToast !== null) dismissToast(undoToast);
  undoToast = null;
  if (undo()) announce("Undone.");
}

export function doRedo(): void {
  if (redo()) announce("Redone.");
}

// ------------------------------------------------------------------ spawning

function liveCount(): number {
  return useCanvas.getState().tiles.filter((t) => !t.leaving).length;
}

function canvasFull(): boolean {
  if (liveCount() < MAX_CANVAS_TILES) return false;
  showToast({
    kind: "info",
    text: "The workbench is full. Tidy up or clear it to make room.",
    duration: 5_000,
    action: { label: "Clear", run: clearCanvas },
  });
  return true;
}

/** Height of the canvas-bottom band holding the selection pill / Undo snackbar (px). */
const FLOAT_BAND = 64;

/** Free spot for a new tile inside the part of the canvas the player can actually see. */
function spawnPoint(near?: Pt): Pt | null {
  const { tiles, bounds, T, obstacles } = useCanvas.getState();
  if (!bounds) return null;
  const avoid = [...obstacles];
  // A full phone shelf hides the canvas: get it out of the way. A half shelf stays open
  // (the player is browsing) and new tiles go above it.
  const snap = useUi.getState().shelf;
  if (snap === "full") useUi.setState({ shelf: "peek" });
  const c = canvasRect();
  const lib = layoutEls.library?.getBoundingClientRect();
  let visibleBottom = bounds.h;
  if (snap === "half" && c && lib && lib.top < c.bottom && lib.left < c.right && lib.right > c.left) {
    visibleBottom = lib.top - c.top;
    avoid.push({ x: 0, y: visibleBottom, w: bounds.w, h: c.bottom - lib.top });
  }
  // The selection pill and the Undo snackbar float along the bottom: don't spawn under them.
  avoid.push({ x: 0, y: visibleBottom - FLOAT_BAND, w: bounds.w, h: FLOAT_BAND });
  return findSpawn(
    tiles.filter((t) => !t.leaving),
    bounds,
    T,
    near,
    avoid,
  );
}

/**
 * Tap / Enter on a library element. With a canvas selection this spawns the element and
 * combines it with the selection in one step (or adds it to a multi-selection).
 */
export function spawnElement(elementId: ElementId, opts: { focus?: boolean } = {}): string | null {
  if (canvasFull()) return null;
  const { selection, multi, tiles } = useCanvas.getState();
  const selected = selection.map((u) => tiles.find((t) => t.uid === u)).filter((t) => !!t && isSettled(t));
  const anchor = selected[selected.length - 1];
  const p = spawnPoint(anchor ? { x: anchor.x, y: anchor.y } : undefined);
  if (!p) return null;
  commit();
  const uid = addTile({ elementId, x: p.x, y: p.y, enterFrom: libraryEdge(), fx: "spawn", fxKey: nextFxKey() });
  if (anchor && !multi) {
    void mergeTiles([...selected.map((t) => t!.uid), uid], { x: anchor.x, y: anchor.y }, { snapshot: false });
    return uid;
  }
  if (anchor && multi && selection.length < 4) {
    setSelection([...selection, uid], true);
    announce(`${nameOf(elementId)} added. ${selection.length + 1} selected.`);
    return uid;
  }
  if (opts.focus) {
    focusOnMount = uid;
    setFocus(uid);
  }
  announce(`${nameOf(elementId)} added to the workbench.`);
  return uid;
}

/** A library ghost dropped on empty canvas. Returns the new tile uid. */
export function dropNewTile(elementId: ElementId, at: Pt, from: Pt, snapshot = true): string | null {
  if (canvasFull()) return null;
  if (snapshot) commit();
  return addTile({ elementId, x: at.x, y: at.y, enterFrom: from, fx: "drop", fxKey: nextFxKey() });
}

// ------------------------------------------------------------------ selection (tap path)

export function tapTile(uid: string, opts: { shift?: boolean } = {}): void {
  const { selection, multi, tiles } = useCanvas.getState();
  const tile = tiles.find((t) => t.uid === uid);
  if (!tile || !isSettled(tile)) return;
  if (multi || opts.shift) {
    if (selection.includes(uid)) setSelection(selection.filter((u) => u !== uid), true);
    else if (selection.length < 4) setSelection([...selection, uid], true);
    const n = useCanvas.getState().selection.length;
    announce(n ? `${n} selected.` : "Selection cleared.");
    return;
  }
  if (selection.length === 0) {
    setSelection([uid], false);
    announce(`${nameOf(tile.elementId)} selected. Choose another element to combine.`);
    return;
  }
  if (selection[0] === uid) {
    setSelection([]);
    announce("Selection cleared.");
    return;
  }
  const first = tiles.find((t) => t.uid === selection[0]);
  setSelection([]);
  if (first && isSettled(first)) void mergeTiles([first.uid, uid], { x: tile.x, y: tile.y });
}

export function setMultiSelect(on: boolean): void {
  const { selection } = useCanvas.getState();
  setSelection(selection, on);
}

export function combineSelection(): void {
  const { selection, tiles } = useCanvas.getState();
  const sel = selection.map((u) => tiles.find((t) => t.uid === u)).filter((t) => !!t && isSettled(t));
  if (sel.length < 2) return;
  const at = sel[0]!;
  setSelection([]);
  void mergeTiles(
    sel.map((t) => t!.uid),
    { x: at.x, y: at.y },
  );
}

export function clearSelection(): void {
  setSelection([]);
}

// ------------------------------------------------------------------ merging

const ERROR_COPY: Partial<Record<ApiFailure["code"], string>> = {
  budget_exhausted: "The lab is out of fresh reagents for today. Known recipes still work!",
  fizzled: "That mix fizzled. Try it again, or try something new.",
  ai_unavailable: "The alchemist is catching their breath. Try again in a moment.",
  not_owned: "You don't have one of those yet.",
  timeout: "That took too long. Give it another try.",
};

function failureMessage(e: unknown): { text: string; until?: number } {
  const f = e instanceof ApiFailure ? e : new ApiFailure("network", "network");
  if (f.code === "rate_limited") {
    const ms = Math.max(3_000, f.retryAfterMs ?? 20_000);
    return { text: "Easy there, alchemist. Try again in", until: Date.now() + ms };
  }
  if (f.code === "network") {
    return {
      text: navigator.onLine === false
        ? "You're offline. New mixes need a connection."
        : "Couldn't reach the lab. Check your connection and try again.",
    };
  }
  if (f.code === "unauthorized") return { text: "Your session expired. Reload to keep playing." };
  return { text: ERROR_COPY[f.code] ?? "Something went wrong. Try again." };
}

interface MergeOpts {
  /** Push an undo snapshot first (false when the caller already did). */
  snapshot?: boolean;
}

/**
 * Combine 2–4 canvas tiles: inputs are absorbed into `at`, a pending crucible tile
 * appears there, and the result replaces it when the server (or the local recipe
 * cache) answers. On failure the inputs spring back to where they were.
 */
export async function mergeTiles(uids: readonly string[], at: Pt, opts: MergeOpts = {}): Promise<void> {
  const { tiles } = useCanvas.getState();
  const inputs = uids
    .map((u) => tiles.find((t) => t.uid === u))
    .filter((t): t is NonNullable<typeof t> => !!t && !t.pending && !t.leaving && !!t.elementId)
    .slice(0, 4);
  if (inputs.length < 2) return;
  if (opts.snapshot !== false) commit();
  const undoEntry = useCanvas.getState().undo.at(-1);

  const saved: SavedTile[] = inputs.map((t) => ({ uid: t.uid, elementId: t.elementId!, x: t.x, y: t.y }));
  const ids = saved.map((t) => t.elementId);
  const pendingUid = newUid();
  addTile({ uid: pendingUid, elementId: null, x: at.x, y: at.y, pending: { ingredients: ids, inputs: saved } });
  markLeaving(
    saved.map((t) => t.uid),
    at,
  );
  haptic("merge");
  playSound("merge");
  announce(`Combining ${ids.map(nameOf).join(" and ")}…`);

  const game = useGame.getState();
  const cached = recipeCache.get(ids);
  const local = !!cached && !!game.owned[cached] && !!game.elements[cached] && !openTargetIds(game).has(cached);
  const started = performance.now();
  let res: CombineResponse;
  try {
    if (local) {
      res = { result: game.elements[cached]!, newForPlayer: false, firstEver: false, recipeNew: false, completed: [] };
    } else {
      // An active custom sort rides along so a new discovery is scored in the same call.
      const sent = customSortForCombine();
      res = await combine({ ids, clientDate: localDay(), ...(sent ? { sort: sent.spec } : {}) });
      // Before applyCombine adds it to `owned`, so the sort engine never asks for it again.
      if (sent) ingestSortScore(sent.key, res);
    }
  } catch (e) {
    failMerge(pendingUid, saved, at, e, undoEntry);
    return;
  }
  // Let the absorb + crucible read as a beat even when the answer is instant.
  const minPending = local ? 420 : 260;
  const elapsed = performance.now() - started;
  if (elapsed < minPending) await sleep(minPending - elapsed);
  succeedMerge(pendingUid, ids, res, local);
}

function failMerge(pendingUid: string, saved: SavedTile[], at: Pt, e: unknown, undoEntry: SavedTile[] | undefined): void {
  const s = useCanvas.getState();
  // Forget the undo snapshot taken for this merge: the layout is being restored.
  if (undoEntry) useCanvas.setState({ undo: s.undo.filter((u) => u !== undoEntry) });
  if (s.tiles.some((t) => t.uid === pendingUid)) {
    removeTiles([pendingUid]);
    for (const t of saved) addTile({ ...t, enterFrom: at, fx: "restore", fxKey: nextFxKey() });
  }
  track("combine_failed", { code: e instanceof ApiFailure ? e.code : "network" });
  const { text, until } = failureMessage(e);
  showToast({
    kind: "error",
    text,
    until,
    duration: until ? Math.min(60_000, until - Date.now()) : 4_500,
    action: e instanceof ApiFailure && e.code === "unauthorized" ? { label: "Reload", run: () => location.reload() } : undefined,
  });
  haptic("error");
  playSound("error");
  announce(until ? `${text} a few seconds.` : text, true);
}

function succeedMerge(pendingUid: string, ids: ElementId[], res: CombineResponse, local: boolean): void {
  const result = res.result;
  if (!local) applyCombine(res);
  recipeCache.set(ids, result.id);
  writeString(KEYS.merged, "1");

  const onCanvas = useCanvas.getState().tiles.some((t) => t.uid === pendingUid);
  const fx = res.firstEver ? "first" : res.newForPlayer ? "new" : "pop";
  if (onCanvas) patchTile(pendingUid, { elementId: result.id, pending: undefined, fx, fxKey: nextFxKey() });

  const recipe = `${ids.map(nameOf).join(" + ")} → ${result.name}`;
  track("combine", { inputs: ids.length, cached: local, new: res.newForPlayer });
  trackOncePerSession("first_combine", { inputs: ids.length });
  if (res.firstEver) {
    haptic("first");
    playSound("first");
    announce(`First discovery in the world: ${result.name}!`);
    celebrate({ kind: "first", elementId: result.id, ingredients: ids, at: new Date().toISOString() });
    track("first_discovery", { rarity: result.rarity, notable: result.notable });
    track("discovery", { first: true, rarity: result.rarity });
  } else if (res.newForPlayer) {
    haptic("new");
    playSound("new");
    announce(`New: ${result.name}.`);
    showToast({ kind: "new", text: result.name, elementId: result.id, notable: result.notable, duration: 2_500 });
    track("discovery", { first: false, rarity: result.rarity });
  } else {
    announce(`${result.name}.`);
  }
  if (onCanvas) offerUndo(recipe);
  if (res.completed.length > 0) {
    celebrate({ kind: "challenge", tiers: res.completed as Tier[] });
    for (const tier of res.completed) track("challenge_complete", { tier });
  }
  if (useGame.getState().day !== localDay()) {
    showToast({
      kind: "info",
      text: "It's a new day: fresh challenges are ready.",
      duration: 10_000,
      action: { label: "Refresh", run: () => location.reload() },
    });
  }
}

// ------------------------------------------------------------------ remove / clear / tidy

export function removeTile(uid: string, toLibrary = false): void {
  const t = useCanvas.getState().tiles.find((x) => x.uid === uid);
  if (!t || !isSettled(t)) return;
  commit();
  markLeaving([uid], toLibrary ? libraryEdge() : undefined);
  offerUndo(`Put ${nameOf(t.elementId)} away`);
}

export function clearCanvas(): void {
  const live = useCanvas.getState().tiles.filter(isSettled);
  if (live.length === 0) return;
  commit();
  markLeaving(live.map((t) => t.uid));
  setSelection([]);
  offerUndo("Workbench cleared", 8_000);
  announce("Workbench cleared. Press Control Z to undo.");
}

export function tidyCanvas(): void {
  const live = useCanvas.getState().tiles.filter((t) => !t.leaving);
  if (live.length === 0) return;
  commit();
  live.forEach((t, i) => nextMove.set(t.uid, { ...SPRING.tidy, delay: i * 15 }));
  tidy();
  announce("Workbench tidied.");
}

/** Ingredient names for a recipe row ("Fire + Water"). */
export const recipeLabel = (ids: readonly ElementId[]) => ids.map(nameOf).join(" + ");

/** True while the shelf should get out of the way (drag from an expanded phone shelf). */
export function collapseShelf(): void {
  if (useUi.getState().shelf !== "peek") useUi.setState({ shelf: "peek" });
}
