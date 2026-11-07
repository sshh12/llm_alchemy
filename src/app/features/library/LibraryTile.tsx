// A library element: press to drag out, tap to spawn, hold (or right-click) for actions.
import { memo } from "react";
import type { ElementId } from "../../../shared/api.ts";
import { isFresh, useGame } from "../../state/game.ts";
import { openDetails, useUi } from "../../state/ui.ts";
import { PinIcon } from "../../components/Icons.tsx";
import { Tile, tileLabel } from "../../components/Tile.tsx";
import { pressLibraryTile, type PressMode } from "../workbench/drag.ts";

interface Props {
  id: ElementId;
  size: number;
  mode: PressMode;
  index: number;
  tabbable: boolean;
}

export const LibraryTile = memo(function LibraryTile({ id, size, mode, index, tabbable }: Props) {
  const el = useGame((s) => s.elements[id]);
  const first = useGame((s) => !!s.owned[id]?.first);
  const pinned = useUi((s) => s.pins.has(id));
  if (!el) return null;
  return (
    <div
      className="lt"
      data-testid="library-tile"
      data-element-id={id}
      data-name={el.name}
      data-pinned={pinned ? "true" : "false"}
      data-fresh={isFresh(id) ? "" : undefined}
      role="gridcell"
      tabIndex={tabbable ? 0 : -1}
      data-index={index}
      aria-label={`${tileLabel(el, first)}${pinned ? ", pinned" : ""}`}
      style={{ width: size, height: size }}
      onPointerDown={(e) => pressLibraryTile(e, id, mode)}
      onContextMenu={(e) => {
        e.preventDefault();
        const r = e.currentTarget.getBoundingClientRect();
        openDetails({ elementId: id, source: "library", anchor: { x: r.left, y: r.top, w: r.width, h: r.height } });
      }}
    >
      <Tile element={el} size={size} first={first}>
        {pinned && (
          <span className="pin-badge" aria-hidden="true">
            <PinIcon size={10} strokeWidth={2.4} />
          </span>
        )}
      </Tile>
    </div>
  );
});
