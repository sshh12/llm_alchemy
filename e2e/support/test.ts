// The `test` every spec imports: Playwright's test plus the game page object, the seeded
// fixtures, device capability flags, a screenshot helper, and a guard that fails a test on
// uncaught page errors.
import fs from "node:fs";
import path from "node:path";
import { test as base, expect, type Page, type TestInfo } from "@playwright/test";
import { ARTIFACTS_PATH, projectIndex } from "./env.ts";
import { loadFixtures, type Fixtures } from "./fixtures.ts";
import { Game, type Device } from "./game.ts";

export { expect };

export function slug(s: string): string {
  return s
    .toLowerCase()
    .replace(/@\w+/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
}

/** Screenshot to e2e/.artifacts/screens/<project>/<test>[--<step>].png and attach it to the report. */
export async function snapshot(page: Page, testInfo: TestInfo, step?: string): Promise<string> {
  const base = slug(testInfo.title);
  const file = path.join(ARTIFACTS_PATH, "screens", testInfo.project.name, `${base}${step ? `--${slug(step)}` : ""}.png`);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  await page.screenshot({ path: file });
  await testInfo.attach(step ?? base, { path: file, contentType: "image/png" });
  return file;
}

export function deviceFor(testInfo: TestInfo): Device {
  const use = testInfo.project.use;
  const engine = (use.browserName ?? "chromium") as Device["engine"];
  return {
    project: testInfo.project.name,
    index: projectIndex(testInfo.project.name),
    touch: engine === "chromium" && !!use.hasTouch,
    engine,
  };
}

interface Fx {
  fx: Fixtures;
  device: Device;
  game: Game;
  snap: (step?: string) => Promise<string>;
  pageErrors: string[];
}

export const test = base.extend<Fx>({
  fx: async ({}, use) => {
    await use(loadFixtures());
  },
  device: async ({}, use, testInfo) => {
    await use(deviceFor(testInfo));
  },
  // Uncaught exceptions in the app fail the test (auto fixture, checked after the body).
  pageErrors: [
    async ({ page }, use) => {
      const errors: string[] = [];
      page.on("pageerror", (e) => errors.push(e.stack ?? e.message));
      await use(errors);
      expect(errors, "uncaught errors in the page").toEqual([]);
    },
    { auto: true },
  ],
  game: async ({ page, device }, use) => {
    await use(new Game(page, device));
  },
  snap: async ({ page }, use, testInfo) => {
    await use((step) => snapshot(page, testInfo, step));
  },
});
