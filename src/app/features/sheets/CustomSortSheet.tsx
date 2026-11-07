// "Sort by anything": describe an order in your own words (Rank) or name a few groups (Groups),
// and the engine (state/customSort.ts) weighs the whole library. The sheet only edits a draft:
// examples fill the form, recents apply at once, and Apply hands the normalized spec to
// applyCustomSort. Changing only the Other switch of the active spec is "Done": a display
// toggle, never a request.
import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from "react";
import { SORT_GROUPS_MAX, SORT_GROUPS_MIN, SORT_GROUP_MAX_CHARS, SORT_PROMPT_MAX_CHARS, type SortSpec } from "../../../shared/api.ts";
import { cleanSortText, normalizeSpec, specKey, specLabel, type SortSpecProblem } from "../../../shared/sortSpec.ts";
import type { SavedSort } from "../../lib/customSort.ts";
import { applyCustomSort, budgetBlocked, isCached, markCustomSortSeen, setOtherView, useCustomSort } from "../../state/customSort.ts";
import { useGame } from "../../state/game.ts";
import { openSheet, useUi } from "../../state/ui.ts";
import { CloseIcon, LayersIcon, SparkleIcon } from "../../components/Icons.tsx";
import { Sheet } from "./Sheet.tsx";
import {
  GROUPS_EXAMPLES,
  RANK_EXAMPLES,
  RANK_HELPER,
  applyLabel,
  groupPlaceholder,
  isLiveProblem,
  listHint,
  problemCopy,
  problemRow,
  type GroupsExample,
  type RankExample,
} from "./customSortExamples.ts";

const DESCRIPTION = "Describe an order in your own words and AI weighs every element you own.";
const BUDGET = "Custom sorting is resting until tomorrow. Your other sorts still work.";
const FINE_PRINT = "Uses AI, so expect a few surprises. Your words are only used to sort your library.";
/** At or below this many elements a custom order has little to show. */
const SMALL_LIBRARY = 12;
const MICRO_LABEL = "text-[11.5px] font-bold uppercase tracking-[0.14em] text-ink-muted";

type Mode = SortSpec["kind"];
const MODES: { id: Mode; label: string }[] = [
  { id: "rank", label: "Rank" },
  { id: "groups", label: "Groups" },
];

/** A group field; the id keeps React's input (and its focus) attached to the right row on removal. */
interface Row {
  id: number;
  text: string;
}
let rowSeq = 0;
const toRows = (groups: readonly string[]): Row[] => groups.map((text) => ({ id: ++rowSeq, text }));

/** Mouse/trackpad: autofocusing a field is welcome. On touch it would pop the keyboard and jump the sheet. */
const finePointer = () => matchMedia("(pointer: fine)").matches;

const recentLabel = (spec: SortSpec) => (spec.kind === "rank" ? `“${spec.prompt}”` : specLabel(spec));

function Switch({ checked, onChange, label, testId }: { checked: boolean; onChange: (v: boolean) => void; label: string; testId: string }) {
  return (
    <button type="button" role="switch" aria-checked={checked} aria-label={label} className="switch" data-testid={testId} onClick={() => onChange(!checked)} />
  );
}

function SortForm() {
  // Seeded once per opening (the sheet remounts this form on every open): the active spec,
  // or a blank Rank field for a first-timer.
  const [initial] = useState(() => {
    const { spec, view } = useCustomSort.getState();
    return { spec, other: view.other };
  });
  const [mode, setModeState] = useState<Mode>(initial.spec?.kind ?? "rank");
  const [prompt, setPrompt] = useState(initial.spec?.kind === "rank" ? initial.spec.prompt : "");
  const [rows, setRows] = useState<Row[]>(() => toRows(initial.spec?.kind === "groups" ? initial.spec.groups : ["", "", ""]));
  const [other, setOther] = useState(initial.other);
  /** The player tried to apply an incomplete form: "empty" problems may show now. */
  const [attempted, setAttempted] = useState(false);
  /** specKey of the example last tapped (analytics source "example" unless edited since). */
  const [exampleKey, setExampleKey] = useState<string | null>(null);

  const sort = useUi((s) => s.sort);
  const activeKey = useCustomSort((s) => s.key);
  const recent = useCustomSort((s) => s.recent);
  const failure = useCustomSort((s) => s.failure);
  const owned = useGame((s) => s.owned);
  const count = useMemo(() => Object.keys(owned).length, [owned]);
  // The sheet can open before bootstrap lands (the select and `s` work meanwhile): `owned` is
  // still empty then, so no "Sort 0 elements" or small-library note, and nothing applies yet.
  const loading = useGame((s) => s.status !== "ready");

  const inputId = useId();
  const helpId = useId();
  const errorId = useId();
  const groupsLabelId = useId();
  const examplesId = useId();
  const recentsId = useId();

  // Focus targets by name; a change that removes the focused control names where focus goes.
  const nodes = useRef(new Map<string, HTMLElement>());
  const reg = (name: string) => (el: HTMLElement | null) => {
    if (el) nodes.current.set(name, el);
    else nodes.current.delete(name);
  };
  /** Candidates in order: the first one that exists and isn't disabled gets focus. */
  const pendingFocus = useRef<string[] | null>(null);
  const focusAfterRender = (...names: string[]) => {
    pendingFocus.current = names;
  };
  useLayoutEffect(() => {
    const names = pendingFocus.current;
    if (!names) return;
    pendingFocus.current = null;
    for (const name of names) {
      const el = nodes.current.get(name);
      if (el && !(el instanceof HTMLButtonElement && el.disabled)) {
        el.focus();
        return;
      }
    }
  });

  useEffect(() => {
    markCustomSortSeen(); // however the sheet was opened (select, `s`), the select's "new" dot can go
    if (!finePointer()) return;
    // After Radix has focused the sheet itself (its autofocus runs after this effect).
    const raf = requestAnimationFrame(() => {
      if (initial.spec?.kind === "groups") {
        nodes.current.get("group:0")?.focus({ preventScroll: true });
        return;
      }
      const el = nodes.current.get("input");
      el?.focus({ preventScroll: true });
      // Prefilled with the active prompt: typing replaces it, arrows edit it.
      if (el instanceof HTMLInputElement) el.select();
    });
    return () => cancelAnimationFrame(raf);
  }, [initial]);

  // ---------------------------------------------------------------- derived
  const draft: SortSpec = mode === "rank" ? { kind: "rank", prompt } : { kind: "groups", groups: rows.map((r) => r.text) };
  const norm = normalizeSpec(draft);
  const key = norm.ok ? specKey(norm.spec) : null;
  /** The form is the sort already on screen: nothing to weigh. */
  const done = key !== null && sort === "custom" && key === activeKey;
  const blocked = failure !== null && budgetBlocked();
  // The block lifts by itself at `until` (no store change then): re-render so Apply comes back
  // without reopening the sheet.
  const [, setWoke] = useState(0);
  const until = blocked ? failure.until : undefined;
  useEffect(() => {
    if (until === undefined) return;
    const t = setTimeout(() => setWoke((n) => n + 1), Math.min(2_147_000_000, Math.max(0, until - Date.now()) + 50));
    return () => clearTimeout(t);
  }, [until]);
  // Apply stays enabled for an incomplete form, so a tap can say what's missing (a dead button
  // would give no reason); it's disabled only when it can't do anything: budget-blocked with
  // nothing cached, or while the library loads.
  const budgetHeld = norm.ok && !done && blocked && !isCached(norm.spec);
  const applyDisabled = loading || budgetHeld;
  const problem = norm.ok ? null : norm.problem;
  const error = problem && (attempted || isLiveProblem(problem)) ? problemCopy(problem, mode) : null;
  /** The group row the error is about when no row is invalid by itself (a blank row to fill). */
  const badRow = error && problem && mode === "groups" ? problemRow(rows.map((r) => r.text), problem) : -1;
  const hint = mode === "rank" ? listHint(prompt) : null;
  const recents = recent.filter((r) => !(sort === "custom" && specKey(r.spec) === activeKey));

  // Per row: its colour (the group index once blank rows are dropped) and whether it's the
  // duplicate / "Other" the error line is about (those never become a group: no colour).
  const rowInfo = useMemo(() => {
    const seen = new Set<string>();
    let filled = 0;
    return rows.map((r) => {
      const t = cleanSortText(r.text).toLowerCase();
      if (!t) return { group: null, invalid: false };
      if (t === "other" || seen.has(t)) return { group: null, invalid: true };
      seen.add(t);
      return { group: filled++, invalid: false };
    });
  }, [rows]);

  // Right under the fields it's about, so it's in view while typing (a phone keyboard covers
  // the bottom of the sheet).
  const errorLine = error && (
    <p id={errorId} className="mt-2 text-[13px] font-semibold text-danger" role="alert" data-testid="custom-sort-error">
      {error}
    </p>
  );

  // ---------------------------------------------------------------- actions
  const setMode = (m: Mode, byPointer: boolean) => {
    if (m === mode) return;
    setModeState(m);
    setAttempted(false);
    // A mouse click on "Groups" means "let me type groups"; keyboard focus stays on the radio.
    if (byPointer && finePointer()) {
      const empty = rows.find((r) => !r.text.trim()) ?? rows[0];
      focusAfterRender(m === "rank" ? "input" : `group:${empty ? rows.indexOf(empty) : 0}`);
    }
  };

  const fillRank = (ex: RankExample) => {
    setModeState("rank");
    setPrompt(ex.prompt);
    setAttempted(false);
    setExampleKey(specKey({ kind: "rank", prompt: ex.prompt }));
  };
  const fillGroups = (ex: GroupsExample) => {
    setModeState("groups");
    setRows(toRows(ex.groups));
    setOther(ex.other);
    setAttempted(false);
    setExampleKey(specKey({ kind: "groups", groups: ex.groups }));
  };

  const switchToGroups = (groups: string[]) => {
    setModeState("groups");
    setRows(toRows(groups));
    setAttempted(false);
    // The hint button is about to disappear: land on Apply, or on the fields if it can't apply.
    focusAfterRender("apply", "group:0");
  };

  const setRowText = (id: number, text: string) => setRows((rs) => rs.map((r) => (r.id === id ? { ...r, text } : r)));
  const addRow = () => {
    if (rows.length >= SORT_GROUPS_MAX) return;
    setRows([...rows, { id: ++rowSeq, text: "" }]);
    focusAfterRender(`group:${rows.length}`);
  };
  const removeRow = (id: number) => {
    if (rows.length <= SORT_GROUPS_MIN) return;
    const i = rows.findIndex((r) => r.id === id);
    const next = rows.filter((r) => r.id !== id);
    setRows(next);
    // Stay on a remove button (no keyboard popping up on phones), or on "+ Add group" once the
    // remove buttons go away at two rows.
    focusAfterRender(`remove:${Math.min(i, next.length - 1)}`, "add");
  };

  /** An apply attempt on an incomplete form: show the problem (role=alert) and focus its field. */
  const showProblem = (p: SortSpecProblem) => {
    const field = mode === "rank" ? "input" : `group:${problemRow(rows.map((r) => r.text), p)}`;
    // Already showing (a second try): nothing re-renders, so focus now.
    if (attempted) nodes.current.get(field)?.focus();
    else {
      setAttempted(true);
      focusAfterRender(field); // once the alert is in, so the field's description includes it
    }
  };

  const submit = () => {
    if (!norm.ok) {
      showProblem(norm.problem);
      return;
    }
    if (applyDisabled) return;
    if (done) {
      if (norm.spec.kind === "groups") setOtherView(other);
    } else {
      applyCustomSort(norm.spec, {
        other: norm.spec.kind === "groups" ? other : undefined,
        source: key === exampleKey ? "example" : "typed",
      });
    }
    openSheet(null);
  };

  const applyRecent = (r: SavedSort) => {
    applyCustomSort(r.spec, { other: r.spec.kind === "groups" ? r.other : undefined, source: "recent" });
    openSheet(null);
  };

  /** Enter does what Apply does: applies, or says what's missing (also while Apply is disabled). */
  const onEnter = (e: ReactKeyboardEvent<HTMLInputElement>, row?: number) => {
    if (e.key !== "Enter" || e.nativeEvent.isComposing) return;
    e.preventDefault();
    // Typing a list of groups: Enter moves on to the next empty row.
    if (row !== undefined && rows[row + 1] && !rows[row + 1]!.text.trim()) {
      nodes.current.get(`group:${row + 1}`)?.focus();
      return;
    }
    submit();
  };

  const describedBy = (...ids: (string | false | null)[]) => ids.filter(Boolean).join(" ") || undefined;

  return (
    <form
      noValidate
      onSubmit={(e) => {
        e.preventDefault();
        submit();
      }}
    >
      {/* Visible twin of the dialog's (screen-reader only) description: hidden from assistive
          tech so it isn't read twice. */}
      <p aria-hidden="true" className="text-[13px] text-ink-muted">
        {DESCRIPTION}
      </p>

      <div className="seg mt-4 flex w-full" role="radiogroup" aria-label="Sort type" data-testid="custom-sort-mode">
        {MODES.map((m) => (
          <button key={m.id} type="button" role="radio" aria-checked={mode === m.id} data-mode={m.id} className="flex-1" onClick={(e) => setMode(m.id, e.detail > 0)}>
            {m.label}
          </button>
        ))}
      </div>

      {mode === "rank" ? (
        <div className="mt-4">
          <label htmlFor={inputId} className="block text-[14px] font-semibold">
            Put first…
          </label>
          <input
            ref={reg("input")}
            id={inputId}
            className="field mt-1.5 aria-[invalid=true]:border-danger"
            data-testid="custom-sort-input"
            placeholder="e.g. spookiest"
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            onKeyDown={(e) => onEnter(e)}
            maxLength={SORT_PROMPT_MAX_CHARS}
            enterKeyHint="go"
            autoComplete="off"
            autoCapitalize="none"
            aria-invalid={error ? true : undefined}
            aria-describedby={describedBy(helpId, !!error && errorId)}
          />
          {errorLine}
          <p id={helpId} className="mt-1.5 text-[13px] text-ink-muted">
            {RANK_HELPER}
          </p>
          {/* Polite: someone typing a list hears the suggestion without leaving the field. */}
          <div aria-live="polite">
            {hint && (
              <div className="mt-2.5 flex items-center gap-3 rounded-[14px] bg-surface-2 py-1.5 pl-3 pr-1.5">
                <p className="min-w-0 flex-1 text-[13px] font-medium">Looks like a list. Sort into groups instead?</p>
                <button type="button" className="btn btn-sm btn-quiet flex-none" data-testid="custom-sort-use-groups" onClick={() => switchToGroups(hint)}>
                  Use groups
                </button>
              </div>
            )}
          </div>
        </div>
      ) : (
        <div className="mt-4">
          <p id={groupsLabelId} className="text-[14px] font-semibold">
            Groups
          </p>
          <div role="group" aria-labelledby={groupsLabelId} className="mt-1.5 flex flex-col gap-2">
            {rows.map((r, i) => {
              const info = rowInfo[i];
              const next = rows[i + 1];
              // A duplicate / "Other" row is invalid by itself; a blank row only while the
              // error asks for it to be filled.
              const flagged = !!info?.invalid || i === badRow;
              return (
                <div key={r.id} className="flex items-center gap-2">
                  {/* The colour this group's tiles and chip will carry. */}
                  <span
                    aria-hidden="true"
                    className="h-2 w-2 flex-none rounded-full transition-colors"
                    style={{ background: info?.group == null ? "var(--border-strong)" : `var(--grp-${info.group}, var(--border-strong))` }}
                  />
                  <input
                    ref={reg(`group:${i}`)}
                    className="field min-w-0 flex-1 aria-[invalid=true]:border-danger"
                    data-testid="custom-sort-group"
                    aria-label={`Group ${i + 1}`}
                    placeholder={groupPlaceholder(i)}
                    value={r.text}
                    onChange={(e) => setRowText(r.id, e.target.value)}
                    onKeyDown={(e) => onEnter(e, i)}
                    maxLength={SORT_GROUP_MAX_CHARS}
                    enterKeyHint={next && !next.text.trim() ? "next" : "go"}
                    autoComplete="off"
                    aria-invalid={flagged ? true : undefined}
                    aria-describedby={describedBy(!!error && flagged && errorId)}
                  />
                  {rows.length > SORT_GROUPS_MIN && (
                    <button
                      ref={reg(`remove:${i}`)}
                      type="button"
                      className="icon-btn -mr-2 flex-none"
                      data-testid="custom-sort-remove-group"
                      aria-label={`Remove group ${i + 1}`}
                      onClick={() => removeRow(r.id)}
                    >
                      <CloseIcon size={18} />
                    </button>
                  )}
                </div>
              );
            })}
          </div>
          {errorLine}
          {rows.length < SORT_GROUPS_MAX && (
            <button ref={reg("add")} type="button" className="btn btn-sm btn-quiet ml-4 mt-3" data-testid="custom-sort-add-group" onClick={addRow}>
              + Add group
            </button>
          )}
          <div className="mt-3 flex min-h-[56px] items-center gap-4 border-t border-border py-2">
            <div className="min-w-0 flex-1">
              <p className="font-semibold">Put weak fits in Other</p>
              <p className="text-[13px] text-ink-muted">Off: every element joins its closest group.</p>
            </div>
            <Switch label="Put weak fits in Other" checked={other} onChange={setOther} testId="custom-sort-other" />
          </div>
        </div>
      )}

      <div className="mt-5">
        <p id={examplesId} className={MICRO_LABEL}>
          Try one
        </p>
        <div role="group" aria-labelledby={examplesId} className="mt-2 flex flex-wrap gap-x-2 gap-y-3">
          {mode === "rank"
            ? RANK_EXAMPLES.map((ex) => (
                <button key={ex.id} type="button" className="chip max-w-full text-ink" data-testid="custom-sort-example" data-example={ex.id} onClick={() => fillRank(ex)}>
                  <span aria-hidden="true">{ex.emoji}</span>
                  <span className="min-w-0 truncate">{ex.label}</span>
                </button>
              ))
            : GROUPS_EXAMPLES.map((ex) => (
                <button key={ex.id} type="button" className="chip max-w-full text-ink" data-testid="custom-sort-example" data-example={ex.id} onClick={() => fillGroups(ex)}>
                  <span aria-hidden="true">{ex.emoji}</span>
                  <span className="min-w-0 truncate">{ex.label}</span>
                </button>
              ))}
        </div>
      </div>

      {recents.length > 0 && (
        <div className="mt-5">
          <p id={recentsId} className={MICRO_LABEL}>
            Recent sorts
          </p>
          <div role="group" aria-labelledby={recentsId} className="mt-2 flex flex-wrap gap-x-2 gap-y-3">
            {recents.map((r) => {
              const label = recentLabel(r.spec);
              return (
                <button
                  key={specKey(r.spec)}
                  type="button"
                  className="chip max-w-full text-ink disabled:opacity-50"
                  data-testid="custom-sort-recent"
                  data-kind={r.spec.kind}
                  title={label}
                  disabled={loading || (blocked && !isCached(r.spec))}
                  onClick={() => applyRecent(r)}
                >
                  {r.spec.kind === "rank" ? <SparkleIcon size={13} className="flex-none text-accent" /> : <LayersIcon size={15} className="flex-none text-accent" />}
                  <span className="min-w-0 truncate">{label}</span>
                </button>
              );
            })}
          </div>
        </div>
      )}

      {loading ? (
        <p className="mt-5 text-[13px] text-ink-muted" role="status" data-testid="custom-sort-loading">
          Loading your library…
        </p>
      ) : (
        count <= SMALL_LIBRARY && <p className="mt-5 text-[13px] text-ink-muted">Works best once you've made a few dozen elements.</p>
      )}
      {blocked && (
        <p className="mt-4 rounded-[14px] bg-surface-2 px-3 py-2.5 text-[13px] font-semibold" role="status">
          {BUDGET}
        </p>
      )}
      <div className="mt-5 flex flex-col gap-2">
        <button
          ref={reg("apply")}
          type="submit"
          className="btn btn-primary w-full"
          data-testid="custom-sort-apply"
          data-action={done ? "done" : "apply"}
          disabled={applyDisabled}
        >
          {!done && <SparkleIcon size={18} />}
          {applyLabel(mode, loading ? null : count, done)}
        </button>
        <button type="button" className="btn btn-quiet w-full" data-testid="custom-sort-cancel" onClick={() => openSheet(null)}>
          Cancel
        </button>
      </div>
      <p className="mt-3 text-center text-[12px] text-ink-muted">{FINE_PRINT}</p>
    </form>
  );
}

const TITLE = (
  <span className="flex items-center gap-2">
    <SparkleIcon size={20} className="flex-none text-accent" />
    Sort by anything
  </span>
);

export default function CustomSortSheet({ open }: { open: boolean }) {
  // The host keeps this sheet mounted, so each opening starts a fresh form from the store: a new
  // key on every open (Radix also unmounts closed content, but not if it reopens mid-animation).
  const [opening, setOpening] = useState({ open, n: 0 });
  if (opening.open !== open) setOpening({ open, n: open ? opening.n + 1 : opening.n });
  return (
    // returnFocus: back to the select (or the bar's lens) it was opened from, e.g. after Enter on
    // an armed "Custom…" and then Escape or Cancel.
    <Sheet open={open} onOpenChange={(o) => !o && openSheet(null)} title={TITLE} description={DESCRIPTION} testId="custom-sort-sheet" returnFocus>
      <SortForm key={opening.n} />
    </Sheet>
  );
}
