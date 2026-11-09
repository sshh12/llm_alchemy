// "How to play" demo: a ghost hand drags the first starter onto the second (DEMO_RECIPE:
// Water onto Fire) and Steam pops out. Reduced motion shows the same idea as a static equation.
import type { ElementDTO } from "../../shared/api.ts";
import { DEMO_RECIPE } from "../../shared/starters.ts";
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

const EMOJI: Record<string, string> = { Water: "💧", Fire: "🔥", Earth: "🪨", Air: "💨", Time: "⏳", Steam: "♨️" };
const demo = (name: string) => demoEl(`demo-${name.toLowerCase()}`, name, EMOJI[name] ?? "✨");
// Named for the current pair; DEMO_RECIPE decides which elements they are.
const WATER = demo(DEMO_RECIPE.a);
const FIRE = demo(DEMO_RECIPE.b);
const STEAM = demo(DEMO_RECIPE.result);
const SIZE = 64;
/** The static equation puts three tiles in a row, so it must fit narrow phone layouts. */
const STATIC_SIZE = 56;

export function GhostDemo({ className = "" }: { className?: string }) {
  const reduced = useReducedMotion();
  if (reduced) {
    return (
      <div className={`demo flex items-center justify-center gap-2 ${className}`} aria-hidden="true">
        <Tile element={WATER} size={STATIC_SIZE} requestArt={false} />
        <span className="text-xl font-semibold text-ink-muted">+</span>
        <Tile element={FIRE} size={STATIC_SIZE} requestArt={false} />
        <span className="text-xl font-semibold text-ink-muted">=</span>
        <Tile element={STEAM} size={STATIC_SIZE} requestArt={false} />
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
