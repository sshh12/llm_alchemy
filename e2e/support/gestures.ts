// Input helpers that behave like a real finger or mouse.
//
// Touch: Playwright has no touch-drag API, so Chromium projects dispatch raw touch events via CDP
// (Input.dispatchTouchEvent). These go through Chromium's real input pipeline, so the app sees
// genuine pointer events with pointerType "touch", touch-action/scroll arbitration applies, and
// implicit pointer capture behaves as on a phone.
import type { CDPSession, Locator, Page } from "@playwright/test";

export interface Point {
  x: number;
  y: number;
}

export async function center(locator: Locator): Promise<Point> {
  await locator.scrollIntoViewIfNeeded();
  const box = await locator.boundingBox();
  if (!box) throw new Error(`No bounding box for ${locator}`);
  return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
}

export interface DragOptions {
  /** Number of intermediate move events. */
  steps?: number;
  /** Delay between move events (ms); ~16 ms is one frame. */
  stepDelayMs?: number;
  /** Hold still after pressing before moving (long-press activation). */
  holdMs?: number;
  /**
   * First move this many px along the dominant axis of the drag, so direction-detecting
   * scrollers (pan-x shelf: vertical pull; pan-y rail: sideways pull) hand the gesture to the app.
   */
  leadPx?: number;
  /**
   * Pause over the target before releasing (lets magnetic snapping lock on). Keep it well under
   * the 450 ms "gather" hover that turns a drop into a multi-element stack.
   */
  settleMs?: number;
}

const sleep = (page: Page, ms: number) => (ms > 0 ? page.waitForTimeout(ms) : Promise.resolve());

/** Points from `from` to `to`: an axis-aligned lead-in, then a straight line, never repeating `from`. */
export function dragPath(from: Point, to: Point, steps: number, leadPx: number): Point[] {
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const pts: Point[] = [];
  let start = from;
  if (leadPx > 0) {
    const horizontal = Math.abs(dx) >= Math.abs(dy);
    const lead = horizontal
      ? { x: from.x + Math.sign(dx || 1) * Math.min(leadPx, Math.abs(dx) || leadPx), y: from.y }
      : { x: from.x, y: from.y + Math.sign(dy || -1) * Math.min(leadPx, Math.abs(dy) || leadPx) };
    const leadSteps = 4;
    for (let i = 1; i <= leadSteps; i++) {
      pts.push({ x: from.x + ((lead.x - from.x) * i) / leadSteps, y: from.y + ((lead.y - from.y) * i) / leadSteps });
    }
    start = lead;
  }
  for (let i = 1; i <= steps; i++) {
    // ease-in-out so the finger slows down over the target like a person does
    const t = i / steps;
    const e = t < 0.5 ? 2 * t * t : 1 - (-2 * t + 2) ** 2 / 2;
    pts.push({ x: start.x + (to.x - start.x) * e, y: start.y + (to.y - start.y) * e });
  }
  return pts;
}

function touchPoint(p: Point) {
  return { x: Math.round(p.x), y: Math.round(p.y), id: 1, radiusX: 6, radiusY: 6, force: 0.5 };
}

async function withCdp<T>(page: Page, fn: (cdp: CDPSession) => Promise<T>): Promise<T> {
  const cdp = await page.context().newCDPSession(page);
  try {
    return await fn(cdp);
  } finally {
    await cdp.detach().catch(() => {});
  }
}

/** A realistic finger drag: touchStart, many touchMoves with small delays, touchEnd. Chromium only. */
export async function touchDrag(page: Page, from: Point, to: Point, opts: DragOptions = {}): Promise<void> {
  const { steps = 24, stepDelayMs = 16, holdMs = 0, leadPx = 28, settleMs = 80 } = opts;
  await withCdp(page, async (cdp) => {
    await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [touchPoint(from)] });
    await sleep(page, holdMs);
    let last = from;
    for (const p of dragPath(from, to, steps, leadPx)) {
      await cdp.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [touchPoint(p)] });
      last = p;
      await sleep(page, stepDelayMs);
    }
    // a couple of stationary frames over the target, like a finger settling
    for (let i = 0; i < 3; i++) {
      await cdp.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [touchPoint(last)] });
      await sleep(page, settleMs / 3);
    }
    await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
  });
}

/** Press and hold without moving, then lift (opens quick actions on touch). Chromium only. */
export async function touchLongPress(page: Page, at: Point, holdMs = 650): Promise<void> {
  await withCdp(page, async (cdp) => {
    await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [touchPoint(at)] });
    await sleep(page, holdMs);
    await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
  });
}

/** Press and hold for `holdMs` (hold-to-confirm buttons). Touch on touch devices, mouse otherwise. */
export async function pressAndHold(page: Page, at: Point, holdMs: number, touch: boolean): Promise<void> {
  if (touch) return touchLongPress(page, at, holdMs);
  await page.mouse.move(at.x, at.y);
  await page.mouse.down();
  await sleep(page, holdMs);
  await page.mouse.up();
}

/** Mouse drag with intermediate moves (desktop). */
export async function mouseDrag(page: Page, from: Point, to: Point, opts: DragOptions = {}): Promise<void> {
  const { steps = 20, stepDelayMs = 10, holdMs = 0, leadPx = 12, settleMs = 60 } = opts;
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  await sleep(page, holdMs);
  for (const p of dragPath(from, to, steps, leadPx)) {
    await page.mouse.move(p.x, p.y);
    await sleep(page, stepDelayMs);
  }
  await sleep(page, settleMs);
  await page.mouse.up();
}

/** Drag with whatever input the device has. */
export async function drag(page: Page, from: Point, to: Point, touch: boolean, opts: DragOptions = {}): Promise<void> {
  return touch ? touchDrag(page, from, to, opts) : mouseDrag(page, from, to, opts);
}

/** Tap (touch devices) or click (mouse devices). */
export async function tap(locator: Locator, touch: boolean): Promise<void> {
  if (touch) await locator.tap();
  else await locator.click();
}
