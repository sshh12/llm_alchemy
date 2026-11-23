// When the "Today in your lab" card appears (IdleCard.tsx), as plain functions so the rules are
// testable without a DOM. Once per local day, for players with 10+ discoveries today, when they
// go idle for a minute on a visible page (a hidden page can't show anything), or after about 10
// active minutes at the next short pause, so it never lands under a finger mid-drag.
import type { ElementDTO, ElementId } from "../../../shared/api.ts";
import { PRODUCTION_HOST } from "../../lib/experiments.ts";
import { readJSON, readString, writeString } from "../../lib/storage.ts";
import type { Owned } from "../../state/game.ts";

/** Discoveries made today before the card is offered (day-0 return rates are flat below ~80; 10 is "playing"). */
export const MIN_DISCOVERIES = 10;

export interface Timings {
  /** No input for this long while the page is visible: the player has paused. */
  idleMs: number;
  /** Active time (input gaps shorter than idleMs) that also earns the card. */
  activeMs: number;
  /** After activeMs, wait for a pause this long (longer than the 5 s Undo snackbar, which it would cover). */
  lullMs: number;
}

export const DEFAULT_TIMINGS: Timings = { idleMs: 60_000, activeMs: 10 * 60_000, lullMs: 6_000 };

/**
 * localStorage keys (not in lib/storage.ts KEYS, which another module owns; move them there).
 * SHOWN_KEY: the local day the card last appeared. TEST_KEY: e2e and dev only, shorter timers
 * such as {"idleMs":1500}; ignored on the production host, like the ia:exp arm override.
 */
export const SHOWN_KEY = "ia:idleCard";
export const TEST_KEY = "ia:idleTest";

/** Timings with the test override applied (never on the production host). */
export function readTimings(host: string, raw: unknown): Timings {
  if (host === PRODUCTION_HOST || !raw || typeof raw !== "object") return DEFAULT_TIMINGS;
  const pick = (k: keyof Timings): number => {
    const v = (raw as Record<string, unknown>)[k];
    return typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : DEFAULT_TIMINGS[k];
  };
  return { idleMs: pick("idleMs"), activeMs: pick("activeMs"), lullMs: pick("lullMs") };
}

/** The current page's timings (test override from localStorage, off the production host). */
export function currentTimings(): Timings {
  let host = PRODUCTION_HOST;
  try {
    host = location.hostname;
  } catch {
    // no location: behave like production
  }
  return readTimings(host, readJSON<unknown>(TEST_KEY, null));
}

/** How often to re-check: once a second, finer only for shortened test timers. */
export const tickMs = (t: Timings): number => Math.max(100, Math.min(1_000, Math.floor(t.idleMs / 4), Math.floor(t.lullMs / 2) || 1_000));

/** Elements discovered on `now`'s local day (starters excluded), and how many were world firsts. */
export function todayCounts(
  owned: Readonly<Record<ElementId, Owned>>,
  elements: Readonly<Record<ElementId, Pick<ElementDTO, "starter">>>,
  now: Date = new Date(),
): { discoveries: number; firsts: number } {
  const start = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const end = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1).getTime();
  let discoveries = 0;
  let firsts = 0;
  for (const [id, o] of Object.entries(owned)) {
    if (elements[id]?.starter) continue;
    const t = Date.parse(o.discoveredAt);
    if (!(t >= start && t < end)) continue;
    discoveries++;
    if (o.first) firsts++;
  }
  return { discoveries, firsts };
}

/**
 * Input timing for this page: how long since the last pointer/keyboard input, and the active
 * time so far (the sum of gaps between inputs no longer than `gapMs`). Hidden time never counts:
 * hiding forgets the last input, and showing the page again starts a fresh pause.
 */
export class ActivityClock {
  private last: number | null;
  private active = 0;

  constructor(
    now: number,
    private readonly gapMs: number,
  ) {
    this.last = now;
  }

  input(now: number): void {
    if (this.last !== null) {
      const gap = now - this.last;
      if (gap > 0 && gap <= this.gapMs) this.active += gap;
    }
    this.last = now;
  }

  hide(): void {
    this.last = null;
  }

  show(now: number): void {
    this.last = now;
  }

  idleFor(now: number): number {
    return this.last === null ? 0 : Math.max(0, now - this.last);
  }

  activeMs(): number {
    return this.active;
  }
}

export type Trigger = "idle" | "active";

/** Whether the timing alone calls for the card now, and why (the idle_card `via`). */
export function trigger(clock: ActivityClock, now: number, t: Timings): Trigger | null {
  const idle = clock.idleFor(now);
  if (idle >= t.idleMs) return "idle";
  if (clock.activeMs() >= t.activeMs && idle >= t.lullMs) return "active";
  return null;
}

/** The parts of the UI store (state/ui.ts) that say whether something else has the player's attention. */
export interface Attention {
  onboarding: boolean;
  welcome: "collapsed" | "expanded" | null;
  coach: unknown;
  sheet: unknown;
  celebrations: readonly unknown[];
  details: unknown;
  shelf: string;
}

/**
 * Something else owns the player's attention: onboarding (the welcome sheet, or the first-run
 * welcome card while expanded, and the coach), a sheet, a celebration card, the details menu, or
 * the phone shelf pulled up over the workbench. The collapsed welcome card does not count: it is
 * one row at the top of the workbench (this card sits at the bottom) and stays up until closed,
 * so counting it would keep the card from most firstRun-treatment players on day 0 and tie the
 * two experiments together. `rail`: the library is a side rail, not the phone shelf.
 */
export function attentionBusy(s: Attention, rail: boolean): boolean {
  return (
    s.onboarding ||
    s.welcome === "expanded" ||
    s.coach != null ||
    s.sheet != null ||
    s.celebrations.length > 0 ||
    s.details != null ||
    (!rail && s.shelf !== "peek")
  );
}

/** In-memory copy, so a browser that can't store anything still sees the card once per page. */
let shownDay: string | null = null;

export function shownOn(day: string): boolean {
  return shownDay === day || readString(SHOWN_KEY) === day;
}

export function markShown(day: string): void {
  shownDay = day;
  writeString(SHOWN_KEY, day);
}

/** Tests only. */
export function resetShownForTests(): void {
  shownDay = null;
}

/** idle_card `secs`: how long the card was up when the player acted on it (capped at an hour). */
export const secsSince = (at: number, now = Date.now()): number => Math.min(3_600, Math.max(0, Math.round((now - at) / 1000)));
