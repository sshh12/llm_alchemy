// The five starters, in shelf order. One source of truth for every place that shows or names
// them: the library sort (starters tie on time and rarity, so this order breaks the tie), the
// onboarding demo and copy, and the static pages.
//
// The first two are the onboarding pair: the "How to play" demo combines them into DEMO_RESULT,
// so a new player sees exactly those two first on the shelf, at the left edge, where narrow
// phones never cut them off.
export const STARTER_ORDER = ["Water", "Fire", "Earth", "Air", "Time"] as const;

export type StarterName = (typeof STARTER_ORDER)[number];

/** The onboarding demo recipe: the first two starters and what they make. */
export const DEMO_RECIPE = { a: STARTER_ORDER[0], b: STARTER_ORDER[1], result: "Steam" } as const;

const RANK = new Map<string, number>(STARTER_ORDER.map((name, i) => [name.toLowerCase(), i]));

/** Shelf position of a starter by name (case-insensitive); unknown names sort after all starters. */
export function starterRank(name: string): number {
  return RANK.get(name.toLowerCase()) ?? STARTER_ORDER.length;
}
