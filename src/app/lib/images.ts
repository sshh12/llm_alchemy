// Lazy art generation. Tiles report when they are actually visible; only visible
// elements with art === 'missing' are requested via POST /api/image, at most two at a time,
// honoring the server's retryAfterMs with backoff, and capped per session so an open tab
// can never hammer the image endpoint.
import type { ElementId } from "../../shared/api.ts";
import { setElementArt, useGame } from "../state/game.ts";
import { ApiFailure, requestImage } from "./api.ts";

const MAX_IN_FLIGHT = 2;
const SESSION_CAP = 150;
const MAX_ATTEMPTS = 8;
const BACKOFF_MS = [1_500, 3_000, 5_000, 8_000, 13_000];
/** Shortest whole-queue pause when the endpoint itself is limited. */
const MIN_PAUSE_MS = 10_000;
/**
 * Longest single timer. A budget can defer for weeks (the monthly image window), and setTimeout
 * fires at once past ~24.8 days, so long waits re-check hourly instead.
 */
const MAX_WAKE_MS = 3_600_000;

const visible = new Map<ElementId, number>(); // id -> number of visible tiles showing it
const queue: ElementId[] = [];
const inFlight = new Set<ElementId>();
const attempts = new Map<ElementId, number>();
const retryAt = new Map<ElementId, number>();
const settled = new Set<ElementId>();
let sent = 0;
let pausedUntil = 0;
let timer: ReturnType<typeof setTimeout> | undefined;

/** The server only paints elements the player owns or today's challenge targets. */
function eligible(id: ElementId): boolean {
  const s = useGame.getState();
  return !!s.owned[id] || !!s.challenge?.targets.some((t) => t.element.id === id);
}

function wanted(id: ElementId): boolean {
  const el = useGame.getState().elements[id];
  return !!el && el.art === "missing" && (visible.get(id) ?? 0) > 0 && !settled.has(id) && eligible(id);
}

function pump(): void {
  clearTimeout(timer);
  const now = Date.now();
  if (now < pausedUntil) {
    timer = setTimeout(pump, Math.min(pausedUntil - now, MAX_WAKE_MS));
    return;
  }
  let nextWake = Infinity;
  for (let i = 0; i < queue.length && inFlight.size < MAX_IN_FLIGHT && sent < SESSION_CAP; ) {
    const id = queue[i]!;
    if (!wanted(id) || inFlight.has(id)) {
      queue.splice(i, 1);
      continue;
    }
    const at = retryAt.get(id) ?? 0;
    if (at > now) {
      nextWake = Math.min(nextWake, at);
      i++;
      continue;
    }
    queue.splice(i, 1);
    void fetchArt(id);
  }
  if (nextWake < Infinity) timer = setTimeout(pump, Math.min(nextWake - now, MAX_WAKE_MS));
}

/**
 * The endpoint (not one element) is limited: a rate limit or an exhausted image budget applies to
 * every request, so hold the whole queue instead of letting other visible tiles keep asking.
 */
function pauseQueue(retryAfterMs: number | undefined): void {
  pausedUntil = Math.max(pausedUntil, Date.now() + Math.max(retryAfterMs ?? 0, MIN_PAUSE_MS));
}

function scheduleRetry(id: ElementId, retryAfterMs: number | undefined): void {
  const n = attempts.get(id) ?? 0;
  if (n >= MAX_ATTEMPTS) {
    settled.add(id); // give up for this session; the placeholder stays
    return;
  }
  const backoff = BACKOFF_MS[Math.min(n - 1, BACKOFF_MS.length - 1)] ?? 1_500;
  retryAt.set(id, Date.now() + Math.max(retryAfterMs ?? 0, backoff));
  if (!queue.includes(id)) queue.push(id);
}

async function fetchArt(id: ElementId): Promise<void> {
  inFlight.add(id);
  sent++;
  attempts.set(id, (attempts.get(id) ?? 0) + 1);
  try {
    const res = await requestImage({ id });
    if (res.state === "ready") {
      settled.add(id);
      setElementArt(id, "ready", res.img);
    } else if (res.state === "blocked") {
      settled.add(id);
      setElementArt(id, "blocked", null);
    } else {
      if (res.state === "deferred" && res.limited) pauseQueue(res.retryAfterMs);
      scheduleRetry(id, res.retryAfterMs);
    }
  } catch (e) {
    const f = e instanceof ApiFailure ? e : null;
    if (f?.code === "rate_limited") {
      pauseQueue(f.retryAfterMs);
      scheduleRetry(id, f.retryAfterMs);
    } else if (f && (f.code === "not_found" || f.code === "forbidden" || f.code === "not_owned" || f.code === "bad_request")) {
      settled.add(id);
    } else {
      scheduleRetry(id, undefined);
    }
  } finally {
    inFlight.delete(id);
    pump();
  }
}

/** A tile showing `id` became visible (true) or hidden (false). */
export function setArtVisible(id: ElementId, isVisible: boolean): void {
  const n = (visible.get(id) ?? 0) + (isVisible ? 1 : -1);
  if (n <= 0) visible.delete(id);
  else visible.set(id, n);
  if (isVisible && wanted(id) && !queue.includes(id) && !inFlight.has(id)) {
    queue.push(id);
    pump();
  }
}
