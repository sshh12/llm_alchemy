// Example sorts for the "Sort by anything" sheet, plus the sheet's pure copy helpers (kept out
// of the .tsx so they run in node unit tests). Examples are client-only text: tapping one only
// fills the form, and nothing about them goes on the wire (no preset ids, no server table).
import { SORT_GROUPS_MAX, SORT_GROUPS_MIN, SORT_GROUP_MAX_CHARS, type SortSpec } from "../../../shared/api.ts";
import { cleanSortText, type SortSpecProblem } from "../../../shared/sortSpec.ts";
import { formatCount } from "../../lib/format.ts";

export interface RankExample {
  /** data-example (e2e contract). */
  id: string;
  emoji: string;
  label: string;
  prompt: string;
}

export interface GroupsExample {
  id: string;
  emoji: string;
  label: string;
  groups: string[];
  /** The "Put weak fits in Other" switch it fills in. */
  other: boolean;
}

export const RANK_EXAMPLES: readonly RankExample[] = [
  { id: "spookiest", emoji: "👻", label: "Spookiest", prompt: "spookiest" },
  { id: "biggest", emoji: "🪐", label: "Biggest", prompt: "biggest" },
  { id: "cutest", emoji: "🐶", label: "Cutest", prompt: "cutest" },
  { id: "hottest", emoji: "🔥", label: "Hottest", prompt: "hottest" },
  { id: "kitchen", emoji: "🍳", label: "Things in a kitchen", prompt: "things in a kitchen" },
  { id: "ocean", emoji: "🌊", label: "Related to the ocean", prompt: "related to the ocean" },
  { id: "dangerous", emoji: "☠️", label: "Most dangerous", prompt: "most dangerous" },
  { id: "oldest", emoji: "🦖", label: "Oldest", prompt: "oldest" },
];

export const GROUPS_EXAMPLES: readonly GroupsExample[] = [
  { id: "animals-food-weather", emoji: "🐾", label: "Animals · Food · Weather", groups: ["Animals", "Food & drink", "Weather"], other: true },
  // Every element has a closest classical element, so nothing should land in Other.
  { id: "classical", emoji: "🔥", label: "Fire · Water · Earth · Air", groups: ["Fire", "Water", "Earth", "Air"], other: false },
  { id: "land-sea-sky-space", emoji: "🌍", label: "Land · Sea · Sky · Space", groups: ["On land", "In the sea", "In the sky", "In outer space"], other: false },
  { id: "living-nature-made-ideas", emoji: "🌱", label: "Living · Nature · Made · Ideas", groups: ["Living things", "Nature", "Made by people", "Ideas"], other: false },
  { id: "heroes-villains", emoji: "🦸", label: "Heroes · Villains", groups: ["Heroes", "Villains"], other: true },
];

/**
 * The Rank field's helper. Each kind it names is measured (evals, rubric r2): vibes, sizes and
 * places work best, and negations ("least spooky") and intersections ("small and spooky") work
 * as typed, with no parsing on our side.
 */
export const RANK_HELPER =
  "A vibe (“cutest”), a size (“biggest”) or a place (“things in a kitchen”) works best. “Least spooky” and “small and spooky” work too.";

/** Group field placeholders by row; rows past these read "Another group". */
export const GROUP_PLACEHOLDERS = ["e.g. Animals", "e.g. Food", "e.g. Weather"] as const;
export const groupPlaceholder = (i: number): string => GROUP_PLACEHOLDERS[i] ?? "Another group";

const LIST_SEPARATORS = /[,;/]/;

/**
 * "animals, food, weather" typed as a rank prompt looks like a list of groups: the groups it
 * would become (first letters upper-cased), or null when it doesn't look like one.
 */
export function listHint(prompt: string): string[] | null {
  if (!LIST_SEPARATORS.test(prompt)) return null;
  const parts = prompt.split(LIST_SEPARATORS).map(cleanSortText).filter(Boolean);
  if (parts.length < SORT_GROUPS_MIN || parts.length > SORT_GROUPS_MAX) return null;
  if (parts.some((p) => p.length > SORT_GROUP_MAX_CHARS)) return null;
  return parts.map((p) => p.charAt(0).toUpperCase() + p.slice(1));
}

/**
 * Problems shown while typing. The others ("empty", too few groups) only show once the player
 * tries to apply: a fresh, empty form shouldn't open with an error.
 */
export const isLiveProblem = (p: SortSpecProblem): boolean => p === "duplicate_group" || p === "other_group";

/** The validation line for a problem, or null for ones the inputs make impossible (maxLength, 8 rows). */
export function problemCopy(p: SortSpecProblem, kind: SortSpec["kind"]): string | null {
  switch (p) {
    case "empty":
      return kind === "rank" ? "Describe an order first." : "Add at least two groups.";
    case "few_groups":
      return "Add at least two groups.";
    case "duplicate_group":
      return "That group is already on the list.";
    case "other_group":
      return "Other is added for you.";
    default:
      return null;
  }
}

/**
 * The group row an apply attempt with this problem should focus: the "Other" row, the repeated
 * row, the over-long row, or else the first blank row (what "Add at least two groups." asks to
 * fill). Rows are the raw field texts, blank ones included.
 */
export function problemRow(rows: readonly string[], p: SortSpecProblem): number {
  const texts = rows.map((r) => cleanSortText(r).toLowerCase());
  let i = -1;
  if (p === "other_group") i = texts.indexOf("other");
  else if (p === "duplicate_group") i = texts.findIndex((t, j) => !!t && texts.indexOf(t) < j);
  else if (p === "too_long") i = rows.findIndex((r) => cleanSortText(r).length > SORT_GROUP_MAX_CHARS);
  else i = texts.indexOf("");
  return Math.max(0, i);
}

/**
 * The primary button: exactly what tapping it will do. `owned` is null while the library is
 * still loading (no count to promise yet).
 */
export function applyLabel(kind: SortSpec["kind"], owned: number | null, done: boolean): string {
  if (done) return "Done";
  const verb = kind === "rank" ? "Sort" : "Group";
  return owned === null ? verb : `${verb} ${formatCount(owned)} element${owned === 1 ? "" : "s"}`;
}
