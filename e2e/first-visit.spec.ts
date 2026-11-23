// (1) A brand-new player: onboarding, proof-of-work + bootstrap, the five starters, and an
// onboarding dismissal that sticks across reloads. Control arm of experiment firstRun (the modal
// welcome sheet); the treatment (seeded demo pair, coach, non-blocking welcome card) follows.
import { drag, tap } from "./support/gestures.ts";
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
  // Step 2 describes the real tap path, and teachers have a way in.
  await expect(game.onboarding).toContainText("Tap an element to put it on the board");
  await expect(game.onboarding.getByRole("link", { name: "For teachers" })).toHaveAttribute("href", "/teachers");
  await snap("onboarding");
  await game.dismissOnboarding();

  for (const name of fx.starters) await expect(game.libraryTile(name)).toBeVisible();
  await expect(game.libraryTiles()).toHaveCount(fx.starters.length);
  await game.expectLibraryCount(fx.starters.length);
  await expect(game.canvas).toBeVisible();
  // Control: an empty board, no first-run card or coach.
  await expect(game.canvasTiles()).toHaveCount(0);
  await expect(game.welcomeCard).toHaveCount(0);
  await expect(game.coach).toHaveCount(0);
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

test.describe("first run, treatment arm", () => {
  test.beforeEach(async ({ game }) => {
    await game.forceArms({ firstRun: "treatment" });
  });

  test("the demo pair waits on the board with a coach, the welcome never blocks it, and a drag combines", async ({ page, game, fx, device, snap }) => {
    const boot = await game.open();
    expect(boot.library.every((e) => e.starter)).toBe(true);

    // No modal: the collapsed welcome card, Water and Fire on the board, and the coach.
    await expect(game.welcomeCard).toBeVisible();
    await expect(game.welcomeCard).toHaveAttribute("data-state", "collapsed");
    await expect(game.onboarding).toHaveCount(0);
    await game.expectNoDialogs();
    const water = game.canvasTile("Water");
    const fire = game.canvasTile("Fire");
    await expect(water).toHaveCount(1);
    await expect(fire).toHaveCount(1);
    await expect(game.canvasTiles()).toHaveCount(2);
    await expect(game.coach).toBeVisible();
    const mode = await game.coach.getAttribute("data-mode");
    await expect(game.coach).toHaveText(mode === "drag" ? "Drag Water onto Fire" : "Tap Water, then tap Fire");
    await snap("first-run");

    // The card expands to the full welcome (same content as the sheet) and collapses again.
    await tap(page.getByTestId("welcome-expand"), device.touch);
    await expect(game.welcomeCard).toHaveAttribute("data-state", "expanded");
    const body = page.getByTestId("welcome-body");
    await expect(body).toContainText("Tap an element to put it on the board");
    await expect(body.getByRole("link", { name: "For teachers" })).toHaveAttribute("href", "/teachers");
    await game.expectNoDialogs();
    await snap("welcome-expanded");
    await tap(page.getByTestId("welcome-expand"), device.touch);
    await expect(game.welcomeCard).toHaveAttribute("data-state", "collapsed");

    // Drag Water onto Fire: Steam, and the coach is done.
    const from = await game.settledCenter(water);
    const to = await game.settledCenter(fire);
    const combined = game.nextCombine();
    await drag(page, from, to, device.touch);
    const res = await game.expectCombineOk(await combined);
    expect(res.result.name).toBe("Steam");
    expect(res.newForPlayer).toBe(true);
    await expect(game.coach).toHaveCount(0);
    await expect(game.canvasTiles()).toHaveCount(1);
    await game.expectLibraryCount(fx.starters.length + 1);
    await snap("steam");

    // Reload: the first combine onboarded the player, so no card, no new seeds, no coach.
    const again = await game.reload();
    expect(again.player.id).toBe(boot.player.id);
    await page.waitForTimeout(1_000);
    await expect(game.welcomeCard).toHaveCount(0);
    await expect(game.onboarding).toHaveCount(0);
    await expect(game.coach).toHaveCount(0);
    expect(await game.canvasNames()).toEqual(["Steam"]);
  });

  test("tap Water, then tap Fire", async ({ page, game, device }) => {
    await game.open();
    const water = game.canvasTile("Water");
    const fire = game.canvasTile("Fire");
    await expect(game.coach).toBeVisible();
    await game.settledCenter(water);
    await game.settledCenter(fire);

    await tap(water, device.touch);
    await expect(water).toHaveAttribute("data-selected", "true");
    await expect(game.coach).toHaveText(/^Now (tap|click) Fire$/);
    const combined = game.nextCombine();
    await tap(fire, device.touch);
    const res = await game.expectCombineOk(await combined);
    expect(res.result.name).toBe("Steam");
    await expect(game.coach).toHaveCount(0);

    // The card stays (collapsed) until closed; closing it is remembered.
    await expect(game.welcomeCard).toBeVisible();
    await tap(page.getByTestId("welcome-dismiss"), device.touch);
    await expect(game.welcomeCard).toHaveCount(0);
    await game.reload();
    await page.waitForTimeout(1_000);
    await expect(game.welcomeCard).toHaveCount(0);
  });
});
