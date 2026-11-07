// Tablet/desktop library rail (left column): search, filters, sort (plus the custom sort bar
// while one is on), virtualized grid.
import { useLayoutEffect, useRef } from "react";
import { useCustomSort } from "../../state/customSort.ts";
import { useGame } from "../../state/game.ts";
import { useUi } from "../../state/ui.ts";
import { formatCount } from "../../lib/format.ts";
import { layoutEls } from "../workbench/layout.ts";
import { CustomSortBar } from "./CustomSortBar.tsx";
import { FilterBar, LibraryEmpty, SearchField, SortSelect } from "./LibraryControls.tsx";
import { LibraryGrid } from "./LibraryGrid.tsx";
import { useLibraryView } from "./useLibrary.ts";

export function Rail() {
  const ref = useRef<HTMLElement>(null);
  const drop = useUi((s) => s.shelfDropActive);
  const loading = useGame((s) => s.status !== "ready");
  const { ids, counts } = useLibraryView();
  const query = useUi((s) => s.query);
  const filter = useUi((s) => s.filter);
  const custom = useUi((s) => s.sort === "custom");
  const bucket = useCustomSort((s) => s.bucket);
  // A custom-sort bucket (Matches, a group) narrows the list just like a filter does.
  const narrowed = !!query || filter !== "all" || (custom && bucket != null);

  useLayoutEffect(() => {
    layoutEls.library = ref.current;
    return () => {
      if (layoutEls.library === ref.current) layoutEls.library = null;
    };
  }, []);

  return (
    <aside ref={ref} className="rail" aria-label="Library" data-drop={drop ? "" : undefined}>
      <div className="flex items-center gap-2 px-4 pt-3">
        <SearchField />
      </div>
      <FilterBar withSort={false} />
      <div className="flex items-center justify-between gap-2 px-4 pb-1.5 pt-0.5">
        <span className="text-[12px] font-semibold uppercase tracking-[0.06em] text-ink-muted">
          {narrowed ? "Matches" : "Your elements"}
          {!loading && <span className="tabular"> · {formatCount(ids.length)}</span>}
        </span>
        <SortSelect />
      </div>
      <CustomSortBar counts={counts} />
      <LibraryGrid ids={ids} mode="rail" loading={loading} empty={<LibraryEmpty counts={counts} />} label="Your elements" />
      {drop && (
        <div className="pointer-events-none absolute inset-x-4 bottom-6 rounded-2xl bg-accent px-4 py-3 text-center text-[14px] font-semibold text-on-accent shadow-lg">
          Release to put it away
        </div>
      )}
    </aside>
  );
}
