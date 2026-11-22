// Lazy art generation. Tiles report when they are actually visible; only visible elements with
// art === 'missing' are requested via POST /api/image, at most two at a time, honoring the
// server's retryAfterMs with backoff.
//
// Image spending is paced on the server (server/game/images.ts). When it answers "deferred" the
// element simply keeps its emoji placeholder and goes to rest: backlog art (older library tiles)
// is asked for again only the next time a tile showing it comes into view after the rest, or on
// the next page load, never from a timer. A budget that is behind pace then costs one request per
// tile view instead of a polling loop, the art left over is spread across the following hours and
// days, and players who scroll through thousands of tiles meet a gentle, visual limit rather than
// an error. Fresh art (discoveries of the last 20 minutes, today's challenge targets) goes to the front
// of the queue, is exempt from the session cap and from backlog holds, and gets a couple of timer
// retries while it is on screen.
import type { ArtDeferReason, ElementId, ImageResponse } from "../../shared/api.ts";
import { setElementArt, useGame } from "../state/game.ts";
import { ApiFailure, requestImage } from "./api.ts";

const MAX_IN_FLIGHT = 2;
/**
 * Backlog requests per session that could have started a generation (fresh art is exempt):
 * first requests and retries after a failed generation, not polls of someone else's lease.
 */
const SESSION_CAP = 150;
/** Safety net: after this many deferred replies in a session, stop asking for art. */
const MAX_DEFERRED = 300;
/** Polls and transient-error retries per element per session. */
const MAX_ATTEMPTS = 8;
const BACKOFF_MS = [1_500, 3_000, 5_000, 8_000, 13_000];
/** Whole-queue pause on an HTTP 429 (a rate limit on the endpoint itself, e.g. the platform rule). */
const MIN_PAUSE_MS = 10_000;
const MAX_PAUSE_MS = 15 * 60_000;
/** A discovery's art is fresh this long (the server's fresh lane uses the same window). */
const FRESH_MS = 20 * 60_000;
/** A deferred fresh element is retried on a timer, while visible, after at least this... */
const FRESH_RETRY_MIN_MS = 2 * 60_000;
/** ...unless the server asks for longer than this: then it rests like backlog. */
const FRESH_RETRY_MAX_MS = 30 * 60_000;
/** Deferrals of one fresh element (per session) before it rests like backlog. */
const MAX_FRESH_DEFERRALS = 3;
/** Shortest rest after a deferral. */
const REST_MIN_MS = 10 * 60_000;
/**
 * After a limited deferral, backlog requests wait the server's hint clamped to this range: the
 * backlog lane spends below the fresh lane's pace, so it would be refused too, and a library
 * scroll must not fire a burst of doomed requests.
 */
const HOLD_MIN_MS = 2 * 60_000;
const HOLD_MAX_MS = 15 * 60_000;
/** Deferrals the server repeats until its hint: a spent budget, a per-player or per-IP cap, or given up. */
const FIRM_REASONS: ReadonlySet<ArtDeferReason> = new Set(["budget", "player", "ip", "gave_up"]);

const visible = new Map<ElementId, number>(); // id -> number of visible tiles showing it
/** Requested even with no tile on screen (a share card waiting for its art). */
const pinned = new Map<ElementId, number>();
const queue: ElementId[] = [];
const inFlight = new Set<ElementId>();
const attempts = new Map<ElementId, number>();
const retryAt = new Map<ElementId, number>();
/** The last reply for this element was "pending": the next request is a poll. */
const polling = new Set<ElementId>();
/** Resting until this time; then asked again only when a tile showing it next becomes visible. */
const restUntil = new Map<ElementId, number>();
const freshUntil = new Map<ElementId, number>();
const freshDeferrals = new Map<ElementId, number>();
/** A firm deferral (FIRM_REASONS) holds until this time: a share card does not ask again before it. */
const refusedUntil = new Map<ElementId, number>();
/** waitForArt callers per element, released (with null) as soon as the art can't arrive in time. */
const waiters = new Map<ElementId, Set<() => void>>();
const settled = new Set<ElementId>();
let sent = 0;
let deferredReplies = 0;
let pausedUntil = 0;
let backlogHeldUntil = 0;
let timer: ReturnType<typeof setTimeout> | undefined;

/** The server only paints elements the player owns or today's challenge targets. */
function eligible(id: ElementId): boolean {
  const s = useGame.getState();
  return !!s.owned[id] || !!s.challenge?.targets.some((t) => t.element.id === id);
}

/**
 * Fresh art: discovered in the last FRESH_MS (noteFresh this session, or owned[id].discoveredAt,
 * which survives a reload and covers other tabs, like the server's lane), or a challenge target.
 */
function isFresh(id: ElementId, now = Date.now()): boolean {
  if ((freshUntil.get(id) ?? 0) > now) return true;
  const s = useGame.getState();
  const discovered = Date.parse(s.owned[id]?.discoveredAt ?? ""); // NaN when unknown: not fresh
  return now - discovered < FRESH_MS || !!s.challenge?.targets.some((t) => t.element.id === id);
}

/** Release the waitForArt callers of `id` (of every element when omitted): their art won't come in time. */
function stopWaiting(id?: ElementId): void {
  for (const [key, stops] of [...waiters]) if (id === undefined || key === id) for (const stop of [...stops]) stop();
}

function wanted(id: ElementId): boolean {
  const el = useGame.getState().elements[id];
  return (
    !!el &&
    el.art === "missing" &&
    ((visible.get(id) ?? 0) > 0 || pinned.has(id)) &&
    !settled.has(id) &&
    !restUntil.has(id) &&
    eligible(id)
  );
}

function enqueue(id: ElementId): void {
  if (queue.includes(id)) return;
  if (isFresh(id)) queue.unshift(id);
  else queue.push(id);
}

function pump(): void {
  clearTimeout(timer);
  timer = undefined;
  if (deferredReplies >= MAX_DEFERRED) return;
  const now = Date.now();
  if (now < pausedUntil) {
    timer = setTimeout(pump, pausedUntil - now);
    return;
  }
  let nextWake = Infinity;
  for (let i = 0; i < queue.length && inFlight.size < MAX_IN_FLIGHT; ) {
    const id = queue[i]!;
    const fresh = isFresh(id, now);
    if (!wanted(id) || inFlight.has(id) || (!fresh && sent >= SESSION_CAP)) {
      queue.splice(i, 1);
      continue;
    }
    const at = Math.max(retryAt.get(id) ?? 0, fresh ? 0 : backlogHeldUntil);
    if (at > now) {
      nextWake = Math.min(nextWake, at);
      i++;
      continue;
    }
    queue.splice(i, 1);
    void fetchArt(id);
  }
  if (nextWake < Infinity) timer = setTimeout(pump, nextWake - now);
}

/**
 * The endpoint itself answered 429: hold the whole queue briefly instead of letting every tile
 * ask. The pause (at least MIN_PAUSE_MS) outlasts any share card's wait, so those stop waiting.
 */
function pauseQueue(retryAfterMs: number | undefined): void {
  pausedUntil = Math.max(pausedUntil, Date.now() + Math.min(MAX_PAUSE_MS, Math.max(retryAfterMs ?? 0, MIN_PAUSE_MS)));
  stopWaiting();
}

/** Poll again (pending) or retry after a transient failure, with backoff; give up after MAX_ATTEMPTS. */
function scheduleRetry(id: ElementId, retryAfterMs: number | undefined): void {
  const n = (attempts.get(id) ?? 0) + 1;
  attempts.set(id, n);
  if (n >= MAX_ATTEMPTS) {
    settled.add(id); // give up for this session; the placeholder stays
    stopWaiting(id);
    return;
  }
  const backoff = BACKOFF_MS[Math.min(n - 1, BACKOFF_MS.length - 1)] ?? 1_500;
  retryAt.set(id, Date.now() + Math.max(retryAfterMs ?? 0, backoff));
  enqueue(id);
}

/** Keep the emoji for now: rest (backlog) or retry once more while on screen (fresh). */
function onDeferred(id: ElementId, res: Extract<ImageResponse, { state: "deferred" }>): void {
  deferredReplies++;
  const now = Date.now();
  const wait = Math.max(0, res.retryAfterMs ?? 0);
  // Even a fresh retry is minutes away (FRESH_RETRY_MIN_MS), past any share card's wait.
  stopWaiting(deferredReplies >= MAX_DEFERRED ? undefined : id);
  if (res.reason && FIRM_REASONS.has(res.reason)) refusedUntil.set(id, now + wait);
  else refusedUntil.delete(id);
  if (res.limited) backlogHeldUntil = Math.max(backlogHeldUntil, now + Math.min(HOLD_MAX_MS, Math.max(HOLD_MIN_MS, wait)));
  const lane = res.lane ?? (isFresh(id, now) ? "fresh" : "backlog");
  if (lane === "fresh" && res.reason !== "gave_up") {
    const n = (freshDeferrals.get(id) ?? 0) + 1;
    freshDeferrals.set(id, n);
    const retryIn = Math.max(wait, FRESH_RETRY_MIN_MS);
    if (n < MAX_FRESH_DEFERRALS && retryIn <= FRESH_RETRY_MAX_MS) {
      retryAt.set(id, now + retryIn);
      enqueue(id);
      return;
    }
  }
  retryAt.delete(id);
  restUntil.set(id, now + Math.max(wait, REST_MIN_MS));
}

async function fetchArt(id: ElementId): Promise<void> {
  inFlight.add(id);
  const poll = polling.delete(id);
  // Backlog requests that could have started a generation count against SESSION_CAP.
  let counts = !poll && !isFresh(id);
  try {
    const res = await requestImage({ id });
    if (res.state === "ready") {
      settled.add(id);
      setElementArt(id, "ready", res.img);
    } else if (res.state === "blocked") {
      settled.add(id);
      setElementArt(id, "blocked", null);
    } else if (res.state === "pending") {
      // After a failed attempt the next request starts a new generation: not a poll.
      if (!res.failed) polling.add(id);
      scheduleRetry(id, res.retryAfterMs);
    } else {
      counts = false;
      onDeferred(id, res);
    }
  } catch (e) {
    const f = e instanceof ApiFailure ? e : null;
    if (f?.code === "rate_limited") {
      counts = false;
      pauseQueue(f.retryAfterMs);
      scheduleRetry(id, f.retryAfterMs);
    } else if (f && (f.code === "not_found" || f.code === "forbidden" || f.code === "not_owned" || f.code === "bad_request")) {
      counts = false;
      settled.add(id);
      stopWaiting(id);
    } else {
      scheduleRetry(id, undefined); // network, timeout, 5xx: a generation may have started
    }
  } finally {
    if (counts) sent++;
    inFlight.delete(id);
    pump();
  }
}

/** A tile showing `id` became visible (true) or hidden (false). */
export function setArtVisible(id: ElementId, isVisible: boolean): void {
  const n = (visible.get(id) ?? 0) + (isVisible ? 1 : -1);
  if (n <= 0) visible.delete(id);
  else visible.set(id, n);
  if (!isVisible) return;
  // A resting element wakes only when it comes into view after its rest is over.
  const until = restUntil.get(id);
  if (until !== undefined) {
    if (Date.now() < until) return;
    restUntil.delete(id);
  }
  if (wanted(id) && !inFlight.has(id)) {
    enqueue(id);
    pump();
  }
}

/**
 * The player just discovered `id` (src/app/features/workbench/actions.ts): its art jumps the
 * queue for the next FRESH_MS.
 */
export function noteFresh(id: ElementId): void {
  freshUntil.set(id, Date.now() + FRESH_MS);
  const i = queue.indexOf(id);
  if (i > 0) {
    queue.splice(i, 1);
    queue.unshift(id);
    pump();
  }
}

/**
 * Ask for `id`'s art now, with fresh priority and whether or not a tile shows it, and resolve
 * with its image path once ready, or null after `timeoutMs`, or as soon as it can't arrive in
 * time: deferred, settled without art, queue paused (stopWaiting), or can't be had this session.
 * A rest is cut short: the player asked for this element (src/app/lib/share.ts); a firm refusal
 * is not, since the server would only say no again.
 */
export function waitForArt(id: ElementId, timeoutMs: number): Promise<string | null> {
  const current = () => useGame.getState().elements[id];
  const el = current();
  if (!el || el.art !== "missing") return Promise.resolve(el?.img ?? null);
  if ((refusedUntil.get(id) ?? 0) > Date.now()) return Promise.resolve(null);
  noteFresh(id);
  restUntil.delete(id);
  pinned.set(id, (pinned.get(id) ?? 0) + 1);
  const unpin = () => {
    const n = (pinned.get(id) ?? 1) - 1;
    if (n <= 0) pinned.delete(id);
    else pinned.set(id, n);
  };
  if (!wanted(id) || deferredReplies >= MAX_DEFERRED) {
    unpin();
    return Promise.resolve(null);
  }
  return new Promise((resolve) => {
    let done = false;
    const stop = () => finish(null);
    const finish = (img: string | null) => {
      if (done) return;
      done = true;
      clearTimeout(timeout);
      unsubscribe();
      unpin();
      const stops = waiters.get(id);
      stops?.delete(stop);
      if (stops?.size === 0) waiters.delete(id);
      resolve(img);
    };
    const stops = waiters.get(id) ?? new Set();
    waiters.set(id, stops.add(stop));
    const timeout = setTimeout(stop, timeoutMs);
    const unsubscribe = useGame.subscribe(() => {
      const e = current();
      if (!e || e.art !== "missing") finish(e?.img ?? null);
    });
    if (!inFlight.has(id)) {
      retryAt.delete(id); // now, not when a retry timer from an earlier reply fires
      enqueue(id);
      pump();
    }
  });
}
