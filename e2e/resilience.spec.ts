// (10) Abuse/cost defenses seen from the player's side: rate limits and an exhausted daily AI
// budget produce a friendly message, nothing is lost, and the game keeps working.
import type { Page } from "@playwright/test";
import type { ApiError } from "../src/shared/api.ts";
import { tap } from "./support/gestures.ts";
import { expect, test } from "./support/test.ts";

const RATE_LIMITED: ApiError = { error: "rate_limited", message: "Easy there, alchemist. Try again in a moment.", retryAfterMs: 20_000 };
const BUDGET: ApiError = {
  error: "budget_exhausted",
  message: "The lab is out of fresh ideas for today. Known recipes still work.",
  retryAfterMs: 3_600_000,
};

async function failNext(page: Page, path: string, status: number, body: ApiError): Promise<void> {
  await page.route(`**${path}`, (route) =>
    route.fulfill({
      status,
      contentType: "application/json",
      headers: { "retry-after": String(Math.ceil((body.retryAfterMs ?? 1000) / 1000)) },
      body: JSON.stringify(body),
    }),
  );
}

/** Friendly copy, never raw codes or status numbers. */
const FRIENDLY = /easy there|slow down|moment|try again|out of fresh ideas|known recipes|later/i;
const RAW = /rate_limited|budget_exhausted|\b429\b|\b503\b|error code|undefined/i;

test("rate-limited and budget-exhausted combines are friendly and recoverable", async ({ page, game, device, snap }) => {
  await game.startFresh();
  const water = await game.spawnByTap("Water");
  const fire = await game.spawnByTap("Fire");

  await failNext(page, "/api/combine", 429, RATE_LIMITED);
  await tap(water, device.touch);
  await tap(fire, device.touch);
  const limitToast = game.toasts.filter({ hasText: FRIENDLY }).first();
  await expect(limitToast).toBeVisible();
  await expect(limitToast).not.toContainText(RAW);
  // Nothing consumed, nothing stuck in a pending state, no modal in the way.
  await expect(game.canvasTile("Water")).toHaveCount(1);
  await expect(game.canvasTile("Fire")).toHaveCount(1);
  await expect(page.locator('[data-testid="canvas-tile"][data-pending="true"]')).toHaveCount(0);
  await expect(page.getByRole("alertdialog")).toHaveCount(0);
  await snap("rate-limited");
  await page.unroute("**/api/combine");

  await failNext(page, "/api/combine", 503, BUDGET);
  await tap(game.canvasTile("Water"), device.touch);
  await tap(game.canvasTile("Fire"), device.touch);
  const budgetToast = game.toasts.filter({ hasText: /fresh ideas|known recipes|later|tomorrow/i }).first();
  await expect(budgetToast).toBeVisible();
  await expect(budgetToast).not.toContainText(RAW);
  await expect(game.canvasTiles()).toHaveCount(2);
  await snap("budget-exhausted");
  await page.unroute("**/api/combine");

  // The same tiles still combine once the server is happy again.
  await tap(game.canvasTile("Water"), device.touch);
  const combined = game.nextCombine();
  await tap(game.canvasTile("Fire"), device.touch);
  const res = await game.expectCombineOk(await combined);
  expect(res.result.name).toBe("Steam");
  await expect(game.canvasTiles()).toHaveCount(1);
  await snap("recovered");
});

test("a rate-limited page load explains itself and recovers on retry", async ({ page, game, snap }) => {
  await failNext(page, "/api/bootstrap", 429, RATE_LIMITED);
  await page.goto("/");
  await expect(page.getByText(FRIENDLY).first()).toBeVisible({ timeout: 20_000 });
  await expect(page.locator("body")).not.toContainText(RAW);
  await snap("bootstrap-limited");

  await page.unroute("**/api/bootstrap");
  const boot = game.waitForBootstrap();
  await page.getByRole("button", { name: /try again|retry|reload/i }).first().click();
  await boot;
  await game.waitReady();
  await expect(game.onboarding).toBeVisible();
});
