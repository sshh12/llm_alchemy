// "How to play" demo: a ghost hand drags Water onto Fire and Steam pops out.
// Reduced motion shows the same idea as a static equation.
import type { ElementDTO } from "../../shared/api.ts";
import { useReducedMotion } from "../lib/hooks.ts";
import { HandIcon } from "./Icons.tsx";
import { Tile } from "./Tile.tsx";

const demoEl = (id: string, name: string, emoji: string): ElementDTO => ({
  id,
  name,
  emoji,
  img: null,
  art: "blocked",
  description: null,
  notable: false,
  depth: 0,
  rarity: "common",
  starter: true,
});

const WATER = demoEl("demo-water", "Water", "💧");
const FIRE = demoEl("demo-fire", "Fire", "🔥");
const STEAM = demoEl("demo-steam", "Steam", "♨️");
const SIZE = 64;

export function GhostDemo({ className = "" }: { className?: string }) {
  const reduced = useReducedMotion();
  if (reduced) {
    return (
      <div className={`demo flex items-center justify-center gap-3 ${className}`} aria-hidden="true">
        <Tile element={WATER} size={SIZE} requestArt={false} />
        <span className="text-xl font-semibold text-ink-muted">+</span>
        <Tile element={FIRE} size={SIZE} requestArt={false} />
        <span className="text-xl font-semibold text-ink-muted">=</span>
        <Tile element={STEAM} size={SIZE} requestArt={false} />
      </div>
    );
  }
  return (
    <div className={`demo ${className}`} aria-hidden="true">
      <div className="d-fire">
        <Tile element={FIRE} size={SIZE} requestArt={false} />
      </div>
      <div className="d-steam">
        <Tile element={STEAM} size={SIZE} requestArt={false} />
      </div>
      <div className="d-water">
        <Tile element={WATER} size={SIZE} requestArt={false} />
      </div>
      <HandIcon className="d-hand" />
    </div>
  );
}
