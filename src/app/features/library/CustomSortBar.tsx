// The active custom sort ("Sort by anything"), under the library controls: what the library is
// ordered by (tap to edit), progress while it weighs, the Matches / group bucket chips, reverse
// and turn-off, plus one message line (failures, partial or truncated results, a weak match).
// CustomSortLine is the same sort's line in the element details popover.
//
// Everything here only reads the engine store (state/customSort.ts) and calls its actions; the
// order itself comes from useLibraryView, so the bar never re-sorts anything.
import { useMemo, type ReactNode } from "react";
import { SORT_MATCH_THRESHOLD, SORT_MAX_ELEMENTS, type ElementId } from "../../../shared/api.ts";
import { specLabel } from "../../../shared/sortSpec.ts";
import { formatCount } from "../../lib/format.ts";
import { useNow } from "../../lib/hooks.ts";
import { groupOf, levelLabel, rankOf, type Committed, type CustomCounts } from "../../lib/librarySort.ts";
import {
  clearCustomSort,
  customSortFailureText,
  formatWait,
  retryCustomSort,
  setBucket,
  toggleReverse,
  useCustomSort,
  type SortFailure,
} from "../../state/customSort.ts";
import { useGame } from "../../state/game.ts";
import { openSheet, useUi } from "../../state/ui.ts";
import { CloseIcon, ReverseIcon, SparkleIcon } from "../../components/Icons.tsx";
import { CUSTOM_SORT_LENS_ID, SORT_SELECT_ID, focusById, wantsFocusHandoff } from "./focusTargets.ts";
import { weakMatchText } from "./libraryCopy.ts";

/** Static class names (Tailwind only generates what it can read): one colour per group slot. */
const GROUP_DOT = [
  "bg-[var(--grp-0)]",
  "bg-[var(--grp-1)]",
  "bg-[var(--grp-2)]",
  "bg-[var(--grp-3)]",
  "bg-[var(--grp-4)]",
  "bg-[var(--grp-5)]",
  "bg-[var(--grp-6)]",
  "bg-[var(--grp-7)]",
];

const editSort = () => openSheet("customSort");

// Both remove the control that was pressed (the whole bar, or the message line): hand focus to
// what stays on screen, the select that now shows the restored sort, or the lens chip. Keyboard
// and mouse only (see wantsFocusHandoff: focusing the select from a tap can open the iOS picker).
const turnOff = (e: { detail: number }) => {
  clearCustomSort();
  if (wantsFocusHandoff(e)) focusById(SORT_SELECT_ID);
};
const retry = (e: { detail: number }) => {
  retryCustomSort();
  if (wantsFocusHandoff(e)) focusById(CUSTOM_SORT_LENS_ID);
};

export function CustomSortBar({ counts }: { counts: CustomCounts | null }) {
  const on = useUi((s) => s.sort === "custom");
  const spec = useCustomSort((s) => s.spec);
  const key = useCustomSort((s) => s.key);
  const committed = useCustomSort((s) => s.committed);
  const status = useCustomSort((s) => s.status);
  const slow = useCustomSort((s) => s.slow);
  const reverse = useCustomSort((s) => s.view.reverse);
  const other = useCustomSort((s) => s.view.other);
  const bucket = useCustomSort((s) => s.bucket);
  const mine = useGame((s) => s.stats.mine);
  if (!on || !spec) return null;

  const label = specLabel(spec);
  const lens = spec.kind === "rank" ? `“${spec.prompt}”${reverse ? ", reversed" : ""}` : spec.groups.join(" · ");
  // The order on screen is for the active spec (not a previous one still showing while it weighs).
  const current = !!committed && committed.key === key;
  const scoring = status === "scoring";
  const rankCounts = current && committed.kind === "rank" && counts?.kind === "rank" ? counts : null;
  // Kept while its bucket is on (even reversed, which the engine never combines with Matches), so
  // a bucket that filters the grid can always be turned off from here.
  const showMatches = !!rankCounts && (bucket === "matches" || (!reverse && rankCounts.matches > 0));
  const groupCounts = current && committed.spec.kind === "groups" && counts?.kind === "groups" ? counts : null;
  const groups = committed?.spec.kind === "groups" ? committed.spec.groups : [];

  return (
    <div
      role="group"
      aria-label="Custom sort"
      data-testid="custom-sort-bar"
      data-status={status}
      data-kind={committed?.kind ?? spec.kind}
      className="relative flex-none border-b border-border px-4 pb-1.5"
    >
      {/* Row 1. The lens yields width first (down to one finger, and never more than half), so
          "Weighing n…" or "Matches n" always fits beside the two buttons, even on the 288 px
          tablet rail; the sort's name is also on the select. */}
      <div className="flex h-11 items-center gap-1.5">
        <button
          id={CUSTOM_SORT_LENS_ID}
          type="button"
          className="chip cs-lens min-w-11 max-w-[50%] flex-[0_1_auto]"
          data-testid="custom-sort-edit"
          aria-label={`Edit custom sort: ${label}`}
          title={lens}
          onClick={editSort}
        >
          <SparkleIcon size={14} className="flex-none" />
          <span className="min-w-0 truncate">{lens}</span>
        </button>
        <div className="flex flex-none items-center">
          {scoring ? (
            <p role="status" className="whitespace-nowrap text-[13px] text-ink-muted">
              {slow ? "Still weighing…" : `Weighing ${formatCount(mine)}…`}
            </p>
          ) : (
            showMatches && (
              <button
                type="button"
                className="chip"
                data-testid="custom-sort-matches"
                aria-pressed={bucket === "matches"}
                onClick={() => setBucket(bucket === "matches" ? null : "matches")}
              >
                Matches <span className="count">{formatCount(rankCounts.matches)}</span>
              </button>
            )
          )}
        </div>
        <div className="ml-auto flex flex-none items-center gap-1.5">
          {spec.kind === "rank" && (
            <button
              type="button"
              className={`icon-btn cs-icon ${reverse ? "text-accent" : ""}`}
              data-testid="custom-sort-reverse"
              aria-label="Reverse order"
              aria-pressed={reverse}
              onClick={toggleReverse}
            >
              <ReverseIcon />
            </button>
          )}
          <button type="button" className="icon-btn cs-icon" data-testid="custom-sort-clear" aria-label="Turn off custom sort" onClick={turnOff}>
            <CloseIcon />
          </button>
        </div>
      </div>
      {groupCounts && (
        <div role="group" aria-label="Groups" className="no-scrollbar -mx-4 flex gap-1.5 overflow-x-auto px-4 py-1.5" style={{ touchAction: "pan-x" }}>
          <button type="button" className="chip" data-testid="custom-sort-bucket" data-bucket="all" aria-pressed={bucket === null} onClick={() => setBucket(null)}>
            All <span className="count">{formatCount(groupCounts.all)}</span>
          </button>
          {groups.map((g, j) => (
            <button
              key={`${j}:${g}`}
              type="button"
              className="chip"
              data-testid="custom-sort-bucket"
              data-bucket={j}
              aria-pressed={bucket === j}
              onClick={() => setBucket(bucket === j ? null : j)}
            >
              <span aria-hidden="true" className={`h-2 w-2 flex-none rounded-full ${GROUP_DOT[j] ?? ""}`} />
              <span className="max-w-[10rem] truncate">{g}</span>{" "}
              <span className="count">{formatCount(groupCounts.groups[j] ?? 0)}</span>
            </button>
          ))}
          {other && (
            <button type="button" className="chip" data-testid="custom-sort-bucket" data-bucket="other" aria-pressed={bucket === -1} onClick={() => setBucket(bucket === -1 ? null : -1)}>
              Other <span className="count">{formatCount(groupCounts.other)}</span>
            </button>
          )}
        </div>
      )}
      <CustomSortMessage committed={current ? committed : null} label={label} />
      {scoring && <span aria-hidden="true" className="cs-progress" />}
    </div>
  );
}

/**
 * "m:ss" that ticks. Its own aria-live="off" keeps the ticks out of the enclosing alert: screen
 * readers hear the whole line (with the wait) once, when it appears, not every second.
 */
function ResumesIn({ until }: { until: number }) {
  const now = useNow(500);
  return (
    <span aria-live="off" className="tabular">
      {formatWait(until - now)}
    </span>
  );
}

function failureAction(f: SortFailure): { label: string; run: (e: { detail: number }) => void } | null {
  if (f.code === "rate_limited" || f.code === "budget_exhausted") return null; // they resume on their own
  if (f.code === "unauthorized") return { label: "Reload", run: () => location.reload() };
  return { label: "Retry", run: retry };
}

/** One line, highest priority first: failure, truncated, partial, weak match. */
function CustomSortMessage({ committed, label }: { committed: Committed | null; label: string }) {
  const failure = useCustomSort((s) => s.failure);
  const truncated = useCustomSort((s) => s.truncated);
  const unweighed = useCustomSort((s) => s.unweighed);
  const reverse = useCustomSort((s) => s.view.reverse);
  // Over the whole library (not the filtered view): did anything clearly match at all?
  const weak = useMemo(() => {
    if (committed?.kind !== "rank" || committed.scores.size === 0) return false;
    for (const s of committed.scores.values()) if (s >= SORT_MATCH_THRESHOLD) return false;
    return true;
  }, [committed]);

  let text: ReactNode = null;
  let action: { label: string; run: (e: { detail: number }) => void } | null = null;
  let alert = false;
  if (failure) {
    alert = true;
    action = failureAction(failure);
    text =
      failure.code === "rate_limited" && failure.until !== undefined ? (
        <>
          Easy there, alchemist. Weighing resumes in <ResumesIn until={failure.until} />.
        </>
      ) : (
        customSortFailureText(failure)
      );
  } else if (truncated) {
    text = `Weighed your ${formatCount(SORT_MAX_ELEMENTS)} newest elements.`;
  } else if (unweighed > 0) {
    text = `${formatCount(unweighed)} couldn't be weighed.`;
    action = { label: "Retry", run: retry };
  } else if (weak && !reverse) {
    text = weakMatchText(label);
    action = { label: "Edit", run: editSort };
  }
  if (!text) return null;
  return (
    <div data-testid="custom-sort-message" role={alert ? "alert" : "status"} className="flex items-center gap-2 pt-0.5">
      <p className={`min-w-0 flex-1 text-[13px] leading-snug ${alert ? "text-ink" : "text-ink-muted"}`}>{text}</p>
      {action && (
        <button type="button" className="btn btn-sm btn-quiet flex-none" data-testid="custom-sort-retry" onClick={action.run}>
          {action.label}
        </button>
      )}
    </div>
  );
}

/** The details popover's line: "✦ #3 of 340 for “spookiest” · Clear match", "In Animals", … */
export function CustomSortLine({ id }: { id: ElementId }) {
  const on = useUi((s) => s.sort === "custom");
  const spec = useCustomSort((s) => s.spec);
  const committed = useCustomSort((s) => s.committed);
  const pending = useCustomSort((s) => s.pending.has(id));
  const reverse = useCustomSort((s) => s.view.reverse);
  const other = useCustomSort((s) => s.view.other);
  const owned = useGame((s) => s.owned);
  // O(library) once per open, not per store update. Names break ties as the grid does, so the
  // rank is the tile's own place among the scored tiles.
  const rank = useMemo(() => {
    if (!on || committed?.kind !== "rank") return null;
    const els = useGame.getState().elements;
    return rankOf(committed, id, reverse, owned, (x) => els[x]?.name ?? "");
  }, [on, committed, id, reverse, owned]);
  if (!on || !Object.hasOwn(owned, id)) return null;

  let text: string | null = null;
  if (pending && spec) text = `Weighing for “${specLabel(spec)}”…`;
  else if (committed) {
    const label = specLabel(committed.spec);
    const score = committed.scores.get(id);
    if (committed.kind === "rank") {
      if (rank && score !== undefined) text = `#${formatCount(rank.rank)} of ${formatCount(rank.of)} for “${label}” · ${levelLabel(score)}`;
    } else if (committed.spec.kind === "groups") {
      const names = committed.spec.groups;
      const g = groupOf(committed, id, other);
      if (g === -1) {
        const closest = names[committed.groups?.get(id) ?? -1];
        text = closest ? `In Other · closest: ${closest}` : "In Other";
      } else if (g !== undefined) text = `In ${names[g]}`;
    }
  }
  if (!text) return null;
  return (
    <p data-testid="quick-actions-custom-sort" className="mt-0.5 flex items-center gap-1 text-[12.5px] font-semibold text-accent">
      <SparkleIcon size={12} className="flex-none" />
      <span className="min-w-0">{text}</span>
    </p>
  );
}
