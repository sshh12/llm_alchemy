// Display formatting helpers.

/** Share of all known elements, one decimal, with a "<0.1%" floor (never rounds up to 1%). */
export function formatPercent(mine: number, known: number): string {
  if (known <= 0 || mine <= 0) return "0%";
  const pct = (mine / known) * 100;
  if (pct < 0.1) return "<0.1%";
  if (pct >= 100) return "100%";
  return `${(Math.floor(pct * 10) / 10).toFixed(1)}%`;
}

const nf = new Intl.NumberFormat("en-US");
export const formatCount = (n: number) => nf.format(n);

/** "5h 12m", "12m", "45s" until `target`. */
export function formatCountdown(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m`;
  return `${s}s`;
}

/** Milliseconds until the next local midnight. */
export function msUntilLocalMidnight(now: Date = new Date()): number {
  const next = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1);
  return next.getTime() - now.getTime();
}

/** "Nov 6, 2026" for a 'YYYY-MM-DD' day or an ISO timestamp. */
export function formatDay(dayOrIso: string): string {
  const d = /^\d{4}-\d{2}-\d{2}$/.test(dayOrIso) ? new Date(`${dayOrIso}T12:00:00`) : new Date(dayOrIso);
  if (Number.isNaN(d.getTime())) return dayOrIso;
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
}

/** Instrument Sans width step for a tile label, by length (condense long names). */
export function labelLength(name: string): "s" | "m" | "l" {
  const n = [...name].length;
  return n <= 10 ? "s" : n <= 15 ? "m" : "l";
}
