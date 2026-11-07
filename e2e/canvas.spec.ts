// (7) Clear the canvas, then undo it (from the toast and from the toolbar). Undo restores the
// same tiles at the same places; it never touches the library.
import type { Point } from "./support/gestures.ts";
import { tap } from "./support/gestures.ts";
import { expect, test } from "./support/test.ts";

test("clear the canvas and undo it", async ({ page, game, device, snap }) => {
  await game.startFresh();
  for (const name of ["Earth", "Air", "Fire"]) await game.spawnByTap(name);
  const layout = async () => {
    const out: Record<string, Point> = {};
    for (const name of await game.canvasNames()) out[name] = await game.settledCenter(game.canvasTile(name));
    return out;
  };
  const before = await layout();
  const libraryBefore = await game.libraryCount();
  await snap("before-clear");

  await tap(page.getByTestId("canvas-clear"), device.touch);
  await expect(game.canvasTiles()).toHaveCount(0);
  const undoToast = game.toast("undo").filter({ hasText: /clear/i }).last();
  await expect(undoToast).toBeVisible();
  await snap("cleared");

  await tap(undoToast.getByRole("button", { name: /undo/i }), device.touch);
  await expect(game.canvasTiles()).toHaveCount(3);
  const restored = await layout();
  expect(Object.keys(restored).sort()).toEqual(Object.keys(before).sort());
  for (const [name, p] of Object.entries(before)) {
    expect(Math.hypot(restored[name]!.x - p.x, restored[name]!.y - p.y), `${name} back in place`).toBeLessThan(4);
  }
  await snap("restored");

  // Toolbar undo does the same.
  await tap(page.getByTestId("canvas-clear"), device.touch);
  await expect(game.canvasTiles()).toHaveCount(0);
  await tap(page.getByTestId("canvas-undo"), device.touch);
  await expect(game.canvasTiles()).toHaveCount(3);
  await game.expectLibraryCount(libraryBefore);
});
