// Randomized product experiments, assigned by player (docs/ARCHITECTURE.md "Experiments").
// The arm is a pure function of players.public_id (a random UUID), so the client, the server
// and the analytics snapshot (scripts/analytics/snapshot.ts EXPERIMENTS) agree without storing
// anything: the parity of one hex digit, a different digit per experiment so arms are
// independent. Odd = treatment. The digits sit in the UUID's random tail (v4 UUIDs fix only
// the version nibble at 14 and the variant nibble at 19).

export type Arm = "treatment" | "control";

interface Experiment {
  /** 0-based index into the 36-character UUID string. */
  digit: number;
  /** false: everyone is control (switch an experiment off without moving anyone's arm). */
  enabled: boolean;
}

export type ExperimentName = "firstRun" | "idleCard" | "goals";

export const EXPERIMENTS: Record<ExperimentName, Experiment> = {
  /** Bet A: seeded first-run board and the non-blocking welcome. */
  firstRun: { digit: 35, enabled: true },
  /** The once-a-day "Today in your lab" idle card. */
  idleCard: { digit: 34, enabled: true },
  /** The goals ladder. */
  goals: { digit: 33, enabled: true },
};

export const EXPERIMENT_NAMES = Object.keys(EXPERIMENTS) as ExperimentName[];

/**
 * The arm of `publicId` in experiment `name`: treatment when the hex digit at 0-based index
 * `digit` of the UUID string is odd. A disabled experiment, a missing id or a character that is
 * not a hex digit (a malformed id) is control, so nothing changes for anyone by accident.
 */
export function armFor(publicId: string | null | undefined, name: ExperimentName): Arm {
  const exp = EXPERIMENTS[name];
  if (!exp.enabled || !publicId) return "control";
  const ch = publicId.charAt(exp.digit);
  if (!/^[0-9a-f]$/i.test(ch)) return "control";
  return Number.parseInt(ch, 16) % 2 === 1 ? "treatment" : "control";
}

/** GA user property name for an experiment: firstRun -> exp_first_run. */
export const experimentProperty = (name: ExperimentName): string =>
  `exp_${name.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`)}`;

/** Every experiment's arm as GA user properties (exp_first_run, exp_idle_card, exp_goals). */
export function experimentUserProperties(publicId: string | null | undefined): Record<string, Arm> {
  return Object.fromEntries(EXPERIMENT_NAMES.map((n) => [experimentProperty(n), armFor(publicId, n)]));
}
