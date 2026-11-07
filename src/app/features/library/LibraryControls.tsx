// Search field, filter chips (All · Pinned · New · Firsts) and sort, plus empty states.
import { useId, useRef, useState } from "react";
import { SORT_PROMPT_MAX_CHARS } from "../../../shared/api.ts";
import { specLabel, specShortLabel } from "../../../shared/sortSpec.ts";
import type { CustomCounts } from "../../lib/librarySort.ts";
import { activateCustom, applyCustomSort, markCustomSortSeen, useCustomSort } from "../../state/customSort.ts";
import { useGame } from "../../state/game.ts";
import { openSheet, setLibraryView, useUi, type LibraryFilter } from "../../state/ui.ts";
import { CloseIcon, SearchIcon, SparkleIcon } from "../../components/Icons.tsx";
import { CUSTOM_SORT_LENS_ID, SORT_SELECT_ID, focusById, wantsFocusHandoff } from "./focusTargets.ts";
import { libraryEmptyCopy, type EmptyBucket } from "./libraryCopy.ts";
import { EDIT_OPTION, armedKey, changeFromNavKey, isNavKey, sortPick, type Armable } from "./sortSelectKeys.ts";
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

const openEditor = () => {
  markCustomSortSeen();
  openSheet("customSort");
};

export function SortSelect() {
  const sort = useUi((s) => s.sort);
  const spec = useCustomSort((s) => s.spec);
  const unseen = useCustomSort((s) => !s.seen);
  // A one-time hint, once the library is big enough for a custom order to be worth it.
  const grown = useGame((s) => s.stats.mine >= 12);
  const dot = unseen && grown;
  // Arrowing through a closed select fires `change` at every step (Windows/Linux). Stepping onto
  // "✦ …" or "Custom…" only arms it (shown selected) and Enter/Space applies it, so looking
  // through the options never pops a dialog or starts a weighing run; blur disarms. Pointer and
  // option-list picks apply at once. (Why in sortSelectKeys.ts.)
  const [armed, setArmed] = useState<Armable | null>(null);
  const navAt = useRef<number | null>(null);
  const hintId = useId();
  return (
    <span className="sort-wrap" data-new={dot ? "" : undefined}>
      <select
        id={SORT_SELECT_ID}
        className="sort-select"
        data-testid="sort-select"
        data-armed={armed ?? undefined}
        aria-label="Sort"
        aria-describedby={armed ? hintId : undefined}
        value={armed ?? sort}
        onKeyDown={(e) => {
          if (isNavKey(e)) {
            navAt.current = performance.now();
            return;
          }
          const k = armed ? armedKey(e.key) : null;
          if (!k) return;
          e.preventDefault(); // Space would also open the option list
          setArmed(null);
          if (k !== "open") return;
          if (armed === EDIT_OPTION) openEditor();
          else activateCustom();
        }}
        onPointerDown={() => (navAt.current = null)}
        onBlur={() => setArmed(null)}
        onChange={(e) => {
          // A native select can't re-pick its current option, so "Custom…" is its own entry.
          const pick = sortPick(e.target.value, changeFromNavKey(navAt.current, performance.now()), sort);
          navAt.current = null;
          setArmed(pick.do === "arm" ? pick.option : null);
          if (pick.do === "open-sheet") openEditor();
          else if (pick.do === "custom") activateCustom();
          else if (pick.do === "sort") setLibraryView({ sort: pick.sort });
        }}
      >
        <option value="recent">Recent</option>
        <option value="az">A–Z</option>
        <option value="rarity">Rarity</option>
        {spec && <option value="custom">{`✦ ${specShortLabel(spec)}`}</option>}
        <option value={EDIT_OPTION}>Custom…</option>
      </select>
      <span id={hintId} className="sr-only">
        Press Enter to open.
      </span>
    </span>
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

/** "✦ Rank everything by “metal”": a search that found nothing becomes a custom sort. */
function SearchBridge({ query }: { query: string }) {
  return (
    <button
      type="button"
      className="chip cs-lens max-w-full"
      data-testid="custom-sort-from-search"
      onClick={(e) => {
        markCustomSortSeen();
        applyCustomSort({ kind: "rank", prompt: query }, { source: "search", bucket: "matches" });
        useUi.setState({ query: "" });
        // This chip leaves with the empty search: the bar that now shows the sort takes focus.
        if (wantsFocusHandoff(e)) focusById(CUSTOM_SORT_LENS_ID);
      }}
    >
      <SparkleIcon size={14} className="flex-none" />
      <span className="min-w-0 truncate">Rank everything by “{query}”</span>
    </button>
  );
}

/** `counts`: the custom-sort counts of the same view, so an empty bucket can say so. */
export function LibraryEmpty({ compact, counts }: { compact?: boolean; counts?: CustomCounts | null }) {
  const query = useUi((s) => s.query.trim());
  const filter = useUi((s) => s.filter);
  const custom = useUi((s) => s.sort === "custom");
  const bucket = useCustomSort((s) => s.bucket);
  const committed = useCustomSort((s) => s.committed);
  // The bucket chip is what emptied a list that has elements (counts are taken before it).
  const bucketed = custom && bucket !== null && !!committed && !!counts && counts.all > 0;
  const bridge = !compact && !bucketed && query.length >= 2 && query.length <= SORT_PROMPT_MAX_CHARS;
  let emptied: EmptyBucket = null;
  if (bucketed && bucket === "matches") emptied = { kind: "matches", label: specLabel(committed.spec) };
  else if (bucketed && typeof bucket === "number") {
    const group = bucket === -1 ? "Other" : committed.spec.kind === "groups" ? committed.spec.groups[bucket] : undefined;
    emptied = { kind: "group", name: group ?? "Other" };
  }
  const { state, title, body } = libraryEmptyCopy({ bucket: emptied, compact: !!compact, query, filter });
  return (
    <div
      data-testid="library-empty"
      data-state={state}
      className={`reveal ${compact ? "flex h-full items-center gap-3 px-4" : "px-6 py-8 text-center"}`}
    >
      <div className={compact ? "min-w-0 flex-1" : ""}>
        <p className="font-semibold text-ink">{title}</p>
        {body && <p className="text-[14px] text-ink-muted">{body}</p>}
      </div>
      {query && !bucketed && (
        <div className={compact ? "flex-none" : "mt-3 flex flex-wrap items-center justify-center gap-2"}>
          {bridge && <SearchBridge query={query} />}
          <button type="button" className="chip" onClick={() => openSheet("challenges")}>
            See today's challenges
          </button>
        </div>
      )}
    </div>
  );
}
