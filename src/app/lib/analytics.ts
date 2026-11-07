// Optional Google Analytics events (gtag is installed by the page head when configured).
// Only these four product events are sent.
type EventName = "combine" | "discovery" | "first_discovery" | "challenge_complete";

type Gtag = (command: "event", name: string, params?: Record<string, unknown>) => void;

export function track(name: EventName, params?: Record<string, string | number | boolean>): void {
  try {
    (window as Window & { gtag?: Gtag }).gtag?.("event", name, params);
  } catch {
    // Analytics must never affect gameplay.
  }
}
