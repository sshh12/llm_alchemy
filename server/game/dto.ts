// DB row -> API DTO mapping (src/shared/api.ts).
import type { ElementDTO, LibraryEntry } from "../../src/shared/api.ts";
import { rarityForDepth } from "../../src/shared/rarity.ts";
import { imgPath } from "../blobs.ts";

/** Columns needed to build an ElementDTO; alias the elements table as `e`. */
export const ELEMENT_COLS =
  "e.id, e.name, e.emoji, e.description, e.notable, e.depth, e.steps, e.is_starter, e.status, e.image_status, e.image_key";

export interface ElementRow {
  id: string;
  name: string;
  emoji: string | null;
  description: string | null;
  notable: boolean;
  depth: number | null;
  steps: number | null;
  is_starter: boolean;
  status: string;
  image_status: string;
  image_key: string | null;
}

export interface LibraryRow extends ElementRow {
  discovered_at: Date;
  discovered_by: string | null;
}

/** ready -> served; blocked -> placeholder forever; none/pending/failed -> client may ask /api/image. */
export function artState(row: Pick<ElementRow, "image_status" | "image_key">): ElementDTO["art"] {
  if (row.image_status === "ready" && row.image_key) return "ready";
  if (row.image_status === "blocked") return "blocked";
  return "missing";
}

export function toElementDTO(row: ElementRow): ElementDTO {
  const art = artState(row);
  return {
    id: row.id,
    name: row.name,
    emoji: row.emoji,
    img: art === "ready" ? imgPath(row.id, row.image_key!) : null,
    art,
    description: row.description,
    notable: row.notable,
    depth: row.depth,
    rarity: rarityForDepth(row.depth),
    starter: row.is_starter,
  };
}

export function toLibraryEntry(row: LibraryRow, playerId: string): LibraryEntry {
  return {
    ...toElementDTO(row),
    discoveredAt: row.discovered_at.toISOString(),
    first: row.discovered_by === playerId,
  };
}

/** Recipe key: the ingredient multiset sorted ascending numerically (INT8 ids exceed 2^53). */
export function sortIds(ids: readonly string[]): string[] {
  return [...ids].sort((a, b) => {
    const x = BigInt(a);
    const y = BigInt(b);
    return x < y ? -1 : x > y ? 1 : 0;
  });
}

const INT8_MAX = 9_223_372_036_854_775_807n;

/** A positive INT8 in canonical decimal form (no sign, no leading zeros). */
export function isElementId(s: unknown): s is string {
  return typeof s === "string" && /^[1-9]\d{0,18}$/.test(s) && BigInt(s) <= INT8_MAX;
}
