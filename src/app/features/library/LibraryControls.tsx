// Search field, filter chips (All · Pinned · New · Firsts) and sort, plus empty states.
import { useGame } from "../../state/game.ts";
import { openSheet, setLibraryView, useUi, type LibraryFilter, type LibrarySort } from "../../state/ui.ts";
import { CloseIcon, SearchIcon } from "../../components/Icons.tsx";
import { useFilterCounts } from "./useLibrary.ts";

export const SEARCH_ID = "library-search";

export function SearchField({ onFocus }: { onFocus?: () => void }) {
  const query = useUi((s) => s.query);
  const count = useGame((s) => s.stats.mine);
  return (
    <label className="search min-w-0 flex-1">
      <SearchIcon size={18} />
      <input
        id={SEARCH_ID}
        data-testid="library-search"
        type="search"
        inputMode="search"
        enterKeyHint="search"
        autoComplete="off"
        autoCorrect="off"
        spellCheck={false}
        placeholder={count ? `Search ${count.toLocaleString("en-US")} elements` : "Search elements"}
        aria-label="Search your elements"
        value={query}
        onFocus={onFocus}
        onChange={(e) => useUi.setState({ query: e.target.value })}
        onKeyDown={(e) => {
          if (e.key === "Escape") {
            useUi.setState({ query: "" });
            e.currentTarget.blur();
          }
        }}
      />
      {query && (
        <button type="button" className="icon-btn -mr-1 h-8 w-8" aria-label="Clear search" onClick={() => useUi.setState({ query: "" })}>
          <CloseIcon size={16} />
        </button>
      )}
    </label>
  );
}

const FILTERS: { id: LibraryFilter; label: string }[] = [
  { id: "all", label: "All" },
  { id: "pinned", label: "Pinned" },
  { id: "new", label: "New" },
  { id: "firsts", label: "Firsts" },
];

export function SortSelect() {
  const sort = useUi((s) => s.sort);
  return (
    <select className="sort-select" aria-label="Sort" value={sort} onChange={(e) => setLibraryView({ sort: e.target.value as LibrarySort })}>
      <option value="recent">Recent</option>
      <option value="az">A–Z</option>
      <option value="rarity">Rarity</option>
    </select>
  );
}

/** Filter chips; the sort select is appended unless the host places it elsewhere. */
export function FilterBar({ withSort = true }: { withSort?: boolean }) {
  const filter = useUi((s) => s.filter);
  const counts = useFilterCounts();
  return (
    <div className="no-scrollbar flex items-center gap-1.5 overflow-x-auto px-4 py-1.5" style={{ touchAction: "pan-x" }}>
      <div role="group" aria-label="Filter" className="flex gap-1.5">
        {FILTERS.map((f) => (
          <button
            key={f.id}
            type="button"
            className="chip"
            aria-pressed={filter === f.id}
            onClick={() => setLibraryView({ filter: f.id })}
          >
            {f.label}
            {f.id !== "all" && counts[f.id] > 0 && <span className="count">{counts[f.id]}</span>}
          </button>
        ))}
      </div>
      {withSort && (
        <>
          <span className="flex-1" />
          <SortSelect />
        </>
      )}
    </div>
  );
}

export function LibraryEmpty({ compact }: { compact?: boolean }) {
  const query = useUi((s) => s.query.trim());
  const filter = useUi((s) => s.filter);
  let title: string;
  let body: string | null = null;
  if (query) {
    title = `No “${query}” yet.`;
    body = "Maybe you'll be the one to make it.";
  } else if (filter === "pinned") {
    title = "Nothing pinned yet.";
    body = "Press and hold an element (or right-click) to pin it here.";
  } else if (filter === "new") {
    title = "Nothing new in the last day.";
    body = "Go mix something!";
  } else if (filter === "firsts") {
    title = "No world firsts yet.";
    body = "Be the first anyone has made something, and it lands here with a gold seal.";
  } else {
    title = "Your library is empty.";
  }
  return (
    <div className={compact ? "flex h-full items-center gap-3 px-4" : "px-6 py-8 text-center"}>
      <div className={compact ? "min-w-0 flex-1" : ""}>
        <p className="font-semibold text-ink">{title}</p>
        {body && <p className="text-[14px] text-ink-muted">{body}</p>}
      </div>
      {query && (
        <button type="button" className={`chip ${compact ? "" : "mt-3"}`} onClick={() => openSheet("challenges")}>
          See today's challenges
        </button>
      )}
    </div>
  );
}
