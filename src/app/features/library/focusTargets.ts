// Where focus goes when a library control removes itself: turning custom sort off (×) unmounts
// the bar, Retry unmounts its own message line, and the search bridge chip leaves with the empty
// search it was in. Without a hand-off, focus would drop to <body>. Ids rather than refs: the
// controls live in different components (and the bar mounts only once a custom sort is on).

/** The library's sort <select> (one per page: the rail or the phone shelf). */
export const SORT_SELECT_ID = "library-sort";
/** The custom sort bar's lens chip ("✦ “spookiest”", opens the sheet). */
export const CUSTOM_SORT_LENS_ID = "custom-sort-lens";

/**
 * Should a tap/click hand focus off at all? Yes for the keyboard (a click from Enter/Space has
 * `detail === 0`) and a fine pointer. Not for touch: focusing a <select> during a tap can pop the
 * iOS picker wheel or zoom the page, and a touch user has no focus position to lose.
 */
export const wantsFocusHandoff = (e: { detail: number }): boolean =>
  e.detail === 0 || (typeof matchMedia === "function" && matchMedia("(pointer: fine)").matches);

/** Focus the control with this id: now if it's on screen, else once it mounts (a few frames at most). */
export function focusById(id: string, frames = 3): void {
  const el = document.getElementById(id);
  if (el) el.focus();
  else if (frames > 0) requestAnimationFrame(() => focusById(id, frames - 1));
}
