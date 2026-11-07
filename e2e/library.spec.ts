// (6) Library: search filters the list; long-press (touch) or right-click (mouse) opens quick
// actions, and pinning moves the element to the front and persists.
import { tap } from "./support/gestures.ts";
import { expect, test } from "./support/test.ts";

test("search the library and pin an element from quick actions", async ({ game, fx, device, snap }) => {
  await game.startFresh();

  await game.searchLibrary("wat");
  await expect(game.libraryTiles()).toHaveCount(1);
  await expect(game.libraryTile("Water")).toBeVisible();
  await snap("search");
  await game.searchLibrary("zzzz");
  await expect(game.libraryTiles()).toHaveCount(0);
  await game.clearSearch();
  await expect(game.libraryTiles()).toHaveCount(fx.starters.length);

  const names = () => game.libraryTiles().evaluateAll((els) => els.map((e) => e.getAttribute("data-name")));
  const pinTarget = (await names()).at(-1)!; // pin the last one so the reorder is observable
  const menu = await game.openQuickActions(pinTarget);
  await snap("quick-actions");
  // Opening the menu must not have placed or dragged anything.
  await expect(game.canvasTiles()).toHaveCount(0);

  const pin = menu.getByTestId("quick-action-pin");
  await expect(pin).toHaveText(/pin/i);
  await tap(pin, device.touch);
  await expect(menu).toBeHidden();
  await expect(game.libraryTile(pinTarget)).toHaveAttribute("data-pinned", "true");
  await expect.poll(async () => (await names())[0]).toBe(pinTarget);
  await snap("pinned");

  await game.reload();
  await expect(game.libraryTile(pinTarget)).toHaveAttribute("data-pinned", "true");
  await expect.poll(async () => (await names())[0]).toBe(pinTarget);

  // And unpin again.
  const menu2 = await game.openQuickActions(pinTarget);
  await expect(menu2.getByTestId("quick-action-pin")).toHaveText(/unpin/i);
  await tap(menu2.getByTestId("quick-action-pin"), device.touch);
  await expect(game.libraryTile(pinTarget)).toHaveAttribute("data-pinned", "false");
});
