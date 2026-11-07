// Playwright E2E config. The suite drives the real stack (netlify dev = Vite SPA + Functions)
// against the isolated `alchemy_e2e` schema with mock AI. See e2e/README.md.
import { defineConfig, devices } from "@playwright/test";
import { E2E_ENV, E2E_PORT, ARTIFACTS_DIR } from "./e2e/support/env.ts";

const iPhone15 = devices["iPhone 15"];
const iPad = devices["iPad (gen 7)"];
// The descriptor carries `screen` at runtime but its type does not; same values as Playwright's registry.
const IPHONE_15_SCREEN = { width: 393, height: 852 };

export default defineConfig({
  testDir: "./e2e",
  testMatch: /.*\.spec\.ts$/,
  outputDir: `${ARTIFACTS_DIR}/test-results`,
  globalSetup: "./e2e/global-setup.ts",
  // Each test is a fresh anonymous player, so files can run in parallel. The backend talks to a
  // remote CockroachDB cluster, so keep concurrency modest to avoid timing noise.
  fullyParallel: true,
  workers: process.env.E2E_WORKERS ? Number(process.env.E2E_WORKERS) : 3,
  // Retries would re-run "first discovery" tests against a world where the discovery already
  // happened; keep them off so failures stay honest.
  retries: 0,
  forbidOnly: !!process.env.CI,
  timeout: 90_000,
  expect: { timeout: 12_000 },
  reporter: [
    ["list"],
    ["html", { outputFolder: `${ARTIFACTS_DIR}/report`, open: "never" }],
    ["json", { outputFile: `${ARTIFACTS_DIR}/results.json` }],
  ],
  use: {
    baseURL: `http://localhost:${E2E_PORT}`,
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    actionTimeout: 12_000,
    navigationTimeout: 30_000,
  },
  webServer: {
    command: `npx -y netlify-cli@27.16.2 dev --port ${E2E_PORT}`,
    url: `http://localhost:${E2E_PORT}/`,
    env: { ...E2E_ENV, BROWSER: "none" },
    // Reusing a server you started yourself is opt-in; global-setup verifies it runs the e2e env.
    reuseExistingServer: !!process.env.E2E_REUSE_SERVER,
    timeout: 180_000,
    stdout: "pipe",
    stderr: "pipe",
  },
  projects: [
    {
      name: "desktop-chrome",
      use: { browserName: "chromium", viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 },
    },
    {
      name: "pixel-7",
      use: { ...devices["Pixel 7"], browserName: "chromium" },
    },
    {
      // Chromium with the iPhone 15 metrics: WebKit on Windows cannot emulate touch.
      name: "iphone-15",
      use: {
        browserName: "chromium",
        viewport: iPhone15.viewport,
        screen: IPHONE_15_SCREEN,
        deviceScaleFactor: iPhone15.deviceScaleFactor,
        userAgent: iPhone15.userAgent,
        isMobile: true,
        hasTouch: true,
      },
    },
    {
      name: "ipad",
      use: {
        browserName: "chromium",
        viewport: iPad.viewport,
        deviceScaleFactor: iPad.deviceScaleFactor,
        userAgent: iPad.userAgent,
        isMobile: true,
        hasTouch: true,
      },
    },
    {
      // Real WebKit for layout/screenshot checks only (no touch emulation available here).
      name: "webkit-iphone",
      grep: /@layout/,
      use: {
        browserName: "webkit",
        viewport: iPhone15.viewport,
        screen: IPHONE_15_SCREEN,
        deviceScaleFactor: iPhone15.deviceScaleFactor,
        userAgent: iPhone15.userAgent,
        isMobile: false,
        hasTouch: false,
      },
    },
  ],
});
