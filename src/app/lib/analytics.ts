// Optional Google Analytics events (gtag is installed by the page head when configured).
// Params stay compact and bounded: never element names or other generated text.
// What each event counts: docs/ARCHITECTURE.md "Analytics".
export type EventName =
  | "app_ready"
  | "load_failed"
  | "combine"
  // A combine the server refused or could not answer (code: the ApiFailure code, or "network").
  | "combine_failed"
  | "first_combine"
  | "discovery"
  | "first_discovery"
  | "challenge_complete"
  | "share"
  // Custom library sort applied or activated (kind, group count, from = where it was picked,
  // library size bucket, cached, outcome). Never the prompt or group text.
  | "custom_sort"
  // First-run welcome sheet: action = shown | start | dismiss | link (target), secs = time open.
  | "onboarding"
  // First tile placed on the workbench this session: via = tap | drag.
  | "first_tile"
  // A sheet opened: sheet = challenges | stats | settings | about | customSort.
  | "sheet_open"
  // The page was hidden or left before the game was playable (once per page): phase (BootPhase),
  // boot_ms since navigation start (as app_ready's). Arrives only if gtag loaded; the
  // first-party /api/beacon counts every one, and takes it back when the page comes back.
  | "boot_abandon"
  // "Report this element" sent from the details menu (reason).
  | "report"
  // Wave-2 product events (names reserved here so feature code never edits this list):
  | "milestone"
  | "celebration"
  | "wf_followup"
  | "idle_card"
  | "install_eligible"
  | "install_prompt"
  | "install"
  | "coach";

export type EventParams = Record<string, string | number | boolean>;

type Gtag = (command: "event" | "set", ...args: unknown[]) => void;

function gtag(): Gtag | undefined {
  return (window as Window & { gtag?: Gtag }).gtag;
}

/**
 * Event param names GA4 does not treat as plain event data: traffic-source fields (an event
 * param named `source` re-attributes the session to that "source"), page and identity fields,
 * and Google's reserved prefixes. track() drops them so a param name can never corrupt reports.
 */
const RESERVED_PARAM = /^(?:source|medium|campaign|term|content|campaign_\w*|page_\w*|user_id|client_id|session_id|(?:ga|google|firebase|gtm)_\w*)$/i;

/** `params` without GA4-reserved names (see RESERVED_PARAM). Exported for tests. */
export function safeParams(params?: EventParams): EventParams | undefined {
  if (!params) return undefined;
  const out: EventParams = {};
  for (const [k, v] of Object.entries(params)) {
    if (RESERVED_PARAM.test(k)) {
      if (import.meta.env?.DEV) console.warn(`[analytics] dropped reserved param "${k}"; rename it`);
      continue;
    }
    out[k] = v;
  }
  return out;
}

export function track(name: EventName, params?: EventParams): void {
  try {
    gtag()?.("event", name, safeParams(params));
  } catch {
    // Analytics must never affect gameplay.
  }
}

/** `track`, at most once per browser session (e.g. the first successful combine = activation). */
export function trackOncePerSession(name: EventName, params?: EventParams): void {
  try {
    const key = `ia:tracked:${name}`;
    if (sessionStorage.getItem(key)) return;
    sessionStorage.setItem(key, "1");
  } catch {
    // Storage unavailable: still send it.
  }
  track(name, params);
}

/** identify() has run this page load. */
let identified = false;
const waiting: (() => void)[] = [];

/**
 * Run `send` once identify() has run this page load (now, if it has): for an event that can fire
 * before bootstrap but must carry user_id and the experiment user properties (install_eligible).
 * Never sent when the boot never succeeds.
 */
export function afterIdentify(send: () => void): void {
  if (identified) send();
  else waiting.push(send);
}

/**
 * Tie this browser's GA events to the player: `user_id` is the player's random public id (the
 * same id the database has as players.public_id, so GA exports join to server data; no PII).
 * Call before the session's first event so every event carries it. `experiments`: the player's
 * arms as user properties (exp_first_run, ...; src/shared/experiments.ts).
 */
export function identify(playerPublicId: string, props: { legacy: boolean; experiments?: Record<string, string> }): void {
  try {
    const g = gtag();
    g?.("set", { user_id: playerPublicId });
    g?.("set", "user_properties", { legacy_player: props.legacy, ...props.experiments });
  } catch {
    // Analytics must never affect gameplay.
  }
  identified = true;
  for (const send of waiting.splice(0)) {
    try {
      send();
    } catch {
      // Analytics must never affect gameplay.
    }
  }
}
