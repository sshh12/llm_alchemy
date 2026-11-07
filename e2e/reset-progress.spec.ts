// (8) Reset progress needs a deliberate hold; it sends the library back to the starters but
// keeps first discoveries and challenge history.
import { recipePathTo, unknownCombo } from "./support/fixtures.ts";
import { tap } from "./support/gestures.ts";
import { expect, test } from "./support/test.ts";

test("reset progress (hold to confirm) keeps firsts and challenge history", async ({ page, game, fx, device, snap }) => {
  test.slow(); // a first discovery plus the whole easy path, then a reset
  await game.startFresh();

  // Earn a first discovery and today's easy tier.
  const combo = unknownCombo(fx, device.index, 1);
  for (const ingredient of new Set(combo)) await game.makeAll(recipePathTo(fx, ingredient));
  const first = await game.combineByTap(combo);
  expect(first.firstEver).toBe(true);
  await game.dismissCelebrations(first);
  await game.clearCanvas();
  const easy = await game.makeAll(fx.challenge.easyPath);
  expect(easy.at(-1)!.completed).toContain("easy");

  const before = await game.reload();
  expect(before.stats.firsts).toBeGreaterThanOrEqual(1);
  expect(before.history[0]?.completed).toContain("easy");
  expect(before.library.length).toBeGreaterThan(fx.starters.length);

  // A quick tap on the hold-to-confirm button does nothing.
  const playerCalls: string[] = [];
  page.on("request", (r) => {
    if (r.url().endsWith("/api/player")) playerCalls.push(r.postData() ?? "");
  });
  const settings = await game.openSettings();
  await tap(settings.getByTestId("reset-progress"), device.touch);
  const confirm = page.getByTestId("reset-confirm");
  await expect(confirm).toBeVisible();
  await snap("reset-dialog");
  await tap(confirm, device.touch);
  await page.waitForTimeout(2_000);
  expect(playerCalls).toEqual([]);
  await game.expectLibraryCount(before.library.length);
  await page.keyboard.press("Escape"); // back out of the confirmation...
  await expect(confirm).toBeHidden();
  await game.closeSheet(settings); // ...and out of settings
  await game.expectNoDialogs();

  // Holding it resets.
  const reset = page.waitForResponse((r) => r.url().endsWith("/api/player"));
  await game.resetProgress();
  expect((await reset).status()).toBe(200);
  expect(playerCalls.map((b) => JSON.parse(b).action)).toEqual(["reset"]);
  await expect(page.getByTestId("reset-confirm")).toBeHidden();
  await game.expectLibraryCount(fx.starters.length);
  await expect(game.canvasTiles()).toHaveCount(0);
  await snap("after-reset");

  const after = await game.reload();
  expect(after.library.map((e) => e.name).sort()).toEqual([...fx.starters].sort());
  expect(after.stats.firsts).toBe(before.stats.firsts);
  expect(after.history).toEqual(before.history);
  expect(after.challenge?.targets.find((t) => t.tier === "easy")?.completed).toBe(true);
  await game.openChallenges();
  await expect(game.challengeTarget("easy")).toHaveAttribute("data-completed", "true");
  await snap("history-kept");
});
