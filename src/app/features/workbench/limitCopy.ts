// What a player reads when a combine is rate limited (pure, so it is unit-tested).
//
// Short waits count down in the toast. Long ones (the hourly and daily rules can mean hours,
// e.g. llm.player.day resets at 00:00 UTC) name the moment they end in the player's own time zone
// and clock format instead of a "35000s" countdown. The llm.* rules only pace brand-new mixes (each
// one asks the AI); mixes someone has made before still answer, so the copy says so.

/** Waits up to this long count down; longer ones say when they end. */
export const COUNTDOWN_MAX_MS = 2 * 60_000;

export interface LimitCopy {
  text: string;
  /** Countdown end, for short waits only. */
  until?: number;
  /** For screen readers: the whole message, wait included. */
  spoken: string;
}

const startOfDay = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();

/**
 * When `at` is, as a phrase in the viewer's local time: "at 4:00 PM", "tomorrow at 4:00 PM" or
 * "on Saturday at 4:00 PM". `locale` undefined = the browser's locale (12 or 24 h as they use).
 */
export function localWhen(at: number, now: number = Date.now(), locale?: string): string {
  const end = new Date(at);
  const time = end.toLocaleTimeString(locale, { hour: "numeric", minute: "2-digit" });
  // Round, not floor: a day across a DST change is 23 or 25 hours.
  const days = Math.round((startOfDay(end) - startOfDay(new Date(now))) / 86_400_000);
  if (days <= 0) return `at ${time}`;
  if (days === 1) return `tomorrow at ${time}`;
  return `on ${end.toLocaleDateString(locale, { weekday: "long" })} at ${time}`;
}

/** The toast for a rate-limited combine. `limit` is the rule the server named ("platform" for a bare 429). */
export function rateLimitCopy(retryAfterMs: number | undefined, limit: string | undefined, now: number = Date.now(), locale?: string): LimitCopy {
  const ms = Math.max(3_000, retryAfterMs ?? 20_000);
  const newIdeas = !!limit?.startsWith("llm.");
  if (ms > COUNTDOWN_MAX_MS) {
    const when = localWhen(now + ms, now, locale);
    const text = newIdeas
      ? `You've invented a lot! Brand-new mixes are back ${when}. Mixes someone has made before still work.`
      : `Easy there, alchemist. You can mix again ${when}.`;
    return { text, spoken: text };
  }
  const text = newIdeas
    ? "New ideas are cooling down. Mixes someone has made before still work. Try a new one in"
    : "Easy there, alchemist. Try again in";
  return { text, until: now + ms, spoken: `${text} ${Math.ceil(ms / 1000)} seconds.` };
}
