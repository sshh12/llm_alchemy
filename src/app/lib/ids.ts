// Element ids are INT8 values serialized as canonical decimal strings (no leading zeros),
// which exceed Number.MAX_SAFE_INTEGER. Compare them numerically without BigInt:
// a shorter canonical string is always the smaller number.
import type { ElementId } from "../../shared/api.ts";

export function compareIds(a: ElementId, b: ElementId): number {
  if (a.length !== b.length) return a.length - b.length;
  return a < b ? -1 : a > b ? 1 : 0;
}

/** The ingredient multiset sorted ascending numerically (duplicates kept), as the server keys recipes. */
export function sortIds(ids: readonly ElementId[]): ElementId[] {
  return [...ids].sort(compareIds);
}

/** Stable cache key for a recipe, independent of ingredient order. */
export function recipeKey(ids: readonly ElementId[]): string {
  return sortIds(ids).join(",");
}

export function isCanonicalId(v: unknown): v is ElementId {
  return typeof v === "string" && /^(0|[1-9]\d{0,19})$/.test(v);
}
