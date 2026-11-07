// Runs once per `playwright test`, after the webServer (netlify dev) is up:
//  1. reset the alchemy_e2e world with the db engineer's seed (which also writes e2e/fixtures.json);
//  2. prove the running server uses the e2e env before any test creates players or recipes.
import { spawnSync } from "node:child_process";
import type { FullConfig } from "@playwright/test";
import { E2E_ENV, E2E_POW_BITS, E2E_SCHEMA, REPO_ROOT } from "./support/env.ts";
import { loadFixtures } from "./support/fixtures.ts";
import { bootstrapNewPlayer, powChallenge } from "./support/node-api.ts";

/** The production world has ~54k active elements; the seeded e2e world is tiny. */
const MAX_E2E_WORLD = 2_000;

export default async function globalSetup(config: FullConfig): Promise<void> {
  if (process.env.DB_SCHEMA && process.env.DB_SCHEMA !== E2E_SCHEMA) {
    throw new Error(`Refusing to run E2E with DB_SCHEMA=${process.env.DB_SCHEMA}; tests only use ${E2E_SCHEMA}`);
  }

  if (!process.env.E2E_SKIP_SEED) {
    const seed = spawnSync("npm run db:seed-e2e", {
      cwd: REPO_ROOT,
      env: { ...process.env, ...E2E_ENV },
      stdio: "inherit",
      shell: true,
    });
    if (seed.status !== 0) throw new Error(`npm run db:seed-e2e failed (exit ${seed.status})`);
  }
  loadFixtures(); // validates the contract early with a readable error

  const baseURL = config.projects[0]?.use.baseURL;
  if (!baseURL) throw new Error("No baseURL configured");
  const challenge = await powChallenge(baseURL);
  if (challenge.pow!.bits !== E2E_POW_BITS) {
    throw new Error(
      `The server at ${baseURL} asks for ${challenge.pow!.bits}-bit PoW, not ${E2E_POW_BITS}: it is not running the E2E env ` +
        `(${JSON.stringify(E2E_ENV)}). Stop it, or unset E2E_REUSE_SERVER so Playwright starts its own.`,
    );
  }
  const boot = await bootstrapNewPlayer(baseURL, challenge);
  if (boot.stats.known > MAX_E2E_WORLD) {
    throw new Error(`The server reports ${boot.stats.known} known elements: that is not the seeded ${E2E_SCHEMA} world. Aborting.`);
  }
}
