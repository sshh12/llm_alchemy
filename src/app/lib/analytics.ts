// Optional Google Analytics events (gtag is installed by the page head when configured).
// Params stay compact and bounded: never element names or other generated text.
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
  // Custom library sort applied or activated (kind, group count, source, library size bucket,
  // cached, outcome). Never the prompt or group text.
  | "custom_sort";

type Gtag = (command: "event" | "set", ...args: unknown[]) => void;

function gtag(): Gtag | undefined {
  return (window as Window & { gtag?: Gtag }).gtag;
}

export function track(name: EventName, params?: Record<string, string | number | boolean>): void {
  try {
    gtag()?.("event", name, params);
  } catch {
    // Analytics must never affect gameplay.
  }
}

/** `track`, at most once per browser session (e.g. the first successful combine = activation). */
export function trackOncePerSession(name: EventName, params?: Record<string, string | number | boolean>): void {
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
