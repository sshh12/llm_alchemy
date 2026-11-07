// Constants shared by playwright.config.ts, global setup and the specs.
import path from "node:path";
import { fileURLToPath } from "node:url";

export const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
export const ARTIFACTS_DIR = "e2e/.artifacts";
export const ARTIFACTS_PATH = path.join(REPO_ROOT, ARTIFACTS_DIR);
export const FIXTURES_PATH = path.join(REPO_ROOT, "e2e", "fixtures.json");

/** netlify dev port used by every spec except the legacy journey (which runs its own origin). */
export const E2E_PORT = 8888;
export const E2E_SCHEMA = "alchemy_e2e";
export const E2E_POW_BITS = 8;

/** Environment the app server must run with during E2E. Never the production schema. */
export const E2E_ENV = {
  AI_MODE: "mock",
  DB_SCHEMA: E2E_SCHEMA,
  POW_BITS: String(E2E_POW_BITS),
  // A full run creates ~60 players from one IP; production keeps the default of 60/hour.
  CREATE_IP_HOURLY: "1000",
} as const;

/**
 * Project names in a fixed order. A project's index picks the per-device resources it may
 * consume (unknown combos, legacy users, ports) so parallel projects never collide.
 */
export const PROJECTS = ["desktop-chrome", "pixel-7", "iphone-15", "ipad", "webkit-iphone"] as const;
export type ProjectName = (typeof PROJECTS)[number];

export function projectIndex(name: string): number {
  const i = PROJECTS.indexOf(name as ProjectName);
  if (i < 0) throw new Error(`Unknown Playwright project ${name}; add it to PROJECTS in e2e/support/env.ts`);
  return i;
}
