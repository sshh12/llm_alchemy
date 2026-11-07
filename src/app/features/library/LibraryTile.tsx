// A library element: press to drag out, tap to spawn, hold (or right-click) for actions.
import { memo, type CSSProperties } from "react";
import type { ElementId } from "../../../shared/api.ts";
import { groupOf, levelLabel } from "../../lib/librarySort.ts";
import { useCustomSort } from "../../state/customSort.ts";
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
  // Custom sort: primitives only, so a commit re-renders just the tiles whose value changed.
  const on = useUi((s) => s.sort === "custom");
  const pend = useCustomSort((s) => on && s.pending.has(id));
  const score = useCustomSort((s) => (on ? s.committed?.scores.get(id) : undefined));
  const grp = useCustomSort((s) => (on && s.committed?.groups ? groupOf(s.committed, id, s.view.other) : undefined));
  const kind = useCustomSort((s) => (on ? s.committed?.kind : undefined));
  // The words the aria suffix needs: the rank prompt, or this tile's group name.
  const words = useCustomSort((s) => {
    const sp = on ? s.committed?.spec : undefined;
    if (!sp) return undefined;
    if (sp.kind === "rank") return sp.prompt;
    return grp !== undefined && grp >= 0 ? sp.groups[grp] : undefined;
  });
  if (!el) return null;

  let cs: "pending" | "rank" | "group" | "other" | undefined;
  let suffix = "";
  if (on) {
    if (pend) {
      cs = "pending";
      suffix = ", weighing";
    } else if (kind === "rank" && score !== undefined) {
      cs = "rank";
      suffix = `, ${levelLabel(score).toLowerCase()} for “${words ?? ""}”`;
    } else if (kind === "groups" && grp !== undefined) {
      cs = grp === -1 ? "other" : "group";
      suffix = grp === -1 ? ", Other" : `, ${words ?? ""}`;
    }
  }
  // --s (0..1) fills the rank meter under the tile (app.css .lt[data-cs]::after).
  const meter = cs && cs !== "pending" && score !== undefined;
  const style = { width: size, height: size, ...(meter ? { "--s": score / 1000 } : {}) } as CSSProperties;

  return (
    <div
      className="lt"
      data-testid="library-tile"
      data-element-id={id}
      data-name={el.name}
      data-pinned={pinned ? "true" : "false"}
      data-fresh={isFresh(id) ? "" : undefined}
      data-cs={cs}
      data-score={cs === "pending" ? "pending" : cs ? score : undefined}
      data-group={cs === "group" ? grp : cs === "other" ? "other" : undefined}
      role="gridcell"
      tabIndex={tabbable ? 0 : -1}
      data-index={index}
      aria-label={`${tileLabel(el, first)}${pinned ? ", pinned" : ""}${suffix}`}
      style={style}
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
