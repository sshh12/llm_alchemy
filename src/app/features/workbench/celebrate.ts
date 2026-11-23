// World-first celebration throttle (T4c) and the combine-failure analytics params. Pure logic,
// kept out of actions.ts so it can be tested without the DOM.
//
// The full-screen "First discovery" card interrupts play: sessions end more often right after
// an isolated world-first than after any other discovery. But it is also the game's best
// reward moment. So the card stays for the moments that matter most (the tab session's first
// world-first, notable names, epic and legendary finds) and every other world-first is an
// event-level 50/50 draw between the card and an inline gold toast. `wf_followup` then says
// whether play continued within 60 s, computed here in the client, so the two arms compare
// on the same events (docs/ARCHITECTURE.md "Experiments").
import type { Rarity } from "../../../shared/api.ts";
import type { EventParams } from "../../lib/analytics.ts";
import { ApiFailure } from "../../lib/api.ts";

export type CelebrationKind = "card" | "toast";
/** Why a world-first got its celebration. Only random_card vs random_toast is a fair comparison. */
export type CelebrationReason = "session_first" | "notable" | "rare" | "random_card" | "random_toast";

export interface CelebrationChoice {
  kind: CelebrationKind;
  reason: CelebrationReason;
}

/** Share of the other world-firsts that still get the card (the control arm of the draw). */
export const CARD_SHARE = 0.5;

/**
 * Card or toast for a world-first. `random` is called only for an eligible event (not the
 * session's first, not notable, not epic or legendary), so the draw is independent per event.
 */
export function chooseCelebration(
  first: { sessionFirst: boolean; notable: boolean; rarity: Rarity },
  random: () => number = Math.random,
): CelebrationChoice {
  if (first.sessionFirst) return { kind: "card", reason: "session_first" };
  if (first.notable) return { kind: "card", reason: "notable" };
  if (first.rarity === "epic" || first.rarity === "legendary") return { kind: "card", reason: "rare" };
  return random() < CARD_SHARE ? { kind: "card", reason: "random_card" } : { kind: "toast", reason: "random_toast" };
}

/** The window `wf_followup.cont60` looks at. */
export const FOLLOWUP_MS = 60_000;

export type FollowupVia = "combine" | "timer" | "hidden";

interface Pending extends CelebrationChoice {
  at: number;
  timer: ReturnType<typeof setTimeout>;
}

/**
 * One outcome per world-first: did a combine start after it within 60 s? Sent at the next combine
 * (cont60 = it came in time), when 60 s pass without one (false), or when the page is hidden first
 * (false: the player left the tab; a hidden tab's timers are throttled and a closed one never
 * fires them). Merges can overlap (a second pair dropped while the first waits on the AI), so
 * several world-firsts can be pending at once: a later world-first doesn't settle an earlier one
 * (no combine started after it yet), the next combine settles them all.
 */
export class FollowupTracker {
  private pending: Pending[] = [];

  constructor(
    private readonly send: (params: EventParams) => void,
    private readonly now: () => number = Date.now,
    private readonly windowMs = FOLLOWUP_MS,
  ) {}

  get active(): boolean {
    return this.pending.length > 0;
  }

  start(choice: CelebrationChoice): void {
    const p: Pending = { ...choice, at: this.now(), timer: setTimeout(() => this.settle([p], "timer"), this.windowMs) };
    this.pending.push(p);
  }

  /** A combine started (any inputs, cached or not). */
  combine(): void {
    this.settle(this.pending, "combine");
  }

  /** The page was hidden or is going away. */
  hidden(): void {
    this.settle(this.pending, "hidden");
  }

  private settle(which: readonly Pending[], via: FollowupVia): void {
    const done = which.filter((p) => this.pending.includes(p));
    if (done.length === 0) return;
    this.pending = this.pending.filter((p) => !done.includes(p));
    for (const p of done) {
      clearTimeout(p.timer);
      const cont60 = via === "combine" && this.now() - p.at <= this.windowMs;
      this.send({ kind: p.kind, reason: p.reason, cont60, via });
    }
  }
}

/** combine_failed `retry_s`: the server's retry hint, bucketed (a GA dimension, not a raw number). */
export function retryBucket(ms: number | undefined): string | undefined {
  if (ms === undefined || !Number.isFinite(ms) || ms < 0) return undefined;
  const s = ms / 1000;
  if (s < 5) return "<5";
  if (s < 30) return "5-30";
  if (s < 120) return "30-120";
  return "120+";
}

/**
 * combine_failed params: `code`, plus `limit` (the server rule that refused, e.g. llm.player, or
 * "platform" for a bare 429 from a Netlify platform rule) and `retry_s` when the server said.
 */
export function combineFailedParams(e: unknown): EventParams {
  if (!(e instanceof ApiFailure)) return { code: "network" };
  const out: EventParams = { code: e.code };
  const limit = e.limit ?? (e.status === 429 ? "platform" : undefined);
  if (limit) out.limit = limit;
  const retry = retryBucket(e.retryAfterMs);
  if (retry) out.retry_s = retry;
  return out;
}
