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

// ------------------------------------------------------------------ goals ladder (experiment goals)

/**
 * Library-size goals: these rungs, then every 250. Day-0 return rates are flat below ~80
 * discoveries and climb from there, so the ladder is weighted toward 100 and up rather than
 * stepping through the flat region (docs/ARCHITECTURE.md "Experiments").
 */
export const MILESTONES = [25, 50, 100, 150, 250, 500] as const;
const STEP_AFTER = 250;
const LAST = MILESTONES[MILESTONES.length - 1]!;

/** The next goal above `n` (a library of exactly 50 is working toward 100). */
export function nextMilestone(n: number): number {
  for (const r of MILESTONES) if (n < r) return r;
  return LAST + (Math.floor((n - LAST) / STEP_AFTER) + 1) * STEP_AFTER;
}

/** The highest goal at or below `n` (0 below the first rung). */
export function prevMilestone(n: number): number {
  if (n < MILESTONES[0]) return 0;
  if (n >= LAST) return LAST + Math.floor((n - LAST) / STEP_AFTER) * STEP_AFTER;
  let out = 0;
  for (const r of MILESTONES) if (n >= r) out = r;
  return out;
}

/** The highest rung crossed going from `before` to `after` elements, or null (none, or not an increase). */
export function milestoneReached(before: number, after: number): number | null {
  if (!(after > before)) return null;
  const r = prevMilestone(after);
  return r > before ? r : null;
}

/** "47/50": the library toward its next goal. */
export const formatGoal = (n: number) => `${formatCount(n)}/${formatCount(nextMilestone(n))}`;

/** Progress from the last goal reached to the next one, in [0, 1). */
export function goalProgress(n: number): number {
  const lo = prevMilestone(n);
  const hi = nextMilestone(n);
  return Math.min(1, Math.max(0, (n - lo) / (hi - lo)));
}

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
