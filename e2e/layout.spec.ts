// (11) Layout sanity on every device: no sideways page scroll, finger-sized key controls, and
// canvas tiles that stay inside the canvas when the viewport rotates or resizes.
import type { Page } from "@playwright/test";
import type { Game } from "./support/game.ts";
import { expect, test } from "./support/test.ts";

/** Finger-sized on phones/tablets (Apple HIG 44 pt); WCAG 2.5.8's 24 px for a mouse. */
const minTarget = (project: string) => (project === "desktop-chrome" ? 24 : 44);

async function expectNoHorizontalScroll(page: Page): Promise<void> {
  const m = await page.evaluate(() => ({
    doc: document.documentElement.scrollWidth,
    body: document.body.scrollWidth,
    vw: document.documentElement.clientWidth,
  }));
  expect(Math.max(m.doc, m.body), `page is ${Math.max(m.doc, m.body)}px wide in a ${m.vw}px viewport`).toBeLessThanOrEqual(m.vw);
}

/**
 * Every canvas tile lies inside the canvas and the viewport, and its center is reachable
 * (the topmost element there is the tile itself, not the toolbar, the shelf or another tile).
 */
async function expectTilesInBounds(game: Game, label: string): Promise<void> {
  // Let the re-layout springs settle before measuring.
  await expect
    .poll(
      async () => {
        const r = await game.page.evaluate(() => {
          const canvas = document.querySelector('[data-testid="canvas"]')!.getBoundingClientRect();
          return [...document.querySelectorAll('[data-testid="canvas-tile"]')].map((t) => {
            const b = t.getBoundingClientRect();
            const inside =
              b.left >= canvas.left - 1 &&
              b.top >= canvas.top - 1 &&
              b.right <= canvas.right + 1 &&
              b.bottom <= canvas.bottom + 1 &&
              b.right <= window.innerWidth + 1 &&
              b.bottom <= window.innerHeight + 1;
            const hit = document.elementFromPoint(b.left + b.width / 2, b.top + b.height / 2);
            const reachable = !!hit && hit.closest('[data-testid="canvas-tile"]') === t;
            return { name: t.getAttribute("data-name"), problem: !inside ? "outside" : !reachable ? "covered" : null };
          });
        });
        return r.filter((t) => t.problem).map((t) => `${t.name} ${t.problem}`);
      },
      { message: `canvas tiles out of bounds or covered (${label})`, timeout: 5_000 },
    )
    .toEqual([]);
}

test("layout: no horizontal scroll, finger-sized targets, tiles stay in bounds on rotate @layout", async ({ page, game, device, snap }) => {
  await game.startFresh();
  await expectNoHorizontalScroll(page);

  const MIN_TARGET = minTarget(device.project);
  // Soft checks: report every undersized control, then still exercise rotation.
  const controls = ["challenge-chip", "stats-chip", "menu-button", "canvas-undo", "canvas-tidy", "canvas-clear"];
  for (const id of controls) {
    const box = await page.getByTestId(id).first().boundingBox();
    expect(box, `${id} is rendered`).not.toBeNull();
    expect.soft(Math.min(box!.width, box!.height), `${id} is at least ${MIN_TARGET}px`).toBeGreaterThanOrEqual(MIN_TARGET);
  }
  for (const tile of await game.libraryTiles().all()) {
    const box = await tile.boundingBox();
    if (box) expect.soft(Math.min(box.width, box.height), "library tile size").toBeGreaterThanOrEqual(MIN_TARGET);
  }
  const search = await game.search.boundingBox();
  expect.soft(search!.height, "search field height").toBeGreaterThanOrEqual(MIN_TARGET - 4); // text fields: 40px+ is fine
  // iOS zooms into inputs under 16px.
  expect.soft(await game.search.evaluate((el) => parseFloat(getComputedStyle(el).fontSize)), "search font size").toBeGreaterThanOrEqual(16);

  for (const name of ["Earth", "Water", "Air", "Fire", "Time", "Water", "Fire"]) await game.spawnByTap(name);
  await expectTilesInBounds(game, "initial");
  await snap("portrait");

  const vp = page.viewportSize()!;
  // Phones/tablets rotate; desktop shrinks to a small window.
  const rotated = device.project === "desktop-chrome" ? { width: 1024, height: 640 } : { width: vp.height, height: vp.width };
  await page.setViewportSize(rotated);
  await expectTilesInBounds(game, `${rotated.width}x${rotated.height}`);
  await expectNoHorizontalScroll(page);
  await expect(game.canvasTiles()).toHaveCount(7);
  await snap("rotated");

  await page.setViewportSize(vp);
  await expectTilesInBounds(game, "rotated back");
  await expectNoHorizontalScroll(page);
  await expect(game.canvasTiles()).toHaveCount(7);
  await snap("rotated-back");
});
