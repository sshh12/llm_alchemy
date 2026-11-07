// Calendar-day helpers. A "day" is the player's local calendar date ('YYYY-MM-DD').
// The server accepts a client day only if it is plausible for some timezone
// (UTC-12 .. UTC+14) at the current instant.

export function localDay(d: Date = new Date()): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

export function utcDay(d: Date = new Date()): string {
  return d.toISOString().slice(0, 10);
}

export function addDays(day: string, n: number): string {
  const t = Date.parse(`${day}T00:00:00Z`) + n * 86_400_000;
  return new Date(t).toISOString().slice(0, 10);
}

export function isDay(s: unknown): s is string {
  return typeof s === "string" && /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(Date.parse(`${s}T00:00:00Z`));
}

/** Is `day` a valid local date somewhere on Earth right now? */
export function isPlausibleClientDay(day: string, now: Date = new Date()): boolean {
  if (!isDay(day)) return false;
  const earliest = utcDay(new Date(now.getTime() - 12 * 3_600_000));
  const latest = utcDay(new Date(now.getTime() + 14 * 3_600_000));
  return day >= earliest && day <= latest;
}

/** The first day served by the new challenge generator (everything before is legacy history). */
export const CHALLENGE_CUTOVER_DAY = "2026-11-06";
export const CHALLENGE_GENERATE_YEARS = 5;
