// One tile on the workbench. Its position/scale/opacity are driven by a TilePose (spring
// engine + direct DOM writes); React renders only content and state attributes.
import { memo, useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { FALLBACK_EMOJI } from "../../lib/placeholder.ts";
import { SPRING } from "../../lib/spring.ts";
import { removeTiles, setFocus, type Tile as TileState } from "../../state/canvas.ts";
import { useGame } from "../../state/game.ts";
import { openDetails } from "../../state/ui.ts";
import { Tile, tileLabel } from "../../components/Tile.tsx";
import { consumeFocusOnMount } from "./actions.ts";
import { pressCanvasTile } from "./drag.ts";
import { held, nextMove, poses, TilePose } from "./poses.ts";

interface Props {
  tile: TileState;
  T: number;
  selected: boolean;
  tabbable: boolean;
}

// Short enough to fit a phone tile in the condensed cut.
const PENDING_LABELS = ["Mixing…", "Transmuting…", "Kiln firing…", "Almost there…"];

function PendingTile({ ids, T }: { ids: string[]; T: number }) {
  const emojis = useMemo(() => {
    const els = useGame.getState().elements;
    return ids.map((id) => els[id]?.emoji || FALLBACK_EMOJI);
  }, [ids]);
  const [step, setStep] = useState(0);
  useEffect(() => {
    const t = setInterval(() => setStep((n) => Math.min(n + 1, PENDING_LABELS.length - 1)), 1_200);
    return () => clearInterval(t);
  }, []);
  const box = Math.round(T * 0.56);
  return (
    <div className="tile" style={{ "--t": `${T}px` } as CSSProperties} data-pending="">
      <span className="crucible" />
      <span className="sheen" />
      <span className="art" style={{ "--box": `${box}px` } as CSSProperties}>
        <span className="pending-glow" />
        <span className="orbit">
          {emojis.map((e, i) => (
            <span key={i} style={{ "--a": `${(360 / emojis.length) * i}deg` } as CSSProperties}>
              {e}
            </span>
          ))}
        </span>
      </span>
      <span key={step} className="tile-label pending-label">
        {PENDING_LABELS[step]}
      </span>
    </div>
  );
}

/** Short-lived celebration layers (sparks, cooling glow, foil sweep). */
function Fx({ kind }: { kind: "pop" | "new" | "first" }) {
  const sparks = useMemo(() => {
    const n = kind === "first" ? 14 : kind === "new" ? 9 : 0;
    return Array.from({ length: n }, (_, i) => {
      const a = (i / n) * Math.PI * 2 + Math.random() * 0.5;
      const r = 46 + Math.random() * 34;
      return {
        "--x": `${Math.cos(a) * r}px`,
        "--y": `${Math.sin(a) * r}px`,
        "--d": `${Math.round(Math.random() * 90)}ms`,
        "--rot": `${Math.round(Math.random() * 360)}deg`,
      } as CSSProperties;
    });
  }, [kind]);
  return (
    <>
      <span className="cool" />
      {kind === "first" && <span className="foil-sweep" />}
      {sparks.length > 0 && (
        <span className="sparks" data-gold={kind === "first" ? "" : undefined}>
          {sparks.map((style, i) => (
            <i key={i} style={style} />
          ))}
        </span>
      )}
    </>
  );
}

export const CanvasTile = memo(function CanvasTile({ tile, T, selected, tabbable }: Props) {
  const { uid } = tile;
  const element = useGame((s) => (tile.elementId ? s.elements[tile.elementId] : undefined));
  const first = useGame((s) => (tile.elementId ? !!s.owned[tile.elementId]?.first : false));
  const ref = useRef<HTMLDivElement>(null);
  const mounted = useRef(false);
  const [fx, setFx] = useState<{ kind: "pop" | "new" | "first"; key: number } | null>(null);

  // Mount: create the pose at the entry point and animate to rest.
  useLayoutEffect(() => {
    const from = tile.enterFrom ?? { x: tile.x, y: tile.y };
    const pose = new TilePose(from, T);
    poses.set(uid, pose);
    if (tile.pending) pose.s.set(0.6);
    if (tile.fx === "spawn" || tile.fx === "restore") {
      pose.s.set(0.7);
      pose.o.set(0);
    }
    if (tile.fx === "drop") pose.s.set(1.08);
    pose.attach(ref.current);
    if (!tile.leaving) pose.moveTo(tile, tile.fx === "spawn" ? SPRING.pop : SPRING.settle);
    pose.s.to(1, tile.pending ? SPRING.pop : SPRING.settle);
    pose.o.to(1, SPRING.absorb);
    if (consumeFocusOnMount(uid)) ref.current?.focus({ preventScroll: true });
    return () => {
      pose.stopAll();
      pose.attach(null);
      if (poses.get(uid) === pose) poses.delete(uid);
    };
    // Mount-only: later changes are handled by the effects below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Rest position changed (place, relax, tidy, rescale, undo): spring there.
  useEffect(() => {
    if (!mounted.current) return;
    const pose = poses.get(uid);
    if (!pose || held.has(uid) || tile.leaving) return;
    const opts = nextMove.get(uid) ?? SPRING.settle;
    nextMove.delete(uid);
    if (pose.x.target !== tile.x || pose.y.target !== tile.y) pose.moveTo(tile, opts);
    pose.s.to(1, SPRING.settle);
    pose.o.to(1, SPRING.settle);
  }, [uid, tile.x, tile.y, tile.leaving]);

  useEffect(() => {
    const pose = poses.get(uid);
    if (!pose || pose.T === T) return;
    pose.T = T;
    pose.write();
  }, [uid, T]);

  // Absorbed into a merge / faded out: animate, then remove from the store.
  useEffect(() => {
    const to = tile.leaving;
    const pose = poses.get(uid);
    if (!to || !pose) return;
    // A long flight (library → selected tile) stays visible and only melts on arrival.
    const far = Math.hypot(pose.x.value - to.x, pose.y.value - to.y) > T * 2;
    const melt = { ...SPRING.absorb, delay: far ? 200 : 0 };
    if (far) pose.o.set(1);
    pose.moveTo(to, far ? SPRING.settle : SPRING.absorb);
    pose.s.to(0.7, melt);
    pose.o.to(0, melt, () => removeTiles([uid]));
  }, [uid, tile.leaving, T]);

  // Result arrived (pending → element): pop + celebration layers.
  useEffect(() => {
    if (!mounted.current) return;
    if (tile.fx !== "pop" && tile.fx !== "new" && tile.fx !== "first") return;
    const pose = poses.get(uid);
    pose?.s.set(0.6);
    pose?.s.to(1, SPRING.pop);
    setFx({ kind: tile.fx, key: tile.fxKey ?? 0 });
    const t = setTimeout(() => setFx(null), 1_400);
    return () => clearTimeout(t);
  }, [uid, tile.fx, tile.fxKey]);

  useEffect(() => {
    mounted.current = true;
  }, []);

  return (
    <div
      ref={ref}
      className="ct"
      data-uid={uid}
      data-testid={tile.leaving ? "canvas-tile-leaving" : "canvas-tile"}
      data-element-id={tile.elementId ?? undefined}
      data-name={element?.name}
      data-selected={selected ? "true" : "false"}
      data-leaving={tile.leaving ? "" : undefined}
      data-pending={tile.pending ? "true" : undefined}
      style={{ zIndex: tile.z, width: T, height: T }}
      role="button"
      tabIndex={tabbable && !tile.pending && !tile.leaving ? 0 : -1}
      aria-label={element ? tileLabel(element, first) : "Combining…"}
      aria-pressed={selected}
      onPointerDown={(e) => pressCanvasTile(e, uid)}
      onContextMenu={(e) => {
        e.preventDefault();
        if (!tile.elementId) return;
        const r = e.currentTarget.getBoundingClientRect();
        openDetails({ elementId: tile.elementId, source: "canvas", uid, anchor: { x: r.left, y: r.top, w: r.width, h: r.height } });
      }}
      onFocus={() => setFocus(uid)}
    >
      {tile.pending ? (
        <PendingTile ids={tile.pending.ingredients} T={T} />
      ) : element ? (
        <Tile element={element} size={T} first={first}>
          {fx && <Fx key={fx.key} kind={fx.kind} />}
        </Tile>
      ) : null}
      <span className="stack-badge" aria-hidden="true" />
    </div>
  );
});
