// Keyboard safety for the library's sort <select>. On Windows and Linux a closed native select
// fires `change` on every ArrowUp/ArrowDown (also PageUp/PageDown/Home/End, and type-ahead: "c"
// jumps to "Custom…"), so a keyboard user looking through the options "picks" each one in turn.
// That is harmless for the built-in sorts, but "Custom…" opens a dialog and moves focus into it
// (a change of context on input, WCAG 3.2.2), and the stored "✦ …" sort can start a paid
// whole-library weighing run. "✦ …" also sits directly above "Custom…", so every keyboard trip
// to "Custom…" passes it. So a change that a navigation key caused only *arms* either option
// (the select shows it); Enter or Space then applies it, and Escape or leaving the select
// disarms it, back to the real sort. Mouse, touch and the option popup (Alt+Down, F4, or macOS,
// where arrows open the list) pick as before.
//
// Kept out of the .tsx so it unit-tests in node.
import type { BuiltInSort } from "../../lib/customSort.ts";

/** The "Custom…" option: opens the sheet, never a sort of its own (the select snaps back). */
export const EDIT_OPTION = "__edit";

const NAV_KEYS = new Set(["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", "PageUp", "PageDown", "Home", "End"]);

/**
 * A key that steps a closed select's selection: the navigation keys, or one typed character
 * (type-ahead). Alt/Meta+Arrow opens the option list instead, where a pick (Enter) is deliberate.
 * Space is never one: it opens an armed "Custom…" (and the option list otherwise).
 */
export const isNavKey = (e: { key: string; altKey?: boolean; metaKey?: boolean; ctrlKey?: boolean }): boolean =>
  !e.altKey && !e.metaKey && (NAV_KEYS.has(e.key) || (!e.ctrlKey && e.key.length === 1 && e.key !== " "));

/**
 * The browser dispatches a key-driven `change` inside that key's default action, so a change this
 * soon after a navigation keydown came from it. A pick in an option list that a key opened comes
 * much later (a person has to choose), so it still counts as deliberate.
 */
export const NAV_CHANGE_MS = 100;

/** Did this `change` (at `now`) come from the navigation keydown at `navAt`? */
export const changeFromNavKey = (navAt: number | null, now: number): boolean =>
  navAt !== null && now >= navAt && now - navAt < NAV_CHANGE_MS;

/** An option that a navigation key can only arm: "Custom…" or the stored "✦ …" sort. */
export type Armable = typeof EDIT_OPTION | "custom";

export type SortPick =
  | { do: "open-sheet" } // "Custom…" picked on purpose
  | { do: "arm"; option: Armable } // stepped onto with a key: wait for Enter/Space
  | { do: "disarm" } // stepped back onto the sort that is already active
  | { do: "custom" } // the stored "✦ …" sort, picked on purpose
  | { do: "sort"; sort: BuiltInSort };

/** What a `change` of the sort select to `value` should do, given the sort now active. */
export function sortPick(value: string, byNavKey: boolean, current: string): SortPick {
  if (value === EDIT_OPTION) return byNavKey ? { do: "arm", option: EDIT_OPTION } : { do: "open-sheet" };
  if (value === "custom") {
    if (!byNavKey) return { do: "custom" };
    return current === "custom" ? { do: "disarm" } : { do: "arm", option: "custom" };
  }
  return { do: "sort", sort: value as BuiltInSort };
}

/** While an option is armed: Enter/Space apply it, Escape snaps back to the real sort. */
export function armedKey(key: string): "open" | "disarm" | null {
  if (key === "Enter" || key === " ") return "open";
  if (key === "Escape") return "disarm";
  return null;
}
