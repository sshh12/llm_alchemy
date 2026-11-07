// Hand-rolled pointer drag engine (mouse, touch and pen through one Pointer Events path).
//
// Library presses must coexist with native scrolling of the shelf, so activation depends
// on where the press started (see ux-design.md §1.3):
//   shelf-x (phone peek row, touch-action: pan-x)  → upward-dominant move, or long-press
//   shelf-y / rail (grids, touch-action: pan-y)    → sideways-dominant move, or long-press
//   canvas (touch-action: none)                    → 3 px (mouse) / 6 px (touch)
// Taps spawn (library) or select (canvas). Hold + release opens quick actions.
// While a drag is active, a non-passive touchmove listener cancels scrolling, and all
// visual motion is written through TilePose (no React renders per frame).
import { create } from "zustand";
import type { ElementId } from "../../../shared/api.ts";
import { clampPt, dist, magnetOffset, MERGE_RADIUS, trackTarget, type Candidate, type Pt } from "../../lib/geometry.ts";
import { haptic } from "../../lib/haptics.ts";
import { playSound } from "../../lib/sound.ts";
import { SPRING } from "../../lib/spring.ts";
import { bringToFront, isSettled, placeTile, pushUndo, setSelection, useCanvas } from "../../state/canvas.ts";
import { openDetails, useUi } from "../../state/ui.ts";
import { collapseShelf, dropNewTile, mergeTiles, removeTile, spawnElement, tapTile } from "./actions.ts";
import { canvasRect, overLibrary, toCanvas } from "./layout.ts";
import { held, poses, TilePose } from "./poses.ts";

export type PressMode = "shelf-x" | "shelf-y" | "rail" | "canvas";

/** React-visible drag state (changes a few times per gesture, never per frame). */
export const useDrag = create<{
  ghost: { elementId: ElementId; pose: TilePose } | null;
  /** What is being dragged right now (null when idle). */
  source: "canvas" | "library" | null;
  stack: number;
}>(() => ({ ghost: null, source: null, stack: 1 }));

const GATHER_MS = 450;
const GATHER_SPEED = 0.15; // px/ms
const HOLD_MS_LIBRARY = 250;
const HOLD_MS_CANVAS = 500;
const MAX_INPUTS = 4;
/** Canvas tile scale while pressed (before the gesture resolves). */
const PRESSED = 0.96;

type Source = { kind: "canvas"; uid: string } | { kind: "library"; elementId: ElementId };

interface Session {
  pointerId: number;
  touch: boolean;
  mode: PressMode;
  source: Source;
  pressEl: HTMLElement;
  sx: number;
  sy: number;
  t0: number;
  x: number;
  y: number;
  lastT: number;
  speed: number;
  active: boolean;
  held: boolean;
  holdTimer: ReturnType<typeof setTimeout> | undefined;
  /** Offset from pointer to the dragged tile's center (client px). */
  grab: Pt;
  rect: DOMRect | null;
  pose: TilePose | null;
  origin: Pt | null;
  target: string | null;
  targetSince: number;
  gathered: string[];
  overLibrary: boolean;
  raf: number;
  shift: boolean;
}

let s: Session | null = null;

/** iOS only honors preventDefault on touchmove if a non-passive listener existed at touchstart. */
export function installTouchGuard(): void {
  window.addEventListener("touchmove", () => {}, { passive: false });
}

// ------------------------------------------------------------------ press entry points

export function pressLibraryTile(e: React.PointerEvent<HTMLElement>, elementId: ElementId, mode: PressMode): void {
  if (s || (e.pointerType === "mouse" && e.button !== 0) || !e.isPrimary) return;
  const r = e.currentTarget.getBoundingClientRect();
  const T = useCanvas.getState().T;
  const k = T / r.width;
  begin(e, { kind: "library", elementId }, mode, {
    x: (r.left + r.width / 2 - e.clientX) * k,
    y: (r.top + r.height / 2 - e.clientY) * k,
  });
}

export function pressCanvasTile(e: React.PointerEvent<HTMLElement>, uid: string): void {
  if (s || (e.pointerType === "mouse" && e.button !== 0) || !e.isPrimary) return;
  const tile = useCanvas.getState().tiles.find((t) => t.uid === uid);
  if (!tile || !isSettled(tile)) return;
  const rect = canvasRect();
  if (!rect) return;
  const pose = poses.get(uid);
  const c = pose?.point ?? tile;
  begin(e, { kind: "canvas", uid }, "canvas", { x: rect.left + c.x - e.clientX, y: rect.top + c.y - e.clientY });
}

function begin(e: React.PointerEvent<HTMLElement>, source: Source, mode: PressMode, grab: Pt): void {
  const now = performance.now();
  s = {
    pointerId: e.pointerId,
    touch: e.pointerType !== "mouse",
    mode,
    source,
    pressEl: e.currentTarget,
    sx: e.clientX,
    sy: e.clientY,
    t0: now,
    x: e.clientX,
    y: e.clientY,
    lastT: now,
    speed: 0,
    active: false,
    held: false,
    holdTimer: undefined,
    grab,
    rect: null,
    pose: null,
    origin: null,
    target: null,
    targetSince: 0,
    gathered: [],
    overLibrary: false,
    raf: 0,
    shift: e.shiftKey,
  };
  // Press-in feedback until the gesture resolves (lift, tap, scroll or menu).
  s.pressEl.setAttribute("data-pressed", "");
  if (source.kind === "canvas") poses.get(source.uid)?.s.to(PRESSED, SPRING.press);
  if (s.touch) {
    const ms = mode === "canvas" ? HOLD_MS_CANVAS : HOLD_MS_LIBRARY;
    s.holdTimer = setTimeout(onHold, ms);
  }
  window.addEventListener("pointermove", onMove);
  window.addEventListener("pointerup", onUp);
  window.addEventListener("pointercancel", onCancel);
  window.addEventListener("touchmove", blockScroll, { passive: false });
  window.addEventListener("contextmenu", preventDefault, true);
  window.addEventListener("keydown", onKey);
}

function cleanup(): void {
  if (!s) return;
  clearTimeout(s.holdTimer);
  cancelAnimationFrame(s.raf);
  s.pressEl.removeAttribute("data-held");
  s.pressEl.removeAttribute("data-pressed");
  if (!s.active && s.source.kind === "canvas") poses.get(s.source.uid)?.s.to(1, SPRING.settle);
  window.removeEventListener("pointermove", onMove);
  window.removeEventListener("pointerup", onUp);
  window.removeEventListener("pointercancel", onCancel);
  window.removeEventListener("touchmove", blockScroll);
  window.removeEventListener("contextmenu", preventDefault, true);
  window.removeEventListener("keydown", onKey);
  s = null;
}

const preventDefault = (e: Event) => e.preventDefault();

function blockScroll(e: TouchEvent): void {
  if (s && (s.active || s.held) && e.cancelable) e.preventDefault();
}

/** Swallow the click the browser synthesizes after a drag ends on a button. */
function suppressNextClick(): void {
  const stop = (e: Event) => {
    e.stopPropagation();
    e.preventDefault();
  };
  window.addEventListener("click", stop, { capture: true, once: true });
  setTimeout(() => window.removeEventListener("click", stop, { capture: true }), 400);
}

// ------------------------------------------------------------------ gesture recognition

function onHold(): void {
  if (!s || s.active) return;
  s.held = true;
  if (s.source.kind === "canvas") poses.get(s.source.uid)?.s.to(1.05, SPRING.pickup);
  else s.pressEl.setAttribute("data-held", "");
  haptic("pickup");
}

function slopFor(sess: Session): number {
  if (sess.touch) return 6;
  return sess.mode === "canvas" ? 3 : 4;
}

function shouldActivate(sess: Session, dx: number, dy: number): "yes" | "no" | "wait" {
  if (!sess.touch || sess.mode === "canvas" || sess.held) return "yes";
  if (sess.mode === "shelf-x") {
    if (dy <= -10 && Math.abs(dy) >= 1.2 * Math.abs(dx)) return "yes";
    return Math.hypot(dx, dy) > 10 ? "no" : "wait";
  }
  if (Math.abs(dx) >= 10 && Math.abs(dx) >= 1.5 * Math.abs(dy)) return "yes";
  return Math.abs(dy) > 8 ? "no" : "wait";
}

function onMove(e: PointerEvent): void {
  if (!s || e.pointerId !== s.pointerId) return;
  const now = performance.now();
  const step = Math.hypot(e.clientX - s.x, e.clientY - s.y);
  const dt = Math.max(1, now - s.lastT);
  s.speed = s.speed * 0.6 + (step / dt) * 0.4;
  s.x = e.clientX;
  s.y = e.clientY;
  s.lastT = now;
  s.shift = e.shiftKey;
  if (!s.active) {
    const dx = e.clientX - s.sx;
    const dy = e.clientY - s.sy;
    if (Math.hypot(dx, dy) <= slopFor(s)) return;
    clearTimeout(s.holdTimer);
    const verdict = shouldActivate(s, dx, dy);
    if (verdict === "wait") return;
    if (verdict === "no") {
      cleanup(); // native scrolling wins
      return;
    }
    activate(e.pointerId);
  }
  if (!s.raf) s.raf = requestAnimationFrame(() => frame());
}

function activate(pointerId: number): void {
  if (!s) return;
  s.active = true;
  s.pressEl.removeAttribute("data-held");
  s.pressEl.removeAttribute("data-pressed");
  try {
    document.body.setPointerCapture(pointerId);
  } catch {
    // Pointer already released; the window listeners still see the gesture end.
  }
  s.rect = canvasRect();
  const { T } = useCanvas.getState();
  haptic("pickup");
  playSound("pickup");
  if (s.source.kind === "canvas") {
    const uid = s.source.uid;
    const tile = useCanvas.getState().tiles.find((t) => t.uid === uid)!;
    s.origin = { x: tile.x, y: tile.y };
    held.add(uid);
    bringToFront(uid);
    setSelection([]);
    s.pose = poses.get(uid) ?? null;
    s.pose?.el?.setAttribute("data-dragging", "");
  } else {
    s.pose = new TilePose({ x: s.x + s.grab.x, y: s.y + s.grab.y }, T);
    useDrag.setState({ ghost: { elementId: s.source.elementId, pose: s.pose } });
  }
  collapseShelf(); // the canvas must be visible under the finger
  s.pose?.s.to(1.08, SPRING.pickup);
  s.pose?.lift.to(1, SPRING.pickup);
  useDrag.setState({ source: s.source.kind, stack: 1 });
}

/**
 * Per-frame drag update: move the visual, track the merge target, gather, hover zones.
 * `final` is the release frame: it resolves the target but never starts a gather.
 */
function frame(final = false): void {
  if (!s || !s.active) return;
  s.raf = 0;
  const { T, tiles } = useCanvas.getState();
  const rect = s.rect;
  const cx = s.x + s.grab.x;
  const cy = s.y + s.grab.y;
  const local = toCanvas(cx, cy, rect);
  const now = performance.now();

  const over = overLibrary(s.x, s.y);
  if (over !== s.overLibrary) {
    s.overLibrary = over;
    useUi.setState({ shelfDropActive: over && s.source.kind === "canvas" });
  }

  const insideCanvas = !!rect && s.x >= rect.left && s.x <= rect.right && s.y >= rect.top && s.y <= rect.bottom;
  const stackSize = 1 + s.gathered.length;
  let target: { uid: string; d: number } | null = null;
  if (!over && insideCanvas && stackSize < MAX_INPUTS) {
    const exclude = new Set([...(s.source.kind === "canvas" ? [s.source.uid] : []), ...s.gathered]);
    const candidates: Candidate[] = tiles.filter((t) => isSettled(t) && !exclude.has(t.uid)).map((t) => ({ uid: t.uid, x: t.x, y: t.y }));
    target = trackTarget(local, candidates, T, s.target);
  }
  if ((target?.uid ?? null) !== s.target) {
    if (s.target) poses.get(s.target)?.el?.removeAttribute("data-target");
    s.target = target?.uid ?? null;
    s.targetSince = now;
    if (s.target) {
      poses.get(s.target)?.el?.setAttribute("data-target", "");
      haptic("lock");
    }
  }

  // Gather: hover a target steadily to pick it up into the stack (3–4 input merges).
  if (!final && s.target && now - s.targetSince >= GATHER_MS && s.speed < GATHER_SPEED && stackSize + 1 <= MAX_INPUTS) {
    gather(s.target);
  }

  // Magnetism (cosmetic): pull the visual toward the locked target.
  let off: Pt = { x: 0, y: 0 };
  const tgt = s.target ? tiles.find((t) => t.uid === s!.target) : undefined;
  if (tgt) off = magnetOffset(local, tgt, T);
  if (s.pose) {
    if (s.source.kind === "canvas") s.pose.jumpTo({ x: local.x + off.x, y: local.y + off.y });
    else s.pose.jumpTo({ x: cx + off.x, y: cy + off.y });
  }
}

function gather(uid: string): void {
  if (!s) return;
  poses.get(uid)?.el?.removeAttribute("data-target");
  s.gathered.push(uid);
  s.target = null;
  held.add(uid);
  const p = poses.get(uid);
  if (p && s.pose) {
    const toward = s.source.kind === "canvas" ? s.pose.point : toCanvas(s.pose.x.value, s.pose.y.value, s.rect);
    p.moveTo(toward, SPRING.absorb);
    p.s.to(0.7, SPRING.absorb);
    p.o.to(0, SPRING.absorb);
  }
  haptic("gather");
  playSound("pickup");
  const n = 1 + s.gathered.length;
  s.pose?.el?.setAttribute("data-stack", String(n));
  s.pose?.el?.style.setProperty("--stack", `"${n}"`);
  useDrag.setState({ stack: n });
}

function releaseGathered(gathered: readonly string[]): void {
  const { tiles } = useCanvas.getState();
  for (const uid of gathered) {
    held.delete(uid);
    const t = tiles.find((x) => x.uid === uid);
    const p = poses.get(uid);
    if (!t || !p) continue;
    p.moveTo(t, SPRING.settle);
    p.s.to(1, SPRING.settle);
    p.o.to(1, SPRING.settle);
  }
}

// ------------------------------------------------------------------ release

function onUp(e: PointerEvent): void {
  if (!s || e.pointerId !== s.pointerId) return;
  const sess = s;
  if (!sess.active) {
    const moved = Math.hypot(e.clientX - sess.sx, e.clientY - sess.sy);
    const dt = performance.now() - sess.t0;
    const tapLimit = sess.touch ? (sess.mode === "canvas" ? 300 : 250) : 1_000;
    cleanup();
    if (sess.held && moved <= 6) openQuickActions(sess);
    else if (moved <= slopFor(sess) && dt < tapLimit) onTap(sess);
    return;
  }
  sess.x = e.clientX;
  sess.y = e.clientY;
  frame(true);
  cleanup();
  suppressNextClick();
  drop(sess);
}

function onCancel(e: PointerEvent): void {
  if (!s || e.pointerId !== s.pointerId) return;
  const sess = s;
  if (!sess.active) {
    cleanup(); // the browser took over a scroll before the drag started
    return;
  }
  // Chromium can cancel a long-press-activated touch drag that moves along the scroller's
  // pan axis (no further touch events follow). The finger was carrying the tile to where it
  // last was, so resolve it as a drop there rather than snapping it back.
  if (sess.touch) {
    frame(true);
    cleanup();
    suppressNextClick();
    drop(sess);
  } else {
    cleanup();
    abort(sess);
  }
}

function onKey(e: KeyboardEvent): void {
  if (e.key !== "Escape" || !s) return;
  const sess = s;
  cleanup();
  if (sess.active) abort(sess);
}

function onTap(sess: Session): void {
  if (sess.source.kind === "library") spawnElement(sess.source.elementId);
  else tapTile(sess.source.uid, { shift: sess.shift });
}

function openQuickActions(sess: Session): void {
  // The touch's compatibility mouse events would focus the tile, which reads as "focus left
  // the menu" and closes it again: cancel them by cancelling the touchend that follows.
  if (sess.touch) {
    window.addEventListener("touchend", preventDefault, { capture: true, once: true, passive: false });
    setTimeout(() => window.removeEventListener("touchend", preventDefault, { capture: true }), 400);
  }
  const r = sess.pressEl.getBoundingClientRect();
  const anchor = { x: r.left, y: r.top, w: r.width, h: r.height };
  if (sess.source.kind === "library") openDetails({ elementId: sess.source.elementId, source: "library", anchor });
  else {
    const t = useCanvas.getState().tiles.find((x) => x.uid === (sess.source as { uid: string }).uid);
    if (t?.elementId) openDetails({ elementId: t.elementId, source: "canvas", uid: t.uid, anchor });
  }
}

function endVisuals(sess: Session): void {
  if (sess.target) poses.get(sess.target)?.el?.removeAttribute("data-target");
  sess.pose?.el?.removeAttribute("data-dragging");
  sess.pose?.el?.removeAttribute("data-stack");
  sess.pose?.s.to(1, SPRING.settle);
  sess.pose?.lift.to(0, SPRING.settle);
  useUi.setState({ shelfDropActive: false });
  useDrag.setState({ ghost: null, source: null, stack: 1 });
}

function abort(sess: Session): void {
  endVisuals(sess);
  releaseGathered(sess.gathered);
  if (sess.source.kind === "canvas") {
    held.delete(sess.source.uid);
    if (sess.origin) sess.pose?.moveTo(sess.origin, SPRING.settle);
  }
}

function drop(sess: Session): void {
  const { T, tiles, bounds } = useCanvas.getState();
  const rect = sess.rect;
  const raw = toCanvas(sess.x + sess.grab.x, sess.y + sess.grab.y, rect);
  const visual = sess.pose
    ? sess.source.kind === "canvas"
      ? sess.pose.point
      : toCanvas(sess.pose.x.value, sess.pose.y.value, rect)
    : raw;
  const target = sess.target ? tiles.find((t) => t.uid === sess.target && isSettled(t)) : undefined;
  const overLib = sess.overLibrary;
  const insideCanvas = !!rect && sess.y >= rect.top && sess.y <= rect.bottom && sess.x >= rect.left && sess.x <= rect.right;
  const sourceUid = sess.source.kind === "canvas" ? sess.source.uid : null;
  endVisuals(sess);
  if (sourceUid) held.delete(sourceUid);
  for (const g of sess.gathered) held.delete(g);

  // 1) Released over the library: put a canvas tile away / cancel a library drag.
  if (overLib) {
    releaseGathered(sess.gathered);
    if (sourceUid) removeTile(sourceUid, true);
    return;
  }

  const stack = [...(sourceUid ? [sourceUid] : []), ...sess.gathered];
  const mergeHit = !!target && dist(raw, target) < MERGE_RADIUS * T;

  // 2) Merge into the locked target, or merge a gathered stack where it was released.
  if (mergeHit || (sess.gathered.length > 0 && insideCanvas)) {
    pushUndo();
    if (sess.source.kind === "library") {
      const at = bounds ? clampPt(raw, bounds, T) : raw;
      const uid = dropNewTile(sess.source.elementId, at, visual, false);
      if (!uid) return;
      stack.unshift(uid);
    }
    const at = mergeHit && target ? { x: target.x, y: target.y } : bounds ? clampPt(raw, bounds, T) : raw;
    void mergeTiles(mergeHit && target ? [...stack, target.uid] : stack, at, { snapshot: false });
    return;
  }

  // 3) Place on the canvas (clamped; neighbours make room).
  if (!bounds) return;
  const at = clampPt(raw, bounds, T);
  if (sess.source.kind === "library") {
    dropNewTile(sess.source.elementId, at, visual);
    return;
  }
  if (sourceUid && sess.origin) {
    if (dist(at, sess.origin) > 2) pushUndo();
    sess.pose?.moveTo(at, SPRING.settle);
    placeTile(sourceUid, at);
  }
}
