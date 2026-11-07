// The ceramic element tile used everywhere (canvas, library, drag ghost, sheets).
import { memo, type CSSProperties, type ReactNode } from "react";
import type { ElementDTO } from "../../shared/api.ts";
import { RARITY_LABEL } from "../../shared/rarity.ts";
import { labelLength } from "../lib/format.ts";
import { ElementArt } from "./ElementArt.tsx";

interface TileProps {
  element: ElementDTO;
  /** Tile edge in px. */
  size: number;
  first?: boolean;
  /** Request art generation when visible. */
  requestArt?: boolean;
  /** Art only (no label), for showcase cards where the name is set large below. */
  bare?: boolean;
  children?: ReactNode;
}

/** Accessible description: "Steam, rare" (+ "first discovery"). */
export function tileLabel(el: ElementDTO, first?: boolean): string {
  const parts = [el.name];
  if (el.rarity !== "common") parts.push(RARITY_LABEL[el.rarity].toLowerCase());
  if (first) parts.push("your first discovery");
  return parts.join(", ");
}

export const Tile = memo(function Tile({ element, size, first, requestArt = true, bare, children }: TileProps) {
  const len = labelLength(element.name);
  const box = Math.round(size * (bare ? 0.7 : len === "l" ? 0.47 : 0.56));
  return (
    <div
      className="tile"
      style={{ "--t": `${size}px` } as CSSProperties}
      data-len={len}
      data-first={first ? "" : undefined}
      data-notable={element.notable ? "" : undefined}
      data-bare={bare ? "" : undefined}
    >
      <ElementArt element={element} box={box} request={requestArt} />
      {!bare && (
        <span className="tile-label" data-len={len}>
          {element.name}
        </span>
      )}
      {element.rarity !== "common" && <span className="gem" data-r={element.rarity} />}
      {first && (
        <span className="seal" title="First discovered by you">
          <svg width="9" height="9" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
            <path d="M12 2.5c.5 4.6 2.4 7 7 7.5-4.6.5-6.5 2.9-7 7.5-.5-4.6-2.4-7-7-7.5 4.6-.5 6.5-2.9 7-7.5Z" />
          </svg>
        </span>
      )}
      {children}
    </div>
  );
});

/** Static skeleton tile while the library loads. */
export function SkeletonTile({ size }: { size: number }) {
  return <div className="tile shimmer" style={{ "--t": `${size}px`, borderColor: "transparent" } as CSSProperties} />;
}
