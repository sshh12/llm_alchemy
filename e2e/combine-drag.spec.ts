// (2) The core loop by dragging (mouse on desktop, real CDP touch drags on phones/tablets):
// library -> canvas, then library -> onto the canvas tile.
// (3) A combination nobody has made before (mock AI) -> first-ever discovery celebration.
import { recipePathTo, unknownCombo } from "./support/fixtures.ts";
import { center, drag } from "./support/gestures.ts";
import { expect, test } from "./support/test.ts";

test("drag Water onto the canvas and Fire onto it to make Steam", async ({ page, game, fx, device, snap }) => {
  const steam = fx.recipes.find((r) => r.result === "Steam" && [...r.ingredients].sort().join("+") === "Fire+Water");
  expect(steam, "fixtures.json must list the known recipe Water + Fire = Steam").toBeTruthy();

  await game.startFresh();
  const before = await game.libraryCount();

  const water = await game.dragFromLibrary("Water");
  await expect(water).toBeVisible();
  await snap("water-on-canvas");

  const target = await game.settledCenter(water);
  const combined = game.nextCombine();
  await drag(page, await center(await game.findInLibrary("Fire")), target, device.touch);
  const res = await game.expectCombineOk(await combined);

  expect(res.result.name).toBe("Steam");
  expect(res.newForPlayer).toBe(true);
  expect(res.recipeNew).toBe(false);
  expect(res.firstEver).toBe(false);
  // The inputs were consumed into the result where Water was.
  await expect(game.canvasTile("Steam")).toHaveCount(1);
  await expect(game.canvasTile("Water")).toHaveCount(0);
  await expect(game.canvasTile("Fire")).toHaveCount(0);
  const steamAt = await game.settledCenter(game.canvasTile("Steam"));
  expect(Math.hypot(steamAt.x - target.x, steamAt.y - target.y)).toBeLessThan(60);

  // New-to-you feedback and the library grew by one.
  await expect(game.toast("new").filter({ hasText: "Steam" })).toBeVisible();
  await game.expectLibraryCount(before + 1);
  await expect(game.libraryTile("Steam")).toHaveCount(1);
  await expect(game.discoveryCard).toBeHidden();
  await snap("steam");
});

test("an unknown combination becomes a first-ever discovery", async ({ game, fx, device, snap }) => {
  const combo = unknownCombo(fx, device.index, 0);
  await game.startFresh();
  for (const ingredient of new Set(combo)) await game.makeAll(recipePathTo(fx, ingredient));
  const before = await game.libraryCount();

  const res = await game.combineByDrag(combo);
  expect(res.recipeNew).toBe(true);
  expect(res.firstEver).toBe(true);
  expect(res.newForPlayer).toBe(true);
  expect(res.entry?.first).toBe(true);

  await expect(game.discoveryCard).toBeVisible();
  await expect(game.discoveryCard).toContainText(res.result.name);
  await expect(game.discoveryCard).toContainText(/first/i);
  await snap("first-discovery");

  await game.dismissCelebrations(res);
  await expect(game.canvasTile(res.result.name)).toHaveCount(1);
  await game.expectLibraryCount(before + 1);
  await snap("after-celebration");
});
