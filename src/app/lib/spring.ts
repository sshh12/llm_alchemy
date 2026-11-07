// A tiny spring animator for values that change every frame (tile poses, the shelf
// height). It keeps per-frame work out of React: springs integrate in one shared rAF
// loop and DOM writes are flushed once per frame. Spring parameters use Motion's
// `visualDuration` + `bounce` model so feel matches the Motion-driven UI elsewhere.

export interface SpringOptions {
  /** Approximate time (s) to visually reach the target. */
  visualDuration: number;
  /** 0 = critically damped, higher = bouncier. */
  bounce?: number;
  /** Initial velocity in units per second. */
  velocity?: number;
  /** Delay before starting (ms). */
  delay?: number;
}

export const springConfig = {
  /** When true every animation jumps to its end state (prefers-reduced-motion / setting). */
  reduced: false,
};

const active = new Set<SpringValue>();
const dirty = new Set<() => void>();
let raf = 0;
let last = 0;

function schedule(): void {
  if (!raf) raf = requestAnimationFrame(tick);
}

function tick(now: number): void {
  raf = 0;
  const dt = last ? Math.min(0.064, (now - last) / 1000) : 1 / 60;
  last = now;
  for (const s of [...active]) s.step(dt, now);
  const writers = [...dirty];
  dirty.clear();
  for (const w of writers) w();
  if (active.size || dirty.size) schedule();
  else last = 0;
}

/** Queue a DOM write for the next frame (deduplicated by function identity). */
function queueWrite(write: () => void): void {
  dirty.add(write);
  schedule();
}

export class SpringValue {
  value: number;
  velocity = 0;
  target: number;
  private k = 0;
  private c = 0;
  private startAt = 0;
  private onRest: (() => void) | null = null;

  constructor(
    initial: number,
    private readonly write: () => void,
    /** Rest threshold in value units (px default; use ~0.001 for scale/opacity). */
    private readonly precision = 0.05,
  ) {
    this.value = initial;
    this.target = initial;
  }

  get animating(): boolean {
    return active.has(this);
  }

  /** Jump immediately (cancels any running animation and its rest callback). */
  set(v: number): void {
    this.stop();
    this.value = v;
    this.target = v;
    this.velocity = 0;
    queueWrite(this.write);
  }

  /** Animate to `target`; `onRest` fires only if this animation completes (not if retargeted). */
  to(target: number, opts: SpringOptions, onRest?: () => void): void {
    this.target = target;
    if (springConfig.reduced) {
      this.set(target);
      onRest?.();
      return;
    }
    const root = (2 * Math.PI) / (opts.visualDuration * 1.2);
    this.k = root * root;
    this.c = 2 * Math.min(1, Math.max(0.05, 1 - (opts.bounce ?? 0))) * Math.sqrt(this.k);
    if (opts.velocity !== undefined) this.velocity = opts.velocity;
    this.startAt = performance.now() + (opts.delay ?? 0);
    this.onRest = onRest ?? null;
    active.add(this);
    schedule();
  }

  /** Stop where it is, without firing the rest callback. */
  stop(): void {
    active.delete(this);
    this.onRest = null;
  }

  step(dt: number, now: number): void {
    if (now < this.startAt) return;
    const n = Math.max(1, Math.ceil(dt / (1 / 240)));
    const h = dt / n;
    for (let i = 0; i < n; i++) {
      const a = -this.k * (this.value - this.target) - this.c * this.velocity;
      this.velocity += a * h;
      this.value += this.velocity * h;
    }
    dirty.add(this.write);
    if (Math.abs(this.value - this.target) < this.precision && Math.abs(this.velocity) < this.precision * 20) {
      this.value = this.target;
      this.velocity = 0;
      active.delete(this);
      const cb = this.onRest;
      this.onRest = null;
      cb?.();
    }
  }
}

/** Spring presets from the interaction spec (ux-design.md §5.3). */
export const SPRING = {
  press: { visualDuration: 0.12, bounce: 0 },
  pickup: { visualDuration: 0.18, bounce: 0.3 },
  settle: { visualDuration: 0.3, bounce: 0.15 },
  tidy: { visualDuration: 0.4, bounce: 0.1 },
  absorb: { visualDuration: 0.22, bounce: 0 },
  pop: { visualDuration: 0.35, bounce: 0.45 },
  shelf: { visualDuration: 0.3, bounce: 0.1 },
  collapse: { visualDuration: 0.25, bounce: 0 },
  follow: { visualDuration: 0.12, bounce: 0 },
} satisfies Record<string, SpringOptions>;
