// Pure workbench geometry: positions are tile centers in canvas-local CSS pixels.
// Everything here is deterministic and unit-tested (geometry.test.ts).

export interface Pt {
  x: number;
  y: number;
}

/** Canvas size plus per-side padding (8 px + safe-area inset on screen-edge sides). */
export interface Bounds {
  w: number;
  h: number;
  left: number;
  right: number;
  top: number;
  bottom: number;
}

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** Spacing between tiles in lattice layouts (spawn search, tidy). */
export const LATTICE_GAP = 12;

export const clamp = (v: number, lo: number, hi: number) => (v < lo ? lo : v > hi ? hi : v);

export function smoothstep(edge0: number, edge1: number, x: number): number {
  const t = clamp((x - edge0) / (edge1 - edge0), 0, 1);
  return t * t * (3 - 2 * t);
}

export const dist = (a: Pt, b: Pt) => Math.hypot(a.x - b.x, a.y - b.y);

/** Keep a tile center inside the canvas (centered when the canvas is smaller than a tile). */
export function clampPt(p: Pt, b: Bounds, T: number): Pt {
  const minX = b.left + T / 2;
  const maxX = b.w - b.right - T / 2;
  const minY = b.top + T / 2;
  const maxY = b.h - b.bottom - T / 2;
  return {
    x: minX > maxX ? b.w / 2 : clamp(p.x, minX, maxX),
    y: minY > maxY ? b.h / 2 : clamp(p.y, minY, maxY),
  };
}

/** Fraction of a T×T tile's area covered by another tile centered at `b`. */
export function overlapRatio(a: Pt, b: Pt, T: number): number {
  const ox = Math.max(0, T - Math.abs(a.x - b.x));
  const oy = Math.max(0, T - Math.abs(a.y - b.y));
  return (ox * oy) / (T * T);
}

/** Proportionally map positions from an old canvas size to a new one. */
export function rescale(points: readonly Pt[], from: { w: number; h: number }, to: { w: number; h: number }): Pt[] {
  const sx = from.w > 0 ? to.w / from.w : 1;
  const sy = from.h > 0 ? to.h / from.h : 1;
  return points.map((p) => ({ x: p.x * sx, y: p.y * sy }));
}

/**
 * Push apart tiles that overlap by more than 25% of their area, then clamp into bounds.
 * `pinned` indices never move (e.g. a tile the player just placed keeps its spot and
 * neighbours make room). Runs a fixed number of pairwise passes.
 */
export function relax(points: readonly Pt[], b: Bounds, T: number, pinned: ReadonlySet<number> = new Set(), iterations = 3): Pt[] {
  const out = points.map((p) => ({ ...p }));
  const target = T + 4;
  for (let it = 0; it < iterations; it++) {
    let moved = false;
    for (let i = 0; i < out.length; i++) {
      for (let j = i + 1; j < out.length; j++) {
        const a = out[i]!;
        const c = out[j]!;
        if (overlapRatio(a, c, T) <= 0.25) continue;
        const pi = pinned.has(i);
        const pj = pinned.has(j);
        if (pi && pj) continue;
        let dx = c.x - a.x;
        let dy = c.y - a.y;
        if (dx === 0 && dy === 0) {
          // Identical centers: separate along a deterministic direction.
          const ang = ((i * 7 + j * 13) % 16) * (Math.PI / 8);
          dx = Math.cos(ang);
          dy = Math.sin(ang);
        }
        // Separate along the axis that needs the smaller displacement.
        const needX = target - Math.abs(dx);
        const needY = target - Math.abs(dy);
        const alongX = needX <= needY;
        const need = alongX ? needX : needY;
        const sign = alongX ? Math.sign(dx) || 1 : Math.sign(dy) || 1;
        const shareA = pi ? 0 : pj ? 1 : 0.5;
        const shareC = 1 - shareA;
        if (alongX) {
          a.x -= sign * need * shareA;
          c.x += sign * need * shareC;
        } else {
          a.y -= sign * need * shareA;
          c.y += sign * need * shareC;
        }
        moved = true;
      }
    }
    for (let i = 0; i < out.length; i++) if (!pinned.has(i)) out[i] = clampPt(out[i]!, b, T);
    if (!moved) break;
  }
  return out;
}

/**
 * Move tiles out from under fixed obstacles (e.g. the canvas toolbar): each overlapping
 * tile takes the smallest in-bounds step up or left that clears the rect.
 */
export function keepClear(points: readonly Pt[], rects: readonly Rect[], b: Bounds, T: number): Pt[] {
  return points.map((p) => {
    let q = p;
    for (const r of rects) {
      if (!inRect(q, r, T)) continue;
      const options = [
        clampPt({ x: q.x, y: r.y - T / 2 - 2 }, b, T),
        clampPt({ x: r.x - T / 2 - 2, y: q.y }, b, T),
      ].filter((o) => !inRect(o, r, T));
      if (options.length) q = options.reduce((m, o) => (dist(o, q) < dist(m, q) ? o : m));
    }
    return q;
  });
}

function inRect(p: Pt, r: Rect, T: number): boolean {
  return p.x + T / 2 > r.x && p.x - T / 2 < r.x + r.w && p.y + T / 2 > r.y && p.y - T / 2 < r.y + r.h;
}

/**
 * Nearest free lattice cell to `start` (canvas center by default): a cell is free when
 * no existing tile center lies within 0.9·T and it doesn't touch an `avoid` rect.
 */
export function findSpawn(existing: readonly Pt[], b: Bounds, T: number, start?: Pt, avoid: readonly Rect[] = []): Pt {
  const origin = clampPt(start ?? { x: b.w / 2, y: (b.h - b.bottom + b.top) / 2 }, b, T);
  const cell = T + LATTICE_GAP;
  const nx = Math.ceil(b.w / cell) + 1;
  const ny = Math.ceil(b.h / cell) + 1;
  const cells: Pt[] = [];
  for (let i = -nx; i <= nx; i++) {
    for (let j = -ny; j <= ny; j++) cells.push({ x: origin.x + i * cell, y: origin.y + j * cell });
  }
  cells.sort((p, q) => dist(p, origin) - dist(q, origin));
  const minX = b.left + T / 2 - 0.5;
  const maxX = b.w - b.right - T / 2 + 0.5;
  const minY = b.top + T / 2 - 0.5;
  const maxY = b.h - b.bottom - T / 2 + 0.5;
  for (const c of cells) {
    if (c.x < minX || c.x > maxX || c.y < minY || c.y > maxY) continue;
    if (avoid.some((r) => inRect(c, r, T))) continue;
    if (existing.some((e) => dist(e, c) < 0.9 * T)) continue;
    return c;
  }
  // Canvas is crowded: nudge off the origin so the new tile is still visible.
  const n = existing.length;
  return clampPt({ x: origin.x + ((n % 5) - 2) * 10, y: origin.y + ((n % 3) - 1) * 10 }, b, T);
}

/** Pack `n` tiles into centered rows from the top-left, compressing rows to fit the height. */
export function tidyLayout(n: number, b: Bounds, T: number): Pt[] {
  if (n === 0) return [];
  const availW = Math.max(T, b.w - b.left - b.right);
  const availH = Math.max(T, b.h - b.top - b.bottom);
  const cell = T + LATTICE_GAP;
  const cols = Math.max(1, Math.min(n, Math.floor((availW + LATTICE_GAP) / cell)));
  const rows = Math.ceil(n / cols);
  const totalW = cols * cell - LATTICE_GAP;
  const x0 = b.left + (availW - totalW) / 2 + T / 2;
  let cy = cell;
  if (rows > 1 && (rows - 1) * cell + T > availH) cy = Math.max(T * 0.55, (availH - T) / (rows - 1));
  const y0 = b.top + T / 2 + 4;
  const out: Pt[] = [];
  for (let i = 0; i < n; i++) {
    const r = Math.floor(i / cols);
    const c = i % cols;
    out.push(clampPt({ x: x0 + c * cell, y: y0 + r * cy }, b, T));
  }
  return out;
}

/** Would the layout benefit from Tidy? (many overlapping tiles, or most lattice cells used) */
export function needsTidy(points: readonly Pt[], b: Bounds, T: number): boolean {
  const cell = T + LATTICE_GAP;
  const capacity = Math.max(1, Math.floor((b.w - b.left - b.right + LATTICE_GAP) / cell)) *
    Math.max(1, Math.floor((b.h - b.top - b.bottom + LATTICE_GAP) / cell));
  if (points.length > 0.8 * capacity) return true;
  const overlapping = new Set<number>();
  for (let i = 0; i < points.length; i++) {
    for (let j = i + 1; j < points.length; j++) {
      if (overlapRatio(points[i]!, points[j]!, T) > 0.25) {
        overlapping.add(i);
        overlapping.add(j);
      }
    }
  }
  return overlapping.size > 12;
}

export interface Candidate extends Pt {
  uid: string;
}

/**
 * Merge-target tracking with magnetism and hysteresis:
 * - lock the nearest candidate once it is within the capture radius (0.9·T),
 * - keep a locked target until it is farther than 0.75·T, unless another candidate is
 *   within the capture radius and clearly closer.
 */
export function trackTarget(p: Pt, candidates: readonly Candidate[], T: number, locked: string | null): { uid: string; d: number } | null {
  let best: Candidate | null = null;
  let bestD = Infinity;
  let lockedD = Infinity;
  for (const c of candidates) {
    const d = dist(p, c);
    if (d < bestD) {
      bestD = d;
      best = c;
    }
    if (c.uid === locked) lockedD = d;
  }
  if (locked && lockedD <= 0.75 * T && !(best && best.uid !== locked && bestD < 0.4 * lockedD)) {
    return { uid: locked, d: lockedD };
  }
  if (best && bestD < 0.9 * T) return { uid: best.uid, d: bestD };
  return null;
}

export const MERGE_RADIUS = 0.55;

/** Cosmetic pull of the dragged tile toward a locked target (hit-testing uses the raw point). */
export function magnetOffset(p: Pt, target: Pt, T: number): Pt {
  const d = dist(p, target);
  const k = 0.35 * smoothstep(0.9 * T, 0.4 * T, d);
  return { x: (target.x - p.x) * k, y: (target.y - p.y) * k };
}

export type Dir = "left" | "right" | "up" | "down";

/** Spatial keyboard navigation: nearest point in a direction, weighting off-axis distance. */
export function nearestInDirection(from: Pt, others: readonly Candidate[], dir: Dir): Candidate | null {
  let best: Candidate | null = null;
  let bestScore = Infinity;
  for (const o of others) {
    const dx = o.x - from.x;
    const dy = o.y - from.y;
    const primary = dir === "left" ? -dx : dir === "right" ? dx : dir === "up" ? -dy : dy;
    const ortho = dir === "left" || dir === "right" ? Math.abs(dy) : Math.abs(dx);
    if (primary <= 1) continue;
    const score = primary + 2 * ortho;
    if (score < bestScore) {
      bestScore = score;
      best = o;
    }
  }
  return best;
}
