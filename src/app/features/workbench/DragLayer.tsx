// Top-level portal for tiles dragged out of the library (canvas tiles move in place).
import { createPortal } from "react-dom";
import { useCanvas } from "../../state/canvas.ts";
import { useGame } from "../../state/game.ts";
import { Tile } from "../../components/Tile.tsx";
import { useDrag } from "./drag.ts";

export function DragLayer() {
  const ghost = useDrag((s) => s.ghost);
  const element = useGame((s) => (ghost ? s.elements[ghost.elementId] : undefined));
  const first = useGame((s) => (ghost ? !!s.owned[ghost.elementId]?.first : false));
  const T = useCanvas((s) => s.T);
  if (!ghost || !element) return null;
  return createPortal(
    <div style={{ position: "fixed", inset: 0, zIndex: 75, pointerEvents: "none" }} aria-hidden="true">
      <div className="ct" data-dragging="" ref={(n) => ghost.pose.attach(n)} style={{ width: T, height: T }}>
        <Tile element={element} size={T} first={first} requestArt={false} />
        <span className="stack-badge" />
      </div>
    </div>,
    document.body,
  );
}
