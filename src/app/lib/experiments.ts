// Client side of src/shared/experiments.ts: the current player's arm, with an override for e2e
// and dev. `arm(name)` is control until bootstrap has named the player, so read it after the
// game is ready (or re-read it when useGame's player changes). `earlyArm(name)` is for the rare
// decision that can't wait for bootstrap (Chrome's install prompt).
import { EXPERIMENTS, EXPERIMENT_NAMES, armFor, type Arm, type ExperimentName } from "../../shared/experiments.ts";
import { useGame } from "../state/game.ts";
import { KEYS, readJSON, writeJSON } from "./storage.ts";

/** Overrides are never honored here, so production players always get their assigned arm. */
export const PRODUCTION_HOST = "alchemy.sshh.io";

export type ArmOverrides = Partial<Record<ExperimentName, Arm>>;

/**
 * Overrides from localStorage "ia:exp" (e.g. {"firstRun":"treatment"}), off the production host
 * only. Unknown names and values are ignored.
 */
export function readOverrides(host: string, raw: unknown): ArmOverrides {
  if (host === PRODUCTION_HOST || !raw || typeof raw !== "object") return {};
  const out: ArmOverrides = {};
  for (const name of EXPERIMENT_NAMES) {
    const v = (raw as Record<string, unknown>)[name];
    if (v === "treatment" || v === "control") out[name] = v;
  }
  return out;
}

/** The arm for `publicId`, unless an override names one. */
export function armOf(name: ExperimentName, publicId: string | null | undefined, overrides: ArmOverrides = {}): Arm {
  return overrides[name] ?? armFor(publicId, name);
}

function currentHost(): string {
  try {
    return location.hostname;
  } catch {
    return PRODUCTION_HOST; // no location (tests, workers): behave like production
  }
}

/** The current player's arm in experiment `name` (control before bootstrap, unless overridden). */
export function arm(name: ExperimentName): Arm {
  return armOf(name, useGame.getState().player?.id, readOverrides(currentHost(), readJSON<unknown>(KEYS.exp, null)));
}

/**
 * `arm(name)`, or before bootstrap has named the player, the arm of the last player this browser
 * booted as (KEYS.arms). For a decision that can't wait: Chrome fires beforeinstallprompt for a
 * returning visitor before bootstrap answers, and control's default would already have let the
 * browser show its own install bar. Wrong only for a browser that switched player (until
 * bootstrap answers) and control for one that never booted; overrides still win.
 */
export function earlyArm(name: ExperimentName): Arm {
  if (useGame.getState().player) return arm(name);
  const override = readOverrides(currentHost(), readJSON<unknown>(KEYS.exp, null))[name];
  if (override) return override;
  const cached = readJSON<Record<string, unknown> | null>(KEYS.arms, null);
  return EXPERIMENTS[name].enabled && cached?.[name] === "treatment" ? "treatment" : "control";
}

// Remember each player's arms (never the id) for earlyArm on this browser's next page load.
useGame.subscribe((s, prev) => {
  const id = s.player?.id;
  if (!id || id === prev.player?.id) return;
  writeJSON(KEYS.arms, Object.fromEntries(EXPERIMENT_NAMES.map((n) => [n, armFor(id, n)])));
});
