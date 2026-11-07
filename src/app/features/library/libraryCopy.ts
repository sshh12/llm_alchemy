// Library copy that depends on state: the empty states (LibraryEmpty) and the custom sort bar's
// weak-match line. Kept out of the .tsx so it unit-tests in node.
import type { LibraryFilter } from "../../state/ui.ts";

/**
 * The bar's line when nothing reaches Matches. A union "and" ("fire and ice") is the one prompt
 * shape that reliably gets no Matches (it's read as both at once), while "fire or ice" works, so
 * suggest that instead of a quality. Only shown when nothing matches, so a working "and" prompt
 * ("small and spooky") never sees it.
 */
export function weakMatchText(label: string): string {
  return /\band\b/i.test(label)
    ? `Nothing clearly matches “${label}”. Want either one? Try “${label.replace(/\band\b/i, "or")}”.`
    : `Nothing clearly matches “${label}”. Try a quality, like “cutest”.`;
}

/** A custom-sort bucket that emptied a list which has elements (counts are taken before it). */
export type EmptyBucket = { kind: "matches"; label: string } | { kind: "group"; name: string } | null;

/** data-state on the empty state (e2e contract). */
export type EmptyState = "matches" | "group" | "search" | "pinned" | "new" | "firsts" | "empty";

export interface EmptyCopy {
  state: EmptyState;
  title: string;
  body: string | null;
}

/**
 * `compact`: the phone shelf's peek row. The Matches and group chips live in the custom sort bar,
 * which peek doesn't show, so there the way back is opening the library.
 */
export function libraryEmptyCopy(o: { bucket: EmptyBucket; compact: boolean; query: string; filter: LibraryFilter }): EmptyCopy {
  const { bucket, compact, query, filter } = o;
  const peek = "Open the library to see everything.";
  if (bucket?.kind === "matches") {
    return { state: "matches", title: `Nothing clearly matches “${bucket.label}”.`, body: compact ? peek : "Tap Matches again to see everything." };
  }
  if (bucket?.kind === "group") {
    return { state: "group", title: `Nothing in “${bucket.name}” yet.`, body: compact ? peek : "Tap All to see everything in order." };
  }
  if (query) return { state: "search", title: `No “${query}” yet.`, body: "Maybe you'll be the one to make it." };
  if (filter === "pinned") return { state: "pinned", title: "Nothing pinned yet.", body: "Press and hold an element (or right-click) to pin it here." };
  if (filter === "new") return { state: "new", title: "Nothing new in the last day.", body: "Go mix something!" };
  if (filter === "firsts") {
    return { state: "firsts", title: "No world firsts yet.", body: "Be the first anyone has made something, and it lands here with a gold seal." };
  }
  return { state: "empty", title: "Your library is empty.", body: null };
}
