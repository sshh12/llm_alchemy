// (4) The accessible alternative to dragging (WCAG 2.5.7): tap a library element to place it,
// tap a canvas tile to select it, tap another to combine.
import { tap } from "./support/gestures.ts";
import { expect, test } from "./support/test.ts";

test("tap to place, tap to select, tap to combine", async ({ game, device, snap }) => {
  await game.startFresh();
  const before = await game.libraryCount();

  const water = await game.spawnByTap("Water");
  const fire = await game.spawnByTap("Fire");
  await expect(game.canvasTiles()).toHaveCount(2);

  // Selecting and deselecting is a toggle, and never combines on its own.
  await tap(water, device.touch);
  await expect(water).toHaveAttribute("data-selected", "true");
  await snap("water-selected");
  await tap(water, device.touch);
  await expect(water).not.toHaveAttribute("data-selected", "true");

  await tap(water, device.touch);
  await expect(water).toHaveAttribute("data-selected", "true");
  const combined = game.nextCombine();
  await tap(fire, device.touch);
  const res = await game.expectCombineOk(await combined);

  expect(res.result.name).toBe("Steam");
  await expect(game.canvasTile("Steam")).toHaveCount(1);
  await expect(game.canvasTiles()).toHaveCount(1);
  await expect(game.canvasTile("Steam")).not.toHaveAttribute("data-selected", "true");
  await game.expectLibraryCount(before + 1);
  await snap("steam");
});
