// Derives the visible library list (filter, search, sort, pinned-first) from the store.
import { useMemo } from "react";
import type { ElementId } from "../../../shared/api.ts";
import { RARITY_ORDER } from "../../../shared/rarity.ts";
import { useGame } from "../../state/game.ts";
import { useUi } from "../../state/ui.ts";

const NEW_WINDOW_MS = 24 * 3_600_000;

export function useLibraryList(): ElementId[] {
  const owned = useGame((s) => s.owned);
  const pins = useUi((s) => s.pins);
  const filter = useUi((s) => s.filter);
  const sort = useUi((s) => s.sort);
  const query = useUi((s) => s.query);
  return useMemo(() => {
    // Names, rarity and dates never change for an element, so reading the catalog
    // non-reactively here is safe (art updates must not re-sort thousands of items).
    const els = useGame.getState().elements;
    const q = query.trim().toLowerCase();
    const cutoff = Date.now() - NEW_WINDOW_MS;
    const ids = Object.keys(owned).filter((id) => {
      const el = els[id];
      if (!el) return false;
      if (filter === "pinned" && !pins.has(id)) return false;
      if (filter === "firsts" && !owned[id]!.first) return false;
      if (filter === "new" && (el.starter || Date.parse(owned[id]!.discoveredAt) < cutoff)) return false;
      return !q || el.name.toLowerCase().includes(q);
    });
    const name = (id: ElementId) => els[id]!.name;
    const time = (id: ElementId) => Date.parse(owned[id]!.discoveredAt) || 0;
    const rank = (id: ElementId) => RARITY_ORDER.indexOf(els[id]!.rarity);
    const byName = (a: ElementId, b: ElementId) => name(a).localeCompare(name(b));
    const bySort =
      sort === "az"
        ? byName
        : sort === "rarity"
          ? (a: ElementId, b: ElementId) => rank(b) - rank(a) || byName(a, b)
          : (a: ElementId, b: ElementId) => time(b) - time(a) || byName(a, b);
    return ids.sort((a, b) => {
      if (q) {
        // Prefix matches first while searching.
        const pa = name(a).toLowerCase().startsWith(q) ? 0 : 1;
        const pb = name(b).toLowerCase().startsWith(q) ? 0 : 1;
        if (pa !== pb) return pa - pb;
      }
      if (filter !== "pinned") {
        const pa = pins.has(a) ? 0 : 1;
        const pb = pins.has(b) ? 0 : 1;
        if (pa !== pb) return pa - pb;
      }
      return bySort(a, b);
    });
  }, [owned, pins, filter, sort, query]);
}

export function useFilterCounts() {
  const owned = useGame((s) => s.owned);
  const pins = useUi((s) => s.pins);
  return useMemo(() => {
    const els = useGame.getState().elements;
    const cutoff = Date.now() - NEW_WINDOW_MS;
    let pinned = 0;
    let fresh = 0;
    let firsts = 0;
    for (const [id, o] of Object.entries(owned)) {
      if (pins.has(id)) pinned++;
      if (o.first) firsts++;
      if (!els[id]?.starter && Date.parse(o.discoveredAt) >= cutoff) fresh++;
    }
    return { all: Object.keys(owned).length, pinned, new: fresh, firsts };
  }, [owned, pins]);
}
