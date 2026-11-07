// The free-form workbench canvas: measures itself (bounds + safe areas), renders tiles,
// the toolbar (Undo / Tidy / Clear), the selection pill, empty-state hint and keyboard
// support (spatial arrow navigation, Space/Enter combine, Delete, move mode).
import { AnimatePresence, m } from "motion/react";
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { clampPt, needsTidy, nearestInDirection, type Dir } from "../../lib/geometry.ts";
import { safeAreaInsets } from "../../lib/safeArea.ts";
import { KEYS, readString } from "../../lib/storage.ts";
import { canUndo, isSettled, placeTile, pruneTiles, pushUndo, setBounds, setFocus, useCanvas } from "../../state/canvas.ts";
import { useGame } from "../../state/game.ts";
import { useUi } from "../../state/ui.ts";
import { BroomIcon, CloseIcon, MoreIcon, TidyIcon, UndoIcon } from "../../components/Icons.tsx";
import { GhostDemo } from "../../components/GhostDemo.tsx";
import { clearCanvas, clearSelection, combineSelection, doUndo, mergeTiles, removeTile, setMultiSelect, tidyCanvas } from "./actions.ts";
import { Snackbar } from "../shell/Toasts.tsx";
import { CanvasTile } from "./CanvasTile.tsx";
import { layoutEls } from "./layout.ts";

const ARROWS: Record<string, Dir> = { ArrowLeft: "left", ArrowRight: "right", ArrowUp: "up", ArrowDown: "down" };

function useCanvasMeasure(ref: React.RefObject<HTMLDivElement | null>) {
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    layoutEls.canvas = el;
    const measure = () => {
      const r = el.getBoundingClientRect();
      if (r.width < 10 || r.height < 10) return;
      const safe = safeAreaInsets();
      const vw = document.documentElement.clientWidth;
      const vh = document.documentElement.clientHeight;
      const T = matchMedia("(min-width: 1024px)").matches ? 88 : 76;
      const bounds = {
        w: r.width,
        h: r.height,
        left: 8 + (r.left <= 1 ? safe.left : 0),
        right: 8 + (r.right >= vw - 1 ? safe.right : 0),
        top: 8,
        bottom: 8 + (r.bottom >= vh - 1 ? safe.bottom : 0),
      };
      // The toolbar floats over the canvas: keep tiles out from under it (resting position,
      // i.e. not lifted by an expanded phone shelf).
      const tools = el.querySelector<HTMLElement>(".canvas-tools")?.getBoundingClientRect();
      const lift = parseFloat(getComputedStyle(el.closest(".main") ?? el).getPropertyValue("--shelf-extra")) || 0;
      const obstacles = tools
        ? [{ x: tools.left - r.left - 6, y: tools.top - r.top + lift - 6, w: tools.width + 12, h: tools.height + 12 }]
        : [];
      // The on-screen keyboard shrinks the viewport while searching: don't reflow tiles.
      const typing = document.activeElement instanceof HTMLInputElement;
      setBounds(bounds, T, obstacles, typing);
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    const onBlur = () => setTimeout(measure, 350);
    document.addEventListener("focusout", onBlur);
    return () => {
      ro.disconnect();
      document.removeEventListener("focusout", onBlur);
      if (layoutEls.canvas === el) layoutEls.canvas = null;
    };
  }, [ref]);
}

function EmptyHint() {
  const [showDemo] = useState(() => readString(KEYS.merged) !== "1");
  return (
    <div className="empty-hint">
      <div className="empty-zone">
        {showDemo && <GhostDemo className="mb-3" />}
        <p className="font-display text-[19px] font-semibold text-ink">Your workbench</p>
        <p className="text-balance mt-1 text-[14px] text-ink-muted">Tap or drag an element here, then drop one onto another to combine them.</p>
      </div>
    </div>
  );
}

function SelectionPill() {
  const selection = useCanvas((s) => s.selection);
  const multi = useCanvas((s) => s.multi);
  const name = useGame((s) => {
    const t = useCanvas.getState().tiles.find((x) => x.uid === selection[0]);
    return t?.elementId ? s.elements[t.elementId]?.name : undefined;
  });
  const n = selection.length;
  return (
    <AnimatePresence>
      {n > 0 && (
        <m.div
          className="sel-pill"
          initial={{ opacity: 0, y: 12 }}
          animate={{ opacity: 1, y: 0 }}
          exit={{ opacity: 0, y: 12 }}
          transition={{ type: "spring", visualDuration: 0.25, bounce: 0.2 }}
        >
          <span className="max-w-[40vw] truncate">{multi ? `${n} selected` : `${name ?? "1"} selected`}</span>
          {!multi ? (
            <button type="button" className="btn btn-sm btn-quiet" onClick={() => setMultiSelect(true)}>
              <MoreIcon size={16} /> More
            </button>
          ) : (
            <button type="button" className="btn btn-sm btn-primary" disabled={n < 2} onClick={combineSelection}>
              Combine ({n})
            </button>
          )}
          <button type="button" className="icon-btn" aria-label="Clear selection" onClick={clearSelection}>
            <CloseIcon size={18} />
          </button>
        </m.div>
      )}
    </AnimatePresence>
  );
}

function Toolbar({ empty }: { empty: boolean }) {
  const undoable = useCanvas((s) => canUndo(s));
  const suggestTidy = useCanvas((s) => {
    if (!s.bounds || s.tiles.length < 6) return false;
    return needsTidy(s.tiles.filter((t) => !t.leaving), s.bounds, s.T);
  });
  return (
    <div className="canvas-tools">
      <AnimatePresence>
        {suggestTidy && (
          <m.button
            type="button"
            className="pill self-end"
            onClick={tidyCanvas}
            initial={{ opacity: 0, scale: 0.9 }}
            animate={{ opacity: 1, scale: 1 }}
            exit={{ opacity: 0, scale: 0.9 }}
          >
            Tidy up?
          </m.button>
        )}
      </AnimatePresence>
      <button type="button" className="tool" aria-label="Undo" title="Undo (Ctrl+Z)" data-testid="canvas-undo" disabled={!undoable} onClick={doUndo}>
        <UndoIcon />
      </button>
      <button type="button" className="tool" aria-label="Tidy workbench" title="Tidy (T)" data-testid="canvas-tidy" disabled={empty} onClick={tidyCanvas}>
        <TidyIcon />
      </button>
      <button type="button" className="tool" aria-label="Clear workbench" title="Clear (C)" data-testid="canvas-clear" disabled={empty} onClick={clearCanvas}>
        <BroomIcon />
      </button>
    </div>
  );
}

export function Workbench() {
  const canvasRef = useRef<HTMLDivElement>(null);
  const tiles = useCanvas((s) => s.tiles);
  const T = useCanvas((s) => s.T);
  const selection = useCanvas((s) => s.selection);
  const focusUid = useCanvas((s) => s.focusUid);
  const hasBounds = useCanvas((s) => !!s.bounds);
  const ready = useGame((s) => s.status === "ready");
  const owned = useGame((s) => s.owned);
  const [moveMode, setMoveMode] = useState(false);
  useCanvasMeasure(canvasRef);

  // Persisted tiles may reference elements this player doesn't own (reset / other player).
  const pruned = useRef(false);
  useEffect(() => {
    if (!ready || pruned.current) return;
    pruned.current = true;
    pruneTiles(owned);
  }, [ready, owned]);

  const settled = useMemo(() => tiles.filter(isSettled), [tiles]);
  const tabbableUid = focusUid && settled.some((t) => t.uid === focusUid) ? focusUid : settled[0]?.uid;
  const selected = useMemo(() => new Set(selection), [selection]);

  const focusTile = (uid: string) => {
    setFocus(uid);
    canvasRef.current?.querySelector<HTMLElement>(`[data-uid="${uid}"]`)?.focus({ preventScroll: true });
  };

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const uid = (e.target as HTMLElement).dataset.uid;
    if (!uid) return;
    const s = useCanvas.getState();
    const tile = s.tiles.find((t) => t.uid === uid);
    if (!tile || !isSettled(tile)) return;
    const dir = ARROWS[e.key];
    if (dir) {
      e.preventDefault();
      if (moveMode && s.bounds) {
        const step = e.shiftKey ? 64 : 16;
        const dx = dir === "left" ? -step : dir === "right" ? step : 0;
        const dy = dir === "up" ? -step : dir === "down" ? step : 0;
        placeTile(uid, clampPt({ x: tile.x + dx, y: tile.y + dy }, s.bounds, s.T));
        return;
      }
      const next = nearestInDirection(tile, s.tiles.filter((t) => t.uid !== uid && isSettled(t)), dir);
      if (next) focusTile(next.uid);
      return;
    }
    if (e.key === " " || e.key === "Spacebar") {
      e.preventDefault();
      const sel = s.selection;
      if (e.shiftKey || s.multi) {
        const next = sel.includes(uid) ? sel.filter((u) => u !== uid) : sel.length < 4 ? [...sel, uid] : sel;
        useCanvas.setState({ selection: next, multi: next.length > 0 });
      } else {
        useCanvas.setState({ selection: sel.length === 1 && sel[0] === uid ? [] : [uid], multi: false });
      }
      return;
    }
    if (e.key === "Enter") {
      e.preventDefault();
      if (moveMode) {
        setMoveMode(false);
        return;
      }
      const ids = [...new Set([...s.selection, uid])].slice(0, 4);
      if (ids.length >= 2) {
        useCanvas.setState({ selection: [], multi: false });
        void mergeTiles(ids, { x: tile.x, y: tile.y });
      } else {
        useCanvas.setState({ selection: [uid], multi: false });
      }
      return;
    }
    if (e.key === "Delete" || e.key === "Backspace") {
      e.preventDefault();
      const next = nearestInDirection(tile, s.tiles.filter((t) => t.uid !== uid && isSettled(t)), "right") ??
        nearestInDirection(tile, s.tiles.filter((t) => t.uid !== uid && isSettled(t)), "left");
      removeTile(uid);
      if (next) focusTile(next.uid);
      return;
    }
    if (e.key === "m" || e.key === "M") {
      e.preventDefault();
      if (!moveMode) pushUndo();
      setMoveMode((v) => !v);
      return;
    }
    if (e.key === "Escape") {
      if (moveMode) setMoveMode(false);
      else if (s.selection.length) useCanvas.setState({ selection: [], multi: false });
    }
  };

  const showTiles = ready && hasBounds;
  const empty = showTiles && tiles.length === 0;
  // Right after a clear the Undo snackbar owns that space; the hint fades in once it's gone.
  const undoOffered = useUi((s) => s.toasts.some((t) => t.kind === "undo"));

  return (
    <div className="canvas-area">
      <div
        ref={canvasRef}
        className="canvas"
        data-testid="canvas"
        aria-label="Workbench"
        onPointerDown={(e) => {
          if (e.target === e.currentTarget && useCanvas.getState().selection.length) clearSelection();
        }}
      >
        {empty && !undoOffered && <EmptyHint />}
        <div className="tile-layer" role="group" aria-label="Elements on the workbench" onKeyDown={onKeyDown}>
          {showTiles &&
            tiles.map((t) => (
              <CanvasTile key={t.uid} tile={t} T={T} selected={selected.has(t.uid)} tabbable={t.uid === tabbableUid} />
            ))}
        </div>
        {moveMode && (
          <div className="pill absolute left-1/2 top-3 z-10 -translate-x-1/2" role="status">
            Move mode: arrows to nudge, Enter to finish
          </div>
        )}
        <div className="canvas-bottom">
          <Snackbar />
          <SelectionPill />
        </div>
        <Toolbar empty={!showTiles || settled.length === 0} />
      </div>
    </div>
  );
}
