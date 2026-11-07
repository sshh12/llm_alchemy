// Phone library: a persistent, non-modal bottom sheet with Peek / Half / Full snaps.
// Peek is a horizontal row (touch-action: pan-x; drag tiles UP to pull them out);
// Half/Full is a vertical grid (pan-y; drag SIDEWAYS or long-press to pull out).
// The handle drags between snaps with velocity projection; height is spring-animated
// outside React.
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { specLabel } from "../../../shared/sortSpec.ts";
import { safeAreaInsets } from "../../lib/safeArea.ts";
import { SPRING, SpringValue } from "../../lib/spring.ts";
import { useCustomSort } from "../../state/customSort.ts";
import { useGame } from "../../state/game.ts";
import { useUi, type ShelfSnap } from "../../state/ui.ts";
import { ChevronDownIcon, ChevronUpIcon, SparkleIcon } from "../../components/Icons.tsx";
import { layoutEls } from "../workbench/layout.ts";
import { CustomSortBar } from "./CustomSortBar.tsx";
import { FilterBar, LibraryEmpty, SearchField } from "./LibraryControls.tsx";
import { LibraryGrid, PeekRow } from "./LibraryGrid.tsx";
import { useLibraryView } from "./useLibrary.ts";

const PEEK = 160;
const ORDER: ShelfSnap[] = ["peek", "half", "full"];

function snapHeights(container: HTMLElement | null): Record<ShelfSnap, number> {
  const mainH = container?.parentElement?.clientHeight ?? window.innerHeight - 52;
  const peek = PEEK + safeAreaInsets().bottom;
  const full = Math.max(peek + 120, mainH - 8);
  const half = Math.min(full, Math.max(peek + 140, Math.round(window.innerHeight * 0.5)));
  return { peek, half, full };
}

export function Shelf() {
  const ref = useRef<HTMLDivElement>(null);
  const snap = useUi((s) => s.shelf);
  const drop = useUi((s) => s.shelfDropActive);
  const loading = useGame((s) => s.status !== "ready");
  const { ids, counts } = useLibraryView();
  const [gridMode, setGridMode] = useState(snap !== "peek");
  const height = useRef<SpringValue | null>(null);

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    layoutEls.library = el;
    const main = el.parentElement;
    let peek = snapHeights(el).peek;
    const h = new SpringValue(peek, () => {
      el.style.height = `${h.value.toFixed(1)}px`;
      // How far the shelf rises over the canvas: floating canvas UI (toolbar, snackbar,
      // selection pill) lifts by this much so it stays visible above a half-open shelf.
      main?.style.setProperty("--shelf-extra", `${Math.max(0, h.value - peek).toFixed(1)}px`);
    });
    height.current = h;
    const onResize = () => {
      const heights = snapHeights(el);
      peek = heights.peek;
      h.to(heights[useUi.getState().shelf], SPRING.shelf);
    };
    window.addEventListener("resize", onResize);
    return () => {
      window.removeEventListener("resize", onResize);
      h.stop();
      if (layoutEls.library === el) layoutEls.library = null;
    };
  }, []);

  // Snap changes (handle, buttons, auto-collapse on drag-out) animate the height.
  useEffect(() => {
    const h = height.current;
    if (!h) return;
    const target = snapHeights(ref.current)[snap];
    if (snap !== "peek") setGridMode(true);
    h.to(target, snap === "peek" ? SPRING.collapse : SPRING.shelf, () => setGridMode(snap !== "peek"));
  }, [snap]);

  // Handle drag with velocity projection (fling > 0.5 px/ms skips a snap).
  const onHandleDown = (e: React.PointerEvent<HTMLDivElement>) => {
    const h = height.current;
    if (!h || (e.pointerType === "mouse" && e.button !== 0)) return;
    const el = e.currentTarget;
    el.setPointerCapture(e.pointerId);
    const startY = e.clientY;
    const startH = h.value;
    const heights = snapHeights(ref.current);
    let lastY = e.clientY;
    let lastT = performance.now();
    let v = 0;
    let moved = false;
    const move = (ev: PointerEvent) => {
      const now = performance.now();
      v = 0.7 * ((lastY - ev.clientY) / Math.max(1, now - lastT)) + 0.3 * v;
      lastY = ev.clientY;
      lastT = now;
      if (Math.abs(ev.clientY - startY) > 4) moved = true;
      const next = Math.min(heights.full, Math.max(heights.peek, startH + (startY - ev.clientY)));
      h.set(next);
      if (next > heights.peek + 50) setGridMode(true);
    };
    const up = () => {
      el.removeEventListener("pointermove", move);
      el.removeEventListener("pointerup", up);
      el.removeEventListener("pointercancel", up);
      const cur = useUi.getState().shelf;
      if (!moved) {
        useUi.setState({ shelf: cur === "peek" ? "half" : "peek" });
        return;
      }
      const projected = h.value + v * 200;
      let best = ORDER.reduce((a, b) => (Math.abs(heights[b] - projected) < Math.abs(heights[a] - projected) ? b : a));
      if (Math.abs(v) > 0.5 && best === cur) {
        const i = ORDER.indexOf(cur) + (v > 0 ? 1 : -1);
        best = ORDER[Math.max(0, Math.min(2, i))]!;
      }
      if (best === cur) h.to(heights[best], SPRING.shelf, () => setGridMode(best !== "peek"));
      else useUi.setState({ shelf: best });
    };
    el.addEventListener("pointermove", move);
    el.addEventListener("pointerup", up);
    el.addEventListener("pointercancel", up);
  };

  const expanded = snap !== "peek";
  return (
    <section ref={ref} className="shelf" aria-label="Library" data-drop={drop ? "" : undefined}>
      <div className="handle" onPointerDown={onHandleDown} aria-hidden="true" />
      <div className="flex h-12 flex-none items-center gap-2 px-4 pb-1">
        <SearchField onFocus={() => snap === "peek" && useUi.setState({ shelf: "half" })} />
        {snap === "peek" && <CustomSortPeek />}
        <button
          type="button"
          className="icon-btn"
          aria-label={expanded ? "Collapse library" : "Expand library"}
          aria-expanded={expanded}
          onClick={() => useUi.setState({ shelf: expanded ? "peek" : "full" })}
        >
          {expanded ? <ChevronDownIcon /> : <ChevronUpIcon />}
        </button>
      </div>
      {gridMode ? (
        <>
          <FilterBar />
          <CustomSortBar counts={counts} />
          <LibraryGrid ids={ids} mode="shelf-y" phone loading={loading} empty={<LibraryEmpty counts={counts} />} label="Your elements" />
        </>
      ) : (
        <PeekRow ids={ids} loading={loading} empty={<LibraryEmpty compact counts={counts} />} />
      )}
    </section>
  );
}

/** Peek has no sort controls: a ✦ says a custom order is on (pulsing while it weighs) and opens them. */
function CustomSortPeek() {
  const on = useUi((s) => s.sort === "custom");
  const spec = useCustomSort((s) => s.spec);
  const busy = useCustomSort((s) => s.status === "scoring");
  if (!on || !spec) return null;
  return (
    <button
      type="button"
      className={`icon-btn flex-none text-accent ${busy ? "cs-busy" : ""}`}
      data-testid="custom-sort-peek"
      aria-label={`Custom sort “${specLabel(spec)}” is on. Show sort controls`}
      onClick={() => useUi.setState({ shelf: "half" })}
    >
      <SparkleIcon />
    </button>
  );
}
