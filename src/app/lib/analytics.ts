// Optional Google Analytics events (gtag is installed by the page head when configured).
// Params stay compact and bounded: never element names or other generated text.
// What each event counts: docs/ARCHITECTURE.md "Analytics".
type EventName =
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
  | "sheet_open";

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

/**
 * Tie this browser's GA events to the player: `user_id` is the player's random public id (the
 * same id the database has as players.public_id, so GA exports join to server data; no PII).
 * Call before the session's first event so every event carries it.
 */
export function identify(playerPublicId: string, props: { legacy: boolean }): void {
  try {
    const g = gtag();
    g?.("set", { user_id: playerPublicId });
    g?.("set", "user_properties", { legacy_player: props.legacy });
  } catch {
    // Analytics must never affect gameplay.
  }
}
