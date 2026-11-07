// Client-side recipe cache: sorted ingredient ids -> result id. Recipes are permanent
// server-side once active, so a cached answer never goes stale. Re-combining a known
// recipe whose result the player already owns can then skip the network entirely.
import type { ElementId } from "../../shared/api.ts";
import { recipeKey } from "./ids.ts";
import { KEYS, readJSON, writeJSON } from "./storage.ts";

const MAX_ENTRIES = 5_000;

class RecipeCache {
  private map: Map<string, ElementId> | null = null;
  private saveTimer: ReturnType<typeof setTimeout> | undefined;

  private load(): Map<string, ElementId> {
    if (!this.map) {
      const raw = readJSON<unknown>(KEYS.recipes, null);
      this.map = new Map(
        Array.isArray(raw)
          ? raw.filter((e): e is [string, string] => Array.isArray(e) && typeof e[0] === "string" && typeof e[1] === "string")
          : [],
      );
    }
    return this.map;
  }

  get(ids: readonly ElementId[]): ElementId | undefined {
    return this.load().get(recipeKey(ids));
  }

  set(ids: readonly ElementId[], result: ElementId): void {
    const map = this.load();
    const key = recipeKey(ids);
    map.delete(key); // re-insert so insertion order approximates recency
    map.set(key, result);
    while (map.size > MAX_ENTRIES) map.delete(map.keys().next().value!);
    clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => writeJSON(KEYS.recipes, [...map]), 500);
  }

  /** Ingredient lists (as ids) this browser has seen produce `result`. */
  recipesFor(result: ElementId, limit = 3): ElementId[][] {
    const out: ElementId[][] = [];
    for (const [key, r] of this.load()) {
      if (r === result) out.push(key.split(","));
      if (out.length >= limit) break;
    }
    return out;
  }
}

export const recipeCache = new RecipeCache();
