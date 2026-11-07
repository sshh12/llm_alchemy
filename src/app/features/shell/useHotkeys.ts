// Global keyboard shortcuts (ignored while typing or when a dialog is open):
//   /  focus search     Ctrl/Cmd+Z undo     Shift+Ctrl/Cmd+Z or Ctrl+Y redo
//   T  tidy             C  clear (undoable) Esc  clear selection
//   S  custom sort (opens "Sort by anything", prefilled with the active spec)
import { useEffect } from "react";
import { useCanvas } from "../../state/canvas.ts";
import { markCustomSortSeen } from "../../state/customSort.ts";
import { openSheet, useUi } from "../../state/ui.ts";
import { SEARCH_ID } from "../library/LibraryControls.tsx";
import { clearCanvas, clearSelection, doRedo, doUndo, tidyCanvas } from "../workbench/actions.ts";

function typing(t: EventTarget | null): boolean {
  const el = t as HTMLElement | null;
  return !!el && (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.tagName === "SELECT" || el.isContentEditable);
}

export function useHotkeys(): void {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const ui = useUi.getState();
      if (ui.sheet || ui.details || ui.celebrations.length || typing(e.target)) return;
      const mod = e.metaKey || e.ctrlKey;
      const k = e.key.toLowerCase();
      if (mod && k === "z") {
        e.preventDefault();
        if (e.shiftKey) doRedo();
        else doUndo();
      } else if (mod && k === "y") {
        e.preventDefault();
        doRedo();
      } else if (mod || e.altKey) {
        return;
      } else if (e.key === "/") {
        e.preventDefault();
        if (ui.shelf === "peek" && !matchMedia("(min-width: 640px)").matches) useUi.setState({ shelf: "half" });
        document.getElementById(SEARCH_ID)?.focus();
      } else if (k === "t") {
        tidyCanvas();
      } else if (k === "c") {
        clearCanvas();
      } else if (k === "s") {
        e.preventDefault();
        markCustomSortSeen(); // found it: the select's one-time "new" dot can go
        openSheet("customSort");
      } else if (e.key === "Escape" && useCanvas.getState().selection.length) {
        clearSelection();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
}
