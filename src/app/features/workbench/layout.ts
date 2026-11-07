// DOM registry shared by the drag engine and workbench actions: the canvas element (for
// client → canvas coordinates) and the library container (the "return to library" zone).
import type { Pt } from "../../lib/geometry.ts";
import { useCanvas } from "../../state/canvas.ts";

export const layoutEls: { canvas: HTMLElement | null; library: HTMLElement | null } = {
  canvas: null,
  library: null,
};

export function canvasRect(): DOMRect | null {
  return layoutEls.canvas?.getBoundingClientRect() ?? null;
}

export function toCanvas(clientX: number, clientY: number, rect = canvasRect()): Pt {
  return rect ? { x: clientX - rect.left, y: clientY - rect.top } : { x: clientX, y: clientY };
}

export function overLibrary(clientX: number, clientY: number): boolean {
  const r = layoutEls.library?.getBoundingClientRect();
  return !!r && clientX >= r.left && clientX <= r.right && clientY >= r.top && clientY <= r.bottom;
}

/** Where tiles fly in from / out to when moving between the library and the canvas. */
export function libraryEdge(): Pt {
  const { bounds, T } = useCanvas.getState();
  const c = canvasRect();
  const l = layoutEls.library?.getBoundingClientRect();
  if (!bounds || !c) return { x: 0, y: 0 };
  if (l && l.right <= c.left + 1) return { x: -T * 0.6, y: bounds.h / 2 }; // rail on the left
  return { x: bounds.w / 2, y: bounds.h + T * 0.6 }; // shelf below
}
