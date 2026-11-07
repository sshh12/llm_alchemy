// Quick actions / details for an element (long-press, right-click, context-menu key, or a
// tapped toast/feed item): description, rarity, how you made it, Add / Pin / Share /
// Put away. Anchored next to the tile (Radix Popover with a virtual anchor).
import { Popover } from "radix-ui";
import { useMemo, useState } from "react";
import { RARITY_LABEL } from "../../../shared/rarity.ts";
import { formatDay } from "../../lib/format.ts";
import { recipeCache } from "../../lib/recipes.ts";
import { shareElement } from "../../lib/share.ts";
import { useGame } from "../../state/game.ts";
import { openDetails, showToast, togglePin, useUi } from "../../state/ui.ts";
import { CloseIcon, PinIcon, PlusIcon, ShareIcon } from "../../components/Icons.tsx";
import { Tile } from "../../components/Tile.tsx";
import { clearSelection, recipeLabel, removeTile, spawnElement } from "../workbench/actions.ts";

export default function QuickActions() {
  const details = useUi((s) => s.details);
  const el = useGame((s) => (details ? s.elements[details.elementId] : undefined));
  const owned = useGame((s) => (details ? s.owned[details.elementId] : undefined));
  const pinned = useUi((s) => (details ? s.pins.has(details.elementId) : false));
  const [sharing, setSharing] = useState(false);
  const recipes = useMemo(() => (details ? recipeCache.recipesFor(details.elementId, 2) : []), [details]);

  const anchor = details?.anchor;
  const virtualRef = useMemo(
    () => ({
      current: {
        getBoundingClientRect: () =>
          anchor
            ? new DOMRect(anchor.x, anchor.y, anchor.w, anchor.h)
            : new DOMRect(window.innerWidth / 2, window.innerHeight / 3, 0, 0),
      },
    }),
    [anchor],
  );

  if (!details || !el) return null;
  const close = () => openDetails(null);
  const isCanvas = details.source === "canvas";

  return (
    <Popover.Root open onOpenChange={(o) => !o && close()}>
      <Popover.Anchor virtualRef={virtualRef} />
      <Popover.Portal>
        <Popover.Content
          className="popover"
          side={anchor ? "top" : "bottom"}
          align="center"
          sideOffset={10}
          collisionPadding={12}
          aria-label={`${el.name} details`}
          data-testid="quick-actions"
        >
          <div className="relative flex gap-3 p-4 pb-3 pr-11">
            <Tile element={el} size={64} first={owned?.first} />
            <div className="min-w-0 flex-1 self-center">
              <p className="font-display text-[19px] font-semibold leading-tight">{el.name}</p>
              <p className="mt-0.5 text-[12.5px] font-semibold text-ink-muted">
                {RARITY_LABEL[el.rarity]}
                {el.depth != null && ` · depth ${el.depth}`}
                {el.notable && " · ✦ notable"}
              </p>
              {owned?.first && (
                <p className="mt-1 text-[12.5px] font-semibold leading-snug text-gold">
                  First discovered by you
                  <span className="block font-medium opacity-80">{formatDay(owned.discoveredAt)}</span>
                </p>
              )}
            </div>
            <Popover.Close className="icon-btn absolute right-1.5 top-1.5" aria-label="Close">
              <CloseIcon size={18} />
            </Popover.Close>
          </div>
          {(el.description || recipes.length > 0) && (
            <div className="px-4 pb-3 text-[13.5px] text-ink-muted">
              {el.description && <p>{el.description}</p>}
              {recipes.length > 0 && (
                <p className="mt-1">
                  Made from <span className="font-semibold text-ink">{recipes.map((r) => recipeLabel(r)).join(" or ")}</span>
                </p>
              )}
            </div>
          )}
          {!owned && details.source === "feed" && (
            <p className="px-4 pb-3 text-[13.5px] text-ink-muted">Discovered recently by another alchemist. Can you make it too?</p>
          )}
          {owned && (
            <button
              type="button"
              className="menu-item"
              onClick={() => {
                close();
                clearSelection(); // add a plain copy, don't combine with a selection
                spawnElement(el.id);
              }}
            >
              <PlusIcon size={19} /> {isCanvas ? "Duplicate" : "Add to workbench"}
            </button>
          )}
          {owned && (
            <button
              type="button"
              className="menu-item"
              data-testid="quick-action-pin"
              onClick={() => {
                const now = togglePin(el.id);
                showToast({ kind: "info", text: now ? `Pinned ${el.name} to the front of your library.` : `Unpinned ${el.name}.`, duration: 2_500 });
                close();
              }}
            >
              <PinIcon size={19} /> {pinned ? "Unpin" : "Pin to front"}
            </button>
          )}
          <button
            type="button"
            className="menu-item"
            disabled={sharing}
            onClick={async () => {
              setSharing(true);
              const outcome = await shareElement({ element: el, recipe: recipes[0] ? recipeLabel(recipes[0]) : undefined, first: owned?.first, at: owned?.discoveredAt });
              setSharing(false);
              if (outcome === "downloaded") showToast({ kind: "info", text: "Card saved, and the link is copied.", duration: 3_500 });
              close();
            }}
          >
            <ShareIcon size={19} /> {sharing ? "Preparing…" : "Share"}
          </button>
          {isCanvas && details.uid && (
            <button
              type="button"
              className="menu-item text-danger"
              onClick={() => {
                close();
                removeTile(details.uid!);
              }}
            >
              <CloseIcon size={19} /> Remove from workbench
            </button>
          )}
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}
