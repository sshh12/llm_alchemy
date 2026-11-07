// Virtualized library views: a vertical grid (phone half/full shelf, rail) and the
// horizontal peek row. Both are role="grid" with a roving tabindex: arrows/Home/End/
// PageUp/PageDown move focus, Enter/Space spawns onto the workbench, the context-menu key
// (or Shift+F10) opens quick actions.
import { useVirtualizer } from "@tanstack/react-virtual";
import { useEffect, useRef, useState, type CSSProperties, type KeyboardEvent, type ReactNode } from "react";
import type { ElementId } from "../../../shared/api.ts";
import { openDetails, useUi } from "../../state/ui.ts";
import { SkeletonTile } from "../../components/Tile.tsx";
import { spawnElement } from "../workbench/actions.ts";
import type { PressMode } from "../workbench/drag.ts";
import { LibraryTile } from "./LibraryTile.tsx";

const GAP = 8;
const PAD = 16;

function useWidth(ref: React.RefObject<HTMLElement | null>): number {
  const [w, setW] = useState(0);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setW(el.clientWidth));
    ro.observe(el);
    setW(el.clientWidth);
    return () => ro.disconnect();
  }, [ref]);
  return w;
}

type EnterMode = "stagger" | "fade";

/**
 * Entrance choreography for the visible tiles: a staggered rise when the list first appears
 * (or the filter/sort changes, or a search starts/ends), a quick fade while typing. `key`
 * remounts the tiles so their CSS animation replays; the mode clears shortly after, so rows
 * that scroll into view later never animate.
 */
function useEnter(loading: boolean | undefined): { key: number; mode: EnterMode | undefined } {
  const filter = useUi((s) => s.filter);
  const sort = useUi((s) => s.sort);
  const query = useUi((s) => s.query.trim());
  const [anim, setAnim] = useState({ filter, sort, query, loading, key: 0, mode: "stagger" as EnterMode | undefined });
  if (anim.filter !== filter || anim.sort !== sort || anim.query !== query || anim.loading !== loading) {
    const typing = anim.filter === filter && anim.sort === sort && anim.loading === loading && !!anim.query === !!query;
    setAnim({ filter, sort, query, loading, key: anim.key + 1, mode: typing ? "fade" : "stagger" });
  }
  useEffect(() => {
    if (!anim.mode) return;
    const t = setTimeout(() => setAnim((a) => ({ ...a, mode: undefined })), 600);
    return () => clearTimeout(t);
  }, [anim.key, anim.mode]);
  return { key: anim.key, mode: anim.mode };
}

function useRovingKeys(ids: ElementId[], cols: number, pageSize: number, scrollTo: (i: number) => void, container: React.RefObject<HTMLElement | null>) {
  const [focusIndex, setFocusIndex] = useState(0);
  const index = Math.min(focusIndex, Math.max(0, ids.length - 1));
  const focusAt = (i: number) => {
    const next = Math.max(0, Math.min(ids.length - 1, i));
    setFocusIndex(next);
    scrollTo(next);
    requestAnimationFrame(() => container.current?.querySelector<HTMLElement>(`[data-index="${next}"]`)?.focus({ preventScroll: true }));
  };
  const onKeyDown = (e: KeyboardEvent<HTMLElement>) => {
    const t = e.target as HTMLElement;
    if (t.dataset.index === undefined) return;
    const i = Number(t.dataset.index);
    const id = ids[i];
    const moves: Record<string, number> = {
      ArrowRight: i + 1,
      ArrowLeft: i - 1,
      ArrowDown: i + cols,
      ArrowUp: i - cols,
      Home: 0,
      End: ids.length - 1,
      PageDown: i + pageSize,
      PageUp: i - pageSize,
    };
    if (e.key in moves) {
      e.preventDefault();
      focusAt(moves[e.key]!);
    } else if ((e.key === "Enter" || e.key === " ") && id) {
      e.preventDefault();
      spawnElement(id, { focus: e.key === "Enter" });
    } else if ((e.key === "ContextMenu" || (e.shiftKey && e.key === "F10")) && id) {
      e.preventDefault();
      const r = t.getBoundingClientRect();
      openDetails({ elementId: id, source: "library", anchor: { x: r.left, y: r.top, w: r.width, h: r.height } });
    }
  };
  return { index, onKeyDown, onFocusCapture: (e: React.FocusEvent) => {
    const i = (e.target as HTMLElement).dataset.index;
    if (i !== undefined) setFocusIndex(Number(i));
  } };
}

interface GridProps {
  ids: ElementId[];
  mode: PressMode;
  /** Columns are derived from width; phone grids force 4/5 per the spec. */
  phone?: boolean;
  loading?: boolean;
  empty?: ReactNode;
  label: string;
}

export function LibraryGrid({ ids, mode, phone, loading, empty, label }: GridProps) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const width = useWidth(scrollRef);
  const inner = Math.max(0, width - PAD * 2);
  const cols = phone ? (width >= 420 ? 5 : 4) : Math.max(3, Math.floor((inner + GAP) / (76 + GAP)));
  const size = Math.max(56, Math.floor((inner - GAP * (cols - 1)) / cols));
  const rows = Math.ceil(ids.length / cols);
  const rowH = size + GAP;
  const virtualizer = useVirtualizer({
    count: rows,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => rowH,
    overscan: 4,
    paddingStart: 4,
    paddingEnd: 24,
  });
  useEffect(() => virtualizer.measure(), [rowH, virtualizer]);
  const enter = useEnter(loading);
  const firstRow = Math.floor((virtualizer.scrollOffset ?? 0) / rowH);
  const visibleRows = Math.max(1, Math.floor((scrollRef.current?.clientHeight ?? 400) / rowH));
  const roving = useRovingKeys(ids, cols, visibleRows * cols, (i) => virtualizer.scrollToIndex(Math.floor(i / cols)), scrollRef);

  return (
    <div
      ref={scrollRef}
      className="grid-scroll min-h-0 flex-1"
      data-testid="library"
      role="grid"
      aria-label={label}
      aria-rowcount={rows}
      aria-colcount={cols}
      onKeyDown={roving.onKeyDown}
      onFocus={roving.onFocusCapture}
      data-enter={enter.mode}
    >
      {loading ? (
        <div className="flex flex-wrap gap-2 px-4 pt-1">
          {Array.from({ length: 20 }, (_, i) => (
            <SkeletonTile key={i} size={size || 76} />
          ))}
        </div>
      ) : ids.length === 0 ? (
        empty
      ) : (
        width > 0 && (
          <div key={enter.key} style={{ height: virtualizer.getTotalSize(), position: "relative" }}>
            {virtualizer.getVirtualItems().map((row) => (
              <div
                key={row.key}
                role="row"
                aria-rowindex={row.index + 1}
                className="lib-row absolute left-0 flex"
                style={
                  {
                    top: 0,
                    transform: `translateY(${row.start}px)`,
                    gap: GAP,
                    paddingLeft: PAD,
                    paddingRight: PAD,
                    height: size,
                    "--row": Math.max(0, row.index - firstRow),
                  } as CSSProperties
                }
              >
                {ids.slice(row.index * cols, row.index * cols + cols).map((id, c) => {
                  const i = row.index * cols + c;
                  return <LibraryTile key={id} id={id} size={size} mode={mode} index={i} tabbable={i === roving.index} />;
                })}
              </div>
            ))}
          </div>
        )
      )}
    </div>
  );
}

export function PeekRow({ ids, loading, empty }: { ids: ElementId[]; loading?: boolean; empty?: ReactNode }) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const size = 76;
  const virtualizer = useVirtualizer({
    horizontal: true,
    count: ids.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => size + GAP,
    overscan: 6,
    paddingStart: PAD,
    paddingEnd: PAD,
  });
  const roving = useRovingKeys(ids, 1, 4, (i) => virtualizer.scrollToIndex(i), scrollRef);
  const enter = useEnter(loading);
  const firstCol = Math.floor(Math.max(0, (virtualizer.scrollOffset ?? 0) - PAD) / (size + GAP));
  return (
    <div
      ref={scrollRef}
      className="peek-row no-scrollbar flex-1"
      data-testid="library"
      role="grid"
      aria-label="Your elements"
      aria-rowcount={1}
      onKeyDown={roving.onKeyDown}
      onFocus={roving.onFocusCapture}
      data-enter={enter.mode}
    >
      {loading ? (
        <div className="flex gap-2 px-4 py-1">
          {Array.from({ length: 8 }, (_, i) => (
            <SkeletonTile key={i} size={size} />
          ))}
        </div>
      ) : ids.length === 0 ? (
        empty
      ) : (
        <div key={enter.key} role="row" style={{ width: virtualizer.getTotalSize(), height: "100%", position: "relative" }}>
          {virtualizer.getVirtualItems().map((item) => {
            const id = ids[item.index]!;
            return (
              <div
                key={id}
                className="absolute top-1"
                style={{ transform: `translateX(${item.start}px)`, "--col": Math.max(0, item.index - firstCol) } as CSSProperties}
              >
                <LibraryTile id={id} size={size} mode="shelf-x" index={item.index} tabbable={item.index === roving.index} />
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
