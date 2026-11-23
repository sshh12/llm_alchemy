// First-run coach (experiment firstRun, treatment; firstRun.ts): a pill under the seeded demo
// pair that names the real gesture for this device, while both tiles pulse. It follows the
// tiles, asks for the second one once the first is selected, and goes at the first combine.
import { useState } from "react";
import { CloseIcon, HandIcon } from "../../components/Icons.tsx";
import { clamp } from "../../lib/geometry.ts";
import { useCanvas } from "../../state/canvas.ts";
import { useGame } from "../../state/game.ts";
import { useUi } from "../../state/ui.ts";
import { coachMode, coachText, dismissCoach } from "./firstRun.ts";

/** Room the pill keeps from the canvas edges (px; about half its width). */
const HALF_W = 112;

export function Coach() {
  const coach = useUi((s) => s.coach);
  const a = useCanvas((s) => (coach ? s.tiles.find((t) => t.uid === coach.a) : undefined));
  const b = useCanvas((s) => (coach ? s.tiles.find((t) => t.uid === coach.b) : undefined));
  const bounds = useCanvas((s) => s.bounds);
  const T = useCanvas((s) => s.T);
  const sel = useCanvas((s) => (s.selection.length === 1 && !s.multi ? s.selection[0] : null));
  const nameA = useGame((s) => (a?.elementId ? s.elements[a.elementId]?.name : undefined));
  const nameB = useGame((s) => (b?.elementId ? s.elements[b.elementId]?.name : undefined));
  const [mode] = useState(coachMode);
  // Hidden while either tile is mid-merge (it comes back if that merge fails).
  if (!coach || !a || !b || a.leaving || b.leaving || a.pending || b.pending || !bounds || !nameA || !nameB) return null;
  const selected = sel === coach.a ? "a" : sel === coach.b ? "b" : null;
  const x = clamp((a.x + b.x) / 2, Math.min(HALF_W, bounds.w / 2), Math.max(bounds.w - HALF_W, bounds.w / 2));
  const below = Math.max(a.y, b.y) + T / 2 + 14;
  // Not enough room under the pair (short canvas): sit above it instead.
  const above = below + 52 > bounds.h - bounds.bottom;
  const y = above ? Math.min(a.y, b.y) - T / 2 - 14 : below;
  return (
    <div
      className="coach"
      data-testid="coach"
      data-mode={mode}
      data-place={above ? "above" : "below"}
      role="status"
      style={{ left: x, top: y }}
    >
      {/* (HandIcon is the demo's illustration: it takes width/height, not size.) */}
      <HandIcon width={20} height={20} className="flex-none" />
      <span className="min-w-0 truncate">{coachText(mode, nameA, nameB, selected)}</span>
      <button type="button" className="coach-close" aria-label="Dismiss tip" data-testid="coach-dismiss" onClick={() => dismissCoach("close")}>
        <CloseIcon size={16} />
      </button>
    </div>
  );
}
