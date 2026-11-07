// Visual pose of each on-screen tile (position, scale, opacity, lift), animated by the
// spring engine and written straight to the DOM. React only renders tile content; the
// drag engine and settle animations move tiles through these poses at 60 fps.
import { SpringValue, type SpringOptions } from "../../lib/spring.ts";
import type { Pt } from "../../lib/geometry.ts";

export class TilePose {
  el: HTMLElement | null = null;
  readonly x: SpringValue;
  readonly y: SpringValue;
  readonly s: SpringValue;
  readonly o: SpringValue;
  /** 0..1: opacity of the deep "lifted" shadow layer (cheaper than animating box-shadow). */
  readonly lift: SpringValue;

  constructor(
    p: Pt,
    public T: number,
    /** Tile size multiplier for ghosts drawn at a different size. */
    scale = 1,
  ) {
    const w = this.write;
    this.x = new SpringValue(p.x, w);
    this.y = new SpringValue(p.y, w);
    this.s = new SpringValue(scale, w, 0.001);
    this.o = new SpringValue(1, w, 0.002);
    this.lift = new SpringValue(0, w, 0.002);
  }

  readonly write = (): void => {
    const el = this.el;
    if (!el) return;
    const h = this.T / 2;
    el.style.transform = `translate3d(${(this.x.value - h).toFixed(2)}px, ${(this.y.value - h).toFixed(2)}px, 0) scale(${this.s.value.toFixed(4)})`;
    el.style.opacity = this.o.value >= 0.999 ? "" : this.o.value.toFixed(3);
    el.style.setProperty("--lift", this.lift.value.toFixed(3));
  };

  attach(el: HTMLElement | null): void {
    this.el = el;
    if (el) this.write();
  }

  moveTo(p: Pt, opts: SpringOptions, onRest?: () => void): void {
    this.x.to(p.x, opts, onRest);
    this.y.to(p.y, opts);
  }

  jumpTo(p: Pt): void {
    this.x.set(p.x);
    this.y.set(p.y);
  }

  get point(): Pt {
    return { x: this.x.value, y: this.y.value };
  }

  stopAll(): void {
    for (const v of [this.x, this.y, this.s, this.o, this.lift]) v.stop();
  }
}

/** Canvas tile poses by uid (canvas-local coordinates). */
export const poses = new Map<string, TilePose>();

/** Animation to use for the next rest-position change of a tile (consumed once). */
export const nextMove = new Map<string, SpringOptions>();

/** uids currently controlled by the drag engine (their rest changes must not animate). */
export const held = new Set<string>();
