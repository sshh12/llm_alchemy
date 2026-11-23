// Server-backed game state: the element catalog this client knows about, the player's
// library, stats, today's challenge, history and the "fresh from the lab" feed.
// Elements are normalized by id so art updates touch exactly one record.
import { create } from "zustand";
import { identify, track } from "../lib/analytics.ts";
import {
  ACQ_MAX,
  latencyBand,
  type Acquisition,
  type BootBeacon,
  type BootEntry,
  type BootPhase,
  type BootstrapHint,
  type BootstrapRequest,
  type BootstrapResponse,
  type ChallengeHistoryDay,
  type CombineResponse,
  type DailyChallengeDTO,
  type ElementDTO,
  type ElementId,
  type Stats,
  type Tier,
  type TomorrowTeaser,
} from "../../shared/api.ts";
import { localDay } from "../../shared/dates.ts";
import { experimentUserProperties } from "../../shared/experiments.ts";
import {
  ApiFailure,
  bootstrap,
  newBootTrace,
  refreshBootstrap,
  sendBootBeacon,
  type BootTrace,
  type FailureCode,
} from "../lib/api.ts";
import { markLegacyImported, readLegacy, type LegacyState } from "../lib/legacy.ts";
import { WIDE_QUERY } from "../lib/hooks.ts";
import { KEYS, readJSON, readString } from "../lib/storage.ts";

export interface Owned {
  discoveredAt: string;
  first: boolean;
}

export interface GameState {
  status: "booting" | "ready" | "error";
  /** The server asked for proof-of-work; the worker is solving it. */
  powSolving: boolean;
  bootError: FailureCode | null;
  /** `player.id` is the public id (players.public_id): GA user_id and experiment arms use it. */
  player: BootstrapResponse["player"] | null;
  elements: Record<ElementId, ElementDTO>;
  owned: Record<ElementId, Owned>;
  stats: Stats;
  challenge: DailyChallengeDTO | null;
  history: ChallengeHistoryDay[];
  recent: ElementId[];
  /** Local day the loaded challenge belongs to. */
  day: string;
  /** Tomorrow's easy target teaser (art when ready, letter count); null when the server sent none. */
  tomorrow: TomorrowTeaser | null;
  /**
   * Set when this load adopted/imported 2023 progress (drives the one-time welcome-back notice).
   * `claimedElsewhere`: the legacy player is bound to another browser; this one got a copy of the elements.
   */
  legacyWelcome: { restored: number; claimedElsewhere?: boolean } | null;
}

const EMPTY_STATS: Stats = { known: 0, mine: 0, firsts: 0, challengesCompleted: 0, streak: { current: 0, best: 0 } };

export const useGame = create<GameState>(() => ({
  status: "booting",
  powSolving: false,
  bootError: null,
  player: null,
  elements: {},
  owned: {},
  stats: EMPTY_STATS,
  challenge: null,
  history: [],
  recent: [],
  day: localDay(),
  tomorrow: null,
  legacyWelcome: null,
}));

const ART_RANK: Record<ElementDTO["art"], number> = { missing: 0, blocked: 1, ready: 2 };

/** Merge a server copy of an element with what we have, never regressing art we already fetched. */
function mergeElement(prev: ElementDTO | undefined, next: ElementDTO): ElementDTO {
  if (!prev) return next;
  if (ART_RANK[prev.art] > ART_RANK[next.art]) return { ...next, art: prev.art, img: prev.img };
  return next;
}

function withElements(map: Record<ElementId, ElementDTO>, list: readonly ElementDTO[]): Record<ElementId, ElementDTO> {
  const out = { ...map };
  for (const el of list) out[el.id] = mergeElement(out[el.id], el);
  return out;
}

function matches(query: string): boolean {
  try {
    return window.matchMedia(query).matches;
  } catch {
    return false;
  }
}

/** Running as an installed app (iOS home-screen apps also set navigator.standalone). */
function isStandalone(): boolean {
  try {
    return matches("(display-mode: standalone)") || (navigator as Navigator & { standalone?: boolean }).standalone === true;
  } catch {
    return false;
  }
}

/** First-touch acquisition recorded by the page head, cleaned to the server's caps (or undefined). */
function readAcquisition(): Acquisition | undefined {
  const raw = readJSON<Record<string, unknown> | null>(KEYS.acq, null);
  if (!raw || typeof raw !== "object" || typeof raw.path !== "string") return undefined;
  const str = (v: unknown, max: number) => (typeof v === "string" && v ? v.slice(0, max) : null);
  return {
    ref: str(raw.ref, ACQ_MAX.ref) ?? "",
    path: raw.path.slice(0, ACQ_MAX.path),
    src: str(raw.src, ACQ_MAX.utm),
    med: str(raw.med, ACQ_MAX.utm),
    cmp: str(raw.cmp, ACQ_MAX.utm),
  };
}

// ------------------------------------------------------------------ page-load signals

/**
 * Keys only the game writes (not ia:acq, which the page head writes on every first visit, nor
 * the ia:exp override). Read when this module loads, before this page load can write any.
 */
const GAME_KEYS = [KEYS.canvas, KEYS.pins, KEYS.settings, KEYS.recipes, KEYS.onboarded, KEYS.merged, KEYS.libraryView, KEYS.customSort];
/** This browser already had v2 game state: a new player here means the cookie was lost, not a new visitor. */
const PRIOR_LOCAL = GAME_KEYS.some((k) => readString(k) != null);
/** document.referrer as this page load began (classified, never sent). */
const PAGE_REFERRER = (() => {
  try {
    return document.referrer;
  } catch {
    return "";
  }
})();
/** Started at load so it has answered by the time bootstrap needs it. */
const PERSISTED: Promise<boolean | undefined> = (async () => {
  try {
    return await navigator.storage?.persisted?.();
  } catch {
    return undefined;
  }
})();
/** The longest bootstrap waits for navigator.storage.persisted(). */
const PERSISTED_WAIT_MS = 50;

/**
 * Search engines by referrer host. Google only as its search hosts: docs.google.com or
 * classroom.google.com links are "other". The Android Google app refers as an android-app:// URL.
 */
const SEARCH_HOST =
  /^(?:www\.)?google\.[a-z.]{2,7}$|^com\.google\.android\.googlequicksearchbox$|(?:^|\.)bing\.com$|(?:^|\.)duckduckgo\.com$|(?:^|\.)search\.yahoo\.[a-z.]{2,7}$|^(?:www\.)?ecosia\.org$|(?:^|\.)yandex\.[a-z.]{2,7}$|^(?:www\.|m\.)?baidu\.com$|^search\.brave\.com$|^(?:www\.)?startpage\.com$|^(?:www\.)?qwant\.com$|^(?:search\.|m\.search\.)?naver\.com$|^(?:www\.)?kagi\.com$/i;

/** How this page load was reached (BootEntry), from its referrer; never the URL itself. */
export function classifyEntry(referrer: string, standalone: boolean): BootEntry {
  if (standalone) return "standalone";
  if (!referrer) return "direct";
  let host: string;
  try {
    host = new URL(referrer).hostname;
  } catch {
    return "other";
  }
  return SEARCH_HOST.test(host) ? "search" : "other";
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const now = () => (typeof performance !== "undefined" ? performance.now() : 0);

function online(): boolean | undefined {
  return typeof navigator !== "undefined" ? navigator.onLine : undefined;
}

async function bootHint(): Promise<BootstrapHint> {
  const standalone = isStandalone();
  const persisted = await Promise.race([PERSISTED, sleep(PERSISTED_WAIT_MS).then(() => undefined)]);
  let touch = false;
  try {
    touch = navigator.maxTouchPoints > 1;
  } catch {
    // no navigator
  }
  return {
    touch,
    standalone,
    wide: matches(WIDE_QUERY),
    prior: PRIOR_LOCAL,
    ...(typeof persisted === "boolean" ? { persisted } : {}),
    entry: classifyEntry(PAGE_REFERRER, standalone),
  };
}

// ------------------------------------------------------------------ boot

/** Failures worth one automatic retry: the network or the server, never a 4xx, a limit or PoW. */
const RETRYABLE: ReadonlySet<FailureCode> = new Set<FailureCode>(["network", "timeout", "server_error"]);

/**
 * Whether a failed boot attempt gets the one automatic retry: a transient failure (network,
 * timeout, 5xx) while the browser does not say it is offline. Exported for tests.
 */
export function shouldRetryBoot(e: unknown, isOnline: boolean | undefined): boolean {
  if (isOnline === false || !(e instanceof ApiFailure) || !RETRYABLE.has(e.code)) return false;
  return !(e.status >= 400 && e.status < 500);
}

/** The automatic retry waits 1.5-3 s, jittered so a classroom that failed together retries apart. */
export const retryDelayMs = (random = Math.random()): number => 1_500 + Math.round(random * 1_500);

/**
 * app_ready boot_band: navigation start to playable, as a GA dimension (boot_ms is only an
 * average there), in the bands of the server's boot_abandon stat so the two funnels line up.
 */
export const bootBand = (ms: number): string => latencyBand(ms);

/** Bootstrap attempts this page load (the automatic retry and every Try again included). */
let bootAttempts = 0;
/** Boots this page load that ended on the error screen (the next one is a manual Try again). */
let bootErrors = 0;
let booting: Promise<void> | null = null;
/** The current (or last) attempt: its phase is what the abandon beacon reports. */
let trace: BootTrace = newBootTrace();
let waitingToRetry = false;

/**
 * Start (or join) a boot: bootstrap, one automatic retry on a transient failure, then the game
 * is ready or shows the error screen. Calls while one is running share it (StrictMode mounts twice).
 */
export function bootGame(): Promise<void> {
  booting ??= runBoot().finally(() => {
    booting = null;
  });
  return booting;
}

async function runBoot(): Promise<void> {
  watchPage();
  const manual = bootErrors > 0;
  const legacy = readLegacy();
  const acq = readAcquisition();
  const day = localDay();
  let pow = false;
  useGame.setState({ status: "booting", bootError: null });
  const req: BootstrapRequest = {
    clientDate: day,
    ...(legacy ? { legacy: legacy.payload } : {}),
    ...(acq ? { acq } : {}),
    hint: await bootHint(),
  };
  const onPow = () => {
    pow = true;
    useGame.setState({ powSolving: true });
  };
  for (let retried = false; ; ) {
    bootAttempts++;
    trace = newBootTrace();
    try {
      const res = await bootstrap(req, onPow, trace);
      trace.phase = "render";
      const legacyWelcome = applyBootstrap(res, legacy, day);
      // pow: this load created the player (only creation asks for proof-of-work), so it marks a
      // brand-new player. boot_ms: navigation start to playable, PoW, retries and any time on
      // the error screen included (boot_band buckets it). pow_ms / api_ms: this attempt's PoW
      // solve and bootstrap round trips. attempt: bootstrap attempts this page load (2 is
      // normally the automatic retry); manual: started from the error screen's Try again.
      // wide: the right panel (today's challenge card) is on screen. standalone: installed app.
      const bootMs = Math.round(now());
      track("app_ready", {
        returning_legacy: !!legacyWelcome,
        elements: res.library.length,
        pow,
        boot_ms: bootMs,
        boot_band: bootBand(bootMs),
        pow_ms: Math.round(trace.powMs),
        api_ms: Math.round(trace.apiMs),
        attempt: bootAttempts,
        manual,
        wide: req.hint?.wide ?? false,
        standalone: req.hint?.standalone ?? false,
      });
      return;
    } catch (e) {
      if (!retried && shouldRetryBoot(e, online())) {
        // Keep the boot pill up ("Setting up your lab" for a new player) instead of the error card.
        retried = true;
        waitingToRetry = true;
        await sleep(retryDelayMs());
        waitingToRetry = false;
        continue;
      }
      const code = e instanceof ApiFailure ? e.code : "network";
      bootErrors++;
      useGame.setState({ status: "error", powSolving: false, bootError: code });
      // phase: where the attempt failed; status: HTTP status (0 = no response); visible: the tab
      // was on screen (false: a reload or tab close aborts the fetch, which also reads as
      // "network"); online: navigator.onLine. Both booleans.
      track("load_failed", {
        code,
        phase: trace.phase,
        status: e instanceof ApiFailure ? e.status : 0,
        attempt: bootAttempts,
        manual,
        visible: typeof document !== "undefined" && document.visibilityState === "visible",
        online: online() !== false,
      });
      return;
    }
  }
}

/** Fold a successful bootstrap into state; returns the legacy welcome it set (if any). */
function applyBootstrap(res: BootstrapResponse, legacy: LegacyState | null, day: string): GameState["legacyWelcome"] {
  let legacyWelcome: GameState["legacyWelcome"] = null;
  if (legacy && res.legacyImport) {
    markLegacyImported(legacy.marker);
    const { adopted, imported, claimed } = res.legacyImport;
    if (claimed) {
      legacyWelcome = { restored: imported, claimedElsewhere: true };
    } else if (adopted || imported > 0) {
      legacyWelcome = { restored: adopted ? res.library.filter((e) => !e.starter).length : imported };
    }
  }
  const owned: Record<ElementId, Owned> = {};
  for (const e of res.library) owned[e.id] = { discoveredAt: e.discoveredAt, first: e.first };
  const elements = withElements({}, [
    ...res.library,
    ...(res.challenge?.targets.map((t) => t.element) ?? []),
    ...res.recent,
  ]);
  useGame.setState({
    status: "ready",
    powSolving: false,
    player: res.player,
    elements,
    owned,
    stats: res.stats,
    challenge: res.challenge,
    history: res.history,
    recent: res.recent.map((e) => e.id),
    day,
    tomorrow: res.tomorrow ?? null,
    legacyWelcome,
  });
  // GA only runs on the production host, where arm overrides are off, so the plain arms are right.
  identify(res.player.id, { legacy: res.player.legacy, experiments: experimentUserProperties(res.player.id) });
  return legacyWelcome;
}

// ------------------------------------------------------------------ page lifecycle

let watching = false;
/** GA boot_abandon went out (once per page). */
let abandonTracked = false;
/** The abandon beacon this page sent and has not taken back: it is hidden, or gone. */
let abandonPending: BootBeacon | null = null;

function watchPage(): void {
  if (watching || typeof document === "undefined") return;
  watching = true;
  addEventListener("pagehide", reportAbandon);
  // Back/forward cache: a page left (pagehide) and then restored is back too.
  addEventListener("pageshow", (e) => {
    if ((e as PageTransitionEvent).persisted) reportResume();
  });
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden") {
      reportAbandon();
    } else {
      reportResume();
      void refreshIfNewDay();
    }
  });
}

/**
 * The page is going away (or hidden, the last event mobile browsers reliably fire) before the
 * game was playable: send the abandon beacon (first-party, so it arrives even when GA never
 * loaded or is blocked) and, once per page, GA boot_abandon. Hidden and then closed (pagehide
 * follows) is one abandon; a page that comes back takes its beacon back (reportResume) and a
 * later exit sends a new one. GA can't be taken back: dedupe it against app_ready instead.
 */
function reportAbandon(): void {
  const { status } = useGame.getState();
  if (abandonPending || status === "ready") return;
  const phase: BootPhase = status === "error" ? "error" : waitingToRetry ? "wait" : trace.phase;
  const body: BootBeacon = { phase, ms: Math.round(now()) };
  // Only a queued beacon can be taken back (a browser without sendBeacon sends neither).
  if (sendBootBeacon(body)) abandonPending = body;
  if (abandonTracked) return;
  abandonTracked = true;
  // boot_ms: as app_ready's (navigation start until now), so the two share one GA metric.
  track("boot_abandon", { phase, boot_ms: body.ms });
}

/**
 * The page is visible again after its abandon beacon (a tab switch mid-boot, a restored page),
 * whether or not the boot finished meanwhile: take that abandon back with the same phase and ms,
 * so boot_abandon minus boot_resumed counts only the pages that really ended before ready.
 */
function reportResume(): void {
  const body = abandonPending;
  if (!body) return;
  abandonPending = null;
  sendBootBeacon({ ...body, resumed: true });
}

let refreshing = false;

/**
 * A tab left open overnight comes back on a new local day: fetch the new day's challenge (and
 * stats, history, teaser) silently, with no boot overlay. Uses a fresh bootstrap that never
 * solves PoW, so it can't create a player; any failure keeps what is on screen (the next combine
 * still offers a reload).
 */
export async function refreshIfNewDay(): Promise<void> {
  const s = useGame.getState();
  const day = localDay();
  if (s.status !== "ready" || !s.player || refreshing || day === s.day) return;
  refreshing = true;
  try {
    const res = await refreshBootstrap({ clientDate: day });
    useGame.setState((cur) => {
      if (cur.status !== "ready" || res.player.id !== cur.player?.id) return cur;
      // Keep the library as it is (combines keep it current); add what another device found.
      const added = res.library.filter((e) => !cur.owned[e.id]);
      const owned = added.length > 0 ? { ...cur.owned } : cur.owned;
      for (const e of added) owned[e.id] = { discoveredAt: e.discoveredAt, first: e.first };
      return {
        elements: withElements(cur.elements, [...res.library, ...(res.challenge?.targets.map((t) => t.element) ?? []), ...res.recent]),
        owned,
        stats: res.stats,
        challenge: res.challenge,
        history: res.history,
        recent: res.recent.map((e) => e.id),
        day,
        tomorrow: res.tomorrow ?? null,
      };
    });
  } catch {
    // Silent: yesterday's challenge stays until a reload.
  } finally {
    refreshing = false;
  }
}

export function setElementArt(id: ElementId, art: ElementDTO["art"], img: string | null): void {
  useGame.setState((s) => {
    const prev = s.elements[id];
    if (!prev || (prev.art === art && prev.img === img)) return s;
    return { elements: { ...s.elements, [id]: { ...prev, art, img } } };
  });
}

/** Elements discovered moments ago in this session: their library tile arrives with a pop. */
const freshUntil = new Map<ElementId, number>();
const FRESH_MS = 3_000;

export function isFresh(id: ElementId): boolean {
  return (freshUntil.get(id) ?? 0) > Date.now();
}

/** Fold a combine response into local state (library, stats, challenge, history). */
export function applyCombine(res: CombineResponse): void {
  if (res.newForPlayer) freshUntil.set(res.result.id, Date.now() + FRESH_MS);
  useGame.setState((s) => {
    const id = res.result.id;
    const elements = withElements(s.elements, [res.entry ?? res.result]);
    let { owned, stats, challenge, history } = s;
    if (res.newForPlayer && !owned[id]) {
      owned = { ...owned, [id]: { discoveredAt: res.entry?.discoveredAt ?? new Date().toISOString(), first: res.entry?.first ?? res.firstEver } };
      stats = {
        ...stats,
        mine: stats.mine + 1,
        firsts: stats.firsts + (res.firstEver ? 1 : 0),
        known: stats.known + (res.firstEver ? 1 : 0),
      };
    }
    if (res.completed.length > 0 && challenge) {
      const hadAny = challenge.targets.some((t) => t.completed);
      challenge = {
        ...challenge,
        targets: challenge.targets.map((t) => (res.completed.includes(t.tier) ? { ...t, completed: true } : t)),
      };
      const current = hadAny ? stats.streak.current : stats.streak.current + 1;
      stats = {
        ...stats,
        challengesCompleted: stats.challengesCompleted + res.completed.length,
        streak: { current, best: Math.max(stats.streak.best, current) },
      };
      const completed = challenge.targets.filter((t) => t.completed).map((t) => t.tier);
      const names = Object.fromEntries(challenge.targets.map((t) => [t.tier, t.element.name])) as Record<Tier, string>;
      const today: ChallengeHistoryDay = { day: challenge.day, completed, names };
      history = [today, ...history.filter((h) => h.day !== challenge!.day)];
    }
    return { elements, owned, stats, challenge, history };
  });
}

/** After a successful server reset: the library goes back to the starters. */
export function resetLibraryLocal(): void {
  useGame.setState((s) => {
    const owned: Record<ElementId, Owned> = {};
    for (const [id, o] of Object.entries(s.owned)) if (s.elements[id]?.starter) owned[id] = o;
    return { owned, stats: { ...s.stats, mine: Object.keys(owned).length } };
  });
}

/** Open (not yet completed) challenge targets by element id. */
export function openTargetIds(s: GameState = useGame.getState()): Set<ElementId> {
  return new Set(s.challenge?.targets.filter((t) => !t.completed).map((t) => t.element.id) ?? []);
}
