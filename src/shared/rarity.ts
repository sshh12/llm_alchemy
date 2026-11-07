import type { Rarity } from "./api.ts";

// Rarity is earned: it comes from an element's depth (generations of combining
// needed from the starters). Thresholds are tuned from the real depth distribution
// (see scripts/backfill-legacy.ts output) and can change without a migration.
// Legacy world (46,312 reachable active elements): common 36.7%, uncommon 33.5%,
// rare 15.8%, epic 10.6%, legendary 3.4% (target ≈ 40/30/18/9/3).
export const RARITY_MIN_DEPTH: Record<Rarity, number> = {
  common: 0,
  uncommon: 6,
  rare: 8,
  epic: 10,
  legendary: 14,
};

export const RARITY_ORDER: Rarity[] = ["common", "uncommon", "rare", "epic", "legendary"];

export function rarityForDepth(depth: number | null | undefined): Rarity {
  if (depth == null) return "common";
  let r: Rarity = "common";
  for (const tier of RARITY_ORDER) if (depth >= RARITY_MIN_DEPTH[tier]) r = tier;
  return r;
}

export const RARITY_LABEL: Record<Rarity, string> = {
  common: "Common",
  uncommon: "Uncommon",
  rare: "Rare",
  epic: "Epic",
  legendary: "Legendary",
};
