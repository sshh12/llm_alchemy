// (1) A brand-new player: onboarding, proof-of-work + bootstrap, the five starters, and an
// onboarding dismissal that sticks across reloads.
import { expect, test } from "./support/test.ts";

test("first visit shows onboarding, solves PoW, and starts with the five starters @layout", async ({ page, game, fx, snap }) => {
  const bootstrapStatuses: number[] = [];
  page.on("response", (r) => {
    if (r.url().endsWith("/api/bootstrap")) bootstrapStatuses.push(r.status());
  });

  const boot = await game.open();
  // No cookie yet: the server demands PoW (401), the worker solves it, the retry succeeds.
  expect(bootstrapStatuses).toEqual([401, 200]);
  expect(boot.library.map((e) => e.name).sort()).toEqual([...fx.starters].sort());
  expect(boot.library.every((e) => e.starter)).toBe(true);

  await expect(game.onboarding).toBeVisible();
  await snap("onboarding");
  await game.dismissOnboarding();

  for (const name of fx.starters) await expect(game.libraryTile(name)).toBeVisible();
  await expect(game.libraryTiles()).toHaveCount(fx.starters.length);
  await game.expectLibraryCount(fx.starters.length);
  await expect(game.canvas).toBeVisible();
  await snap("board");

  // Same player on reload (session cookie, no second PoW), and onboarding stays dismissed.
  bootstrapStatuses.length = 0;
  const again = await game.reload();
  expect(bootstrapStatuses).toEqual([200]);
  expect(again.player.id).toBe(boot.player.id);
  await page.waitForTimeout(1_000); // give a late-mounting onboarding the chance to (wrongly) appear
  await expect(game.onboarding).toBeHidden();
  await snap("reloaded");
});
