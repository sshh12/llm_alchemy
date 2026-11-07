// Optional Google Analytics events (gtag is installed by the page head when configured).
// Params stay compact and bounded: never element names or other generated text.
type EventName =
  | "app_ready"
  | "load_failed"
  | "combine"
  | "first_combine"
  | "discovery"
  | "first_discovery"
  | "challenge_complete"
  | "share"
  // Custom library sort applied or activated (kind, group count, source, library size bucket,
  // cached, outcome). Never the prompt or group text.
  | "custom_sort";

type Gtag = (command: "event", name: string, params?: Record<string, unknown>) => void;

export function track(name: EventName, params?: Record<string, string | number | boolean>): void {
  try {
    (window as Window & { gtag?: Gtag }).gtag?.("event", name, params);
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
