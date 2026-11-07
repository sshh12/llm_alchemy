// Derives the visible library list (filter, search, pins, built-in or custom sort) from the
// stores. The ordering itself is the pure orderLibrary() in lib/librarySort.ts.
import { useMemo } from "react";
import { useShallow } from "zustand/react/shallow";
import type { ElementId } from "../../../shared/api.ts";
import { NEW_WINDOW_MS, orderLibrary, type CustomCounts } from "../../lib/librarySort.ts";
import { useCustomSort } from "../../state/customSort.ts";
import { useGame } from "../../state/game.ts";
import { useUi } from "../../state/ui.ts";

/** The ordered visible ids, plus custom-sort bucket counts (null unless a custom order is on screen). */
export function useLibraryView(): { ids: ElementId[]; counts: CustomCounts | null } {
  const owned = useGame((s) => s.owned);
  const pins = useUi((s) => s.pins);
  const filter = useUi((s) => s.filter);
  const sort = useUi((s) => s.sort);
  const query = useUi((s) => s.query);
  // Only what the order depends on, compared shallowly (status/epoch changes don't re-sort).
  const custom = useCustomSort(
    useShallow((s) =>
      sort === "custom"
        ? {
            committed: s.committed,
            pending: s.pending,
            reverse: s.view.reverse,
            other: s.view.other,
            bucket: s.bucket,
            prevSort: s.prevSort,
            key: s.key,
          }
        : null,
    ),
  );
  return useMemo(
    // Names, rarity and dates never change for an element, so reading the catalog
    // non-reactively here is safe (art updates must not re-sort thousands of items).
    () => orderLibrary({ owned, elements: useGame.getState().elements, pins, filter, sort, query, now: Date.now(), custom }),
    [owned, pins, filter, sort, query, custom],
  );
}

export const useLibraryList = (): ElementId[] => useLibraryView().ids;

export function useFilterCounts() {
  const owned = useGame((s) => s.owned);
  const pins = useUi((s) => s.pins);
  return useMemo(() => {
    const els = useGame.getState().elements;
    const cutoff = Date.now() - NEW_WINDOW_MS;
    let pinned = 0;
    let fresh = 0;
    let firsts = 0;
    for (const [id, o] of Object.entries(owned)) {
      if (pins.has(id)) pinned++;
      if (o.first) firsts++;
      if (!els[id]?.starter && Date.parse(o.discoveredAt) >= cutoff) fresh++;
    }
    return { all: Object.keys(owned).length, pinned, new: fresh, firsts };
  }, [owned, pins]);
}
