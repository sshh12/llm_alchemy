// First run, treatment arm of experiment firstRun (Bet A; docs/ARCHITECTURE.md "Experiments").
// Instead of the modal welcome sheet, a brand-new player's board already holds the demo pair
// (DEMO_RECIPE: Water and Fire) with a pulsing coach that names the real gesture, and the
// welcome is a collapsed card that never blocks the board (WelcomeCard.tsx). Control keeps the
// sheet (Overlays.tsx useFirstRun).
//
// Why: in first sessions 99.6% of players who place a tile go on to combine, so the whole
// in-session leak is players who never place one (12.7% of ready players), and about 45% of
// those never closed the modal welcome.
import { DEMO_RECIPE } from "../../../shared/starters.ts";
import { track } from "../../lib/analytics.ts";
import { clampPt, keepClear, type Bounds, type Pt, type Rect } from "../../lib/geometry.ts";
import { KEYS, readString, writeString } from "../../lib/storage.ts";
import { addTile, isSettled, nextFxKey, useCanvas } from "../../state/canvas.ts";
import { useGame } from "../../state/game.ts";
import { useUi } from "../../state/ui.ts";
import { libraryEdge } from "./layout.ts";

/** "1" once the coach was done or dismissed in this browser: it never comes back. */
const COACH_DONE_KEY = "ia:coachDone";

// ------------------------------------------------------------------ brand-new player

/**
 * Only player creation asks for proof-of-work, so a load that solved one created the player
 * (the same signal as app_ready `pow`). Subscribed at module load, before the boot starts.
 */
let sawPow = false;
useGame.subscribe((s) => {
  if (s.powSolving) sawPow = true;
});

const secsSince = (at: number) => Math.min(600, Math.max(0, Math.round((Date.now() - at) / 1000)));

// ------------------------------------------------------------------ coach

export type CoachMode = "drag" | "tap";

/** A fine pointer (mouse, trackpad) drags; touch screens get the tap path. */
export function coachMode(): CoachMode {
  try {
    return matchMedia("(pointer: fine)").matches ? "drag" : "tap";
  } catch {
    return "tap";
  }
}

/**
 * The coach's line, matching the real gestures (actions.ts): drag one tile onto the other, or
 * tap a board tile to select it (tapTile) and tap another to combine. Once one of the pair is
 * selected, it asks for the other.
 */
export function coachText(mode: CoachMode, a: string, b: string, selected: "a" | "b" | null): string {
  if (selected) return `Now ${mode === "drag" ? "click" : "tap"} ${selected === "a" ? b : a}`;
  return mode === "drag" ? `Drag ${a} onto ${b}` : `Tap ${a}, then tap ${b}`;
}

/**
 * Where the demo pair lands: side by side, one tile apart, a little above the middle of the
 * canvas and clear of its obstacles (the toolbar, the collapsed welcome card). An obstacle above
 * that row (the card at the top) moves the row below it: keepClear only moves tiles up or left,
 * and there is no room above a card at the top of a short canvas.
 */
export function demoSpots(b: Bounds, T: number, obstacles: readonly Rect[]): [Pt, Pt] {
  const cx = (b.left + b.w - b.right) / 2;
  let cy = b.top + (b.h - b.top - b.bottom) * 0.42;
  const hits = (r: Rect, y: number) =>
    y + T / 2 > r.y && y - T / 2 < r.y + r.h && [cx - T, cx + T].some((x) => x + T / 2 > r.x && x - T / 2 < r.x + r.w);
  for (const r of [...obstacles].sort((p, q) => p.y - q.y)) {
    if (r.y + r.h / 2 < cy && hits(r, cy)) cy = r.y + r.h + T / 2 + 2;
  }
  const [pa, pb] = keepClear([clampPt({ x: cx - T, y: cy }, b, T), clampPt({ x: cx + T, y: cy }, b, T)], obstacles, b, T);
  return [pa!, pb!];
}

function showCoach(a: string, b: string): void {
  useUi.setState({ coach: { a, b, at: Date.now() } });
  track("coach", { action: "shown", mode: coachMode() });
}

function endCoach(): void {
  writeString(COACH_DONE_KEY, "1");
  useUi.setState({ coach: null });
}

/**
 * A combine succeeded (`inputs`: the canvas tiles it consumed). The first one ends the coach
 * ("done"; `demo` = it was the seeded pair) and, in a first run, onboards the player.
 */
export function noteCombine(inputs: readonly string[]): void {
  if (firstRunActive) writeString(KEYS.onboarded, "1");
  const c = useUi.getState().coach;
  if (!c) return;
  endCoach();
  track("coach", { action: "done", mode: coachMode(), secs: secsSince(c.at), demo: inputs.includes(c.a) && inputs.includes(c.b) });
}

/** The coach's × (`close`), or the pair left the board before any combine (`removed`). */
export function dismissCoach(via: "close" | "removed"): void {
  const c = useUi.getState().coach;
  if (!c) return;
  endCoach();
  track("coach", { action: "dismiss", mode: coachMode(), secs: secsSince(c.at), via });
}

/** The tile is on the board, or is an input of a merge still in flight. */
function onBoard(uid: string): boolean {
  return useCanvas.getState().tiles.some((t) => (t.uid === uid && !t.leaving) || !!t.pending?.inputs.some((i) => i.uid === uid));
}

let recheck: ReturnType<typeof setTimeout> | undefined;
useCanvas.subscribe((s, prev) => {
  if (s.tiles === prev.tiles || !useUi.getState().coach) return;
  clearTimeout(recheck);
  // Deferred: a failed merge removes its pending tile and restores the inputs in two steps.
  recheck = setTimeout(() => {
    const c = useUi.getState().coach;
    if (c && (!onBoard(c.a) || !onBoard(c.b))) dismissCoach("removed");
  }, 0);
});

// ------------------------------------------------------------------ seeding

/** Owned starter id by name. */
function starterId(name: string): string | null {
  const { elements, owned } = useGame.getState();
  const key = name.toLowerCase();
  return Object.keys(owned).find((id) => elements[id]?.starter && elements[id]!.name.toLowerCase() === key) ?? null;
}

/** The first settled board tile of each demo element, if both are there. */
function pairOnBoard(): { a: string; b: string } | null {
  const a = starterId(DEMO_RECIPE.a);
  const b = starterId(DEMO_RECIPE.b);
  if (!a || !b) return null;
  const tiles = useCanvas.getState().tiles.filter(isSettled);
  const ta = tiles.find((t) => t.elementId === a);
  const tb = tiles.find((t) => t.elementId === b);
  return ta && tb ? { a: ta.uid, b: tb.uid } : null;
}

/** Longest wait for the workbench to measure the welcome card before the pair is seeded anyway. */
const CARD_MEASURE_MS = 300;

/**
 * Run `fn` once the workbench has measured itself since the welcome card went up, so the card is
 * among the obstacles the pair keeps clear of. Putting the card up re-renders the Workbench, which
 * measures again in the commit that mounts it (useCanvasMeasure), so the next obstacles update
 * after `useUi.welcome` was set includes it (and if the workbench has not measured itself yet,
 * its first measurement does). Call right after setting it. A canvas too small to measure never
 * updates: after CARD_MEASURE_MS the pair is seeded as soon as there are bounds.
 */
function whenCardMeasured(fn: () => void): void {
  const before = useCanvas.getState().obstacles;
  let timedOut = false;
  let done = false;
  const run = () => {
    if (done) return;
    done = true;
    off();
    clearTimeout(timer);
    fn();
  };
  const off = useCanvas.subscribe((s) => {
    if (s.bounds && (s.obstacles !== before || timedOut)) run();
  });
  const timer = setTimeout(() => {
    timedOut = true;
    if (useCanvas.getState().bounds) run();
  }, CARD_MEASURE_MS);
}

/** Put the demo pair on an empty board, flying in from the library, and start the coach. */
function seedDemoPair(): void {
  const { tiles, bounds, T, obstacles } = useCanvas.getState();
  const a = starterId(DEMO_RECIPE.a);
  const b = starterId(DEMO_RECIPE.b);
  // Something is already on the board (state from an earlier visit): leave it alone.
  if (!bounds || !a || !b || tiles.some((t) => !t.leaving)) return;
  const [pa, pb] = demoSpots(bounds, T, obstacles);
  const from = libraryEdge();
  const ua = addTile({ elementId: a, x: pa.x, y: pa.y, enterFrom: from, fx: "spawn", fxKey: nextFxKey() });
  const ub = addTile({ elementId: b, x: pb.x, y: pb.y, enterFrom: from, fx: "spawn", fxKey: nextFxKey() });
  showCoach(ua, ub);
}

// ------------------------------------------------------------------ entry point

/** This load is a treatment first run (the welcome card was put up). */
let firstRunActive = false;
let entered = false;

/**
 * The game is ready for a treatment player who is not a legacy arrival or opening a transfer
 * link (Overlays.tsx useFirstRun). `welcome`: not onboarded yet (KEYS.onboarded), so the
 * welcome card shows. A brand-new player (this load created it) also gets the seeded pair;
 * anyone else gets the coach back if the pair is still on the board and they have never
 * combined. Runs once per page load.
 */
export function enterFirstRun({ welcome }: { welcome: boolean }): void {
  if (entered) return;
  entered = true;
  if (welcome) {
    firstRunActive = true;
    useUi.setState({ welcome: "collapsed" });
  }
  if (welcome && sawPow) {
    whenCardMeasured(seedDemoPair);
    return;
  }
  if (readString(KEYS.merged) === "1" || readString(COACH_DONE_KEY) === "1") return;
  const pair = pairOnBoard();
  if (pair) showCoach(pair.a, pair.b);
}

// ------------------------------------------------------------------ welcome card

let welcomeAt = 0;

/** The welcome card is on screen (onboarding `shown`, once per load). */
export function welcomeShown(): void {
  if (welcomeAt) return;
  welcomeAt = Date.now();
  track("onboarding", { action: "shown" });
}

export function toggleWelcome(): void {
  const open = useUi.getState().welcome === "collapsed";
  useUi.setState({ welcome: open ? "expanded" : "collapsed" });
  if (open) track("onboarding", { action: "expand", secs: secsSince(welcomeAt) });
}

/** "Start mixing" (`start`) or × (`dismiss`): the card goes and the player counts as onboarded. */
export function closeWelcome(via: "start" | "dismiss"): void {
  if (!useUi.getState().welcome) return;
  track("onboarding", { action: via, secs: secsSince(welcomeAt) });
  writeString(KEYS.onboarded, "1");
  useUi.setState({ welcome: null });
}

export function welcomeLink(target: string): void {
  track("onboarding", { action: "link", target, secs: secsSince(welcomeAt) });
}
