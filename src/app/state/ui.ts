// Transient UI state: open sheet, phone shelf snap, toasts, celebration queue, quick
// actions, library view (filter/sort/search), pins and screen-reader announcements.
import { create } from "zustand";
import type { ElementId, Tier } from "../../shared/api.ts";
import { KEYS, readJSON, writeJSON } from "../lib/storage.ts";

export type SheetName = "challenges" | "stats" | "settings" | "about";
export type ShelfSnap = "peek" | "half" | "full";
export type LibraryFilter = "all" | "pinned" | "new" | "firsts";
export type LibrarySort = "recent" | "az" | "rarity";

export interface ToastAction {
  label: string;
  run: () => void;
}

export interface Toast {
  id: number;
  kind: "new" | "info" | "error" | "undo";
  text: string;
  /** Element chip shown in the toast (tappable → details). */
  elementId?: ElementId;
  notable?: boolean;
  action?: ToastAction;
  /** Auto-dismiss after this many ms. */
  duration: number;
  /** Show a live countdown until this epoch ms (rate limits). */
  until?: number;
  /** Overrides data-testid="toast" (e.g. the one-time "welcome-back" notice). */
  testId?: string;
}

export type Celebration =
  | { kind: "first"; elementId: ElementId; ingredients: ElementId[]; at: string }
  | { kind: "challenge"; tiers: Tier[] };

export interface Details {
  elementId: ElementId;
  source: "library" | "canvas" | "feed";
  /** Canvas tile uid when opened from the workbench. */
  uid?: string;
  /** Screen rect to anchor the popover near (null → centered). */
  anchor: { x: number; y: number; w: number; h: number } | null;
}

interface LibraryView {
  filter: LibraryFilter;
  sort: LibrarySort;
}

interface UiState {
  sheet: SheetName | null;
  onboarding: boolean;
  shelf: ShelfSnap;
  toasts: Toast[];
  celebrations: Celebration[];
  details: Details | null;
  filter: LibraryFilter;
  sort: LibrarySort;
  query: string;
  pins: ReadonlySet<ElementId>;
  live: { polite: string; assertive: string; n: number };
  /** A drag is hovering the shelf/rail (canvas tile → "return to library" zone). */
  shelfDropActive: boolean;
}

const view = readJSON<Partial<LibraryView>>(KEYS.libraryView, {});
const pins = readJSON<unknown>(KEYS.pins, []);

export const useUi = create<UiState>(() => ({
  sheet: null,
  onboarding: false,
  shelf: "peek",
  toasts: [],
  celebrations: [],
  details: null,
  filter: view.filter === "pinned" || view.filter === "new" || view.filter === "firsts" ? view.filter : "all",
  sort: view.sort === "az" || view.sort === "rarity" ? view.sort : "recent",
  query: "",
  pins: new Set(Array.isArray(pins) ? pins.filter((p): p is string => typeof p === "string") : []),
  live: { polite: "", assertive: "", n: 0 },
  shelfDropActive: false,
}));

let toastSeq = 1;
const toastTimers = new Map<number, ReturnType<typeof setTimeout>>();

export function showToast(t: Omit<Toast, "id">): number {
  const id = toastSeq++;
  useUi.setState((s) => {
    // Keep the stack short; the newest toast wins.
    const toasts = [...s.toasts, { ...t, id }].slice(-3);
    return { toasts };
  });
  toastTimers.set(id, setTimeout(() => dismissToast(id), t.duration));
  return id;
}

export function dismissToast(id: number): void {
  clearTimeout(toastTimers.get(id));
  toastTimers.delete(id);
  useUi.setState((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) }));
}

export function celebrate(c: Celebration): void {
  useUi.setState((s) => ({ celebrations: [...s.celebrations, c] }));
}

export function nextCelebration(): void {
  useUi.setState((s) => ({ celebrations: s.celebrations.slice(1) }));
}

export function openSheet(sheet: SheetName | null): void {
  useUi.setState({ sheet, details: null });
}

export function openDetails(d: Details | null): void {
  useUi.setState({ details: d });
}

export function setLibraryView(patch: Partial<LibraryView>): void {
  useUi.setState(patch);
  const { filter, sort } = useUi.getState();
  writeJSON(KEYS.libraryView, { filter, sort });
}

export function togglePin(id: ElementId): boolean {
  const next = new Set(useUi.getState().pins);
  const pinned = !next.has(id);
  if (pinned) next.add(id);
  else next.delete(id);
  useUi.setState({ pins: next });
  writeJSON(KEYS.pins, [...next]);
  return pinned;
}

/** Screen-reader announcement (polite by default, assertive for errors). */
export function announce(text: string, assertive = false): void {
  useUi.setState((s) => ({
    live: {
      polite: assertive ? s.live.polite : text,
      assertive: assertive ? text : s.live.assertive,
      n: s.live.n + 1,
    },
  }));
}
