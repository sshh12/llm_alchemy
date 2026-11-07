// (9) Transfer progress by QR code: Settings shows the code as a `/#transfer=<code>` QR link; a
// fresh device opening it is asked before it switches (no onboarding in the way), the code leaves
// the address bar at once, and Cancel / a bad link / your own link change nothing.
import type { Browser, BrowserContextOptions, Page } from "@playwright/test";
import { recipePathTo } from "./support/fixtures.ts";
import { Game } from "./support/game.ts";
import { tap } from "./support/gestures.ts";
import { expect, snapshot, test } from "./support/test.ts";

test.skip(({ device }) => device.project !== "desktop-chrome" && device.project !== "iphone-15", "one desktop and one phone cover it");

const INVALID = "That code isn't valid (or was revoked).";

/** Settings -> "Show my transfer code": the QR deep link is on screen; returns the code. */
async function showTransferCode(game: Game): Promise<string> {
  const settings = await game.openSettings();
  await tap(settings.getByRole("button", { name: "Show my transfer code" }), game.device.touch);
  const qr = settings.getByTestId("transfer-qr");
  await expect(qr.locator("svg")).toBeVisible();
  await qr.scrollIntoViewIfNeeded();
  // ~200 px with whole pixels per module (crisp at 1x), quiet zone included, inside the sheet.
  const { width, modules, fits } = await qr.locator("svg").evaluate((svg: SVGSVGElement) => {
    const r = svg.getBoundingClientRect();
    const sheet = svg.closest('[data-testid="settings-sheet"]')!.getBoundingClientRect();
    return { width: r.width, modules: svg.viewBox.baseVal.width, fits: r.left >= sheet.left && r.right <= sheet.right };
  });
  expect(width).toBeGreaterThanOrEqual(180);
  expect(width).toBeLessThanOrEqual(260);
  expect(width % modules).toBe(0);
  expect(fits).toBe(true);
  const code = (await settings.getByTestId("transfer-code").textContent())?.trim() ?? "";
  expect(code).toMatch(/^[1-9]\d*\.\d+\.[A-Za-z0-9_-]{22}$/);
  await expect(settings.getByText("Scan with your phone's camera to continue on that device")).toBeVisible();
  return code;
}

/** A second device: a fresh browser context (no cookie, no storage) with the same emulation. */
async function freshDevice(browser: Browser, opts: BrowserContextOptions, game: Game) {
  const context = await browser.newContext(opts);
  const page = await context.newPage();
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.stack ?? e.message));
  return { context, page, game: new Game(page, game.device), errors };
}

const linkTo = (code: string) => `/#transfer=${encodeURIComponent(code)}`;

/** Load `path` as a new document (a hash-only change of the current URL would not reload). */
async function openFresh(page: Page, game: Game, path: string) {
  await page.goto("about:blank");
  return game.open(path);
}

test.describe("transfer progress by QR code", () => {
  test.use({ permissions: ["clipboard-read", "clipboard-write"] });

  test("a fresh device opening the QR link switches to that player", async ({ browser, page, game, fx, snap, contextOptions, viewport, userAgent, isMobile, hasTouch, deviceScaleFactor, baseURL }, testInfo) => {
    // Player A, with something beyond the starters.
    const a = await game.startFresh();
    await game.makeAll(recipePathTo(fx, "Steam"));
    const code = await showTransferCode(game);
    await snap("settings-qr-light");
    await page.emulateMedia({ colorScheme: "dark" });
    await snap("settings-qr-dark");
    await page.emulateMedia({ colorScheme: "light" });

    // "Copy link" puts the deep link (code in the fragment) on the clipboard.
    await tap(game.settingsSheet.getByRole("button", { name: "Copy link" }), game.device.touch);
    await expect(game.settingsSheet.getByText("Copied")).toBeVisible();
    expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(`${new URL(baseURL!).origin}${linkTo(code)}`);

    // Device B scans it: its first visit (PoW bootstrap) runs, then the confirm, not onboarding.
    const b = await freshDevice(browser, { ...contextOptions, viewport, userAgent, isMobile, hasTouch, deviceScaleFactor, baseURL }, game);
    try {
      const bBoot = await b.game.open(linkTo(code));
      expect(bBoot.player.id).not.toBe(a.player.id);
      expect(new URL(b.page.url()).hash).toBe(""); // the code left the address bar at once
      expect(await b.page.evaluate(() => location.href)).not.toContain("transfer");
      const confirm = b.page.getByTestId("transfer-confirm");
      await expect(confirm).toBeVisible();
      await expect(confirm.getByText("Continue as another player?")).toBeVisible();
      await expect(b.game.onboarding).toBeHidden();
      await snapshot(b.page, testInfo, "confirm");

      const redeem = b.page.waitForResponse((r) => r.url().endsWith("/api/player") && r.request().postDataJSON()?.action === "redeem");
      const reboot = b.game.waitForBootstrap();
      await tap(b.page.getByTestId("transfer-switch"), b.game.device.touch);
      expect((await redeem).status()).toBe(200);
      const switched = await reboot;
      await b.game.waitReady();
      expect(switched.player.id).toBe(a.player.id);
      expect(switched.library.map((e) => e.name)).toContain("Steam");
      await expect(await b.game.findInLibrary("Steam")).toBeVisible();
      expect(new URL(b.page.url()).hash).toBe("");
      await b.page.waitForTimeout(800); // a late onboarding or prompt would show up by now
      await expect(b.game.onboarding).toBeHidden();
      await expect(confirm).toBeHidden();
      await snapshot(b.page, testInfo, "switched");
      expect(b.errors, "uncaught errors on device B").toEqual([]);
    } finally {
      await b.context.close();
    }
  });

  test("Cancel keeps this device's player", async ({ browser, game, contextOptions, viewport, userAgent, isMobile, hasTouch, deviceScaleFactor, baseURL }) => {
    const a = await game.startFresh();
    const code = await showTransferCode(game);

    const b = await freshDevice(browser, { ...contextOptions, viewport, userAgent, isMobile, hasTouch, deviceScaleFactor, baseURL }, game);
    try {
      const redeems: string[] = [];
      b.page.on("request", (r) => {
        if (r.url().endsWith("/api/player") && r.postDataJSON()?.action === "redeem") redeems.push(r.url());
      });
      const bBoot = await b.game.open(linkTo(code));
      expect(new URL(b.page.url()).hash).toBe("");
      await expect(b.page.getByTestId("transfer-confirm")).toBeVisible();
      await tap(b.page.getByTestId("transfer-cancel"), b.game.device.touch);
      await expect(b.page.getByTestId("transfer-confirm")).toBeHidden();
      await b.game.expectNoDialogs();
      expect(redeems).toEqual([]);

      const again = await b.game.reload();
      expect(again.player.id).toBe(bBoot.player.id);
      expect(again.player.id).not.toBe(a.player.id);
      await expect(b.page.getByTestId("transfer-confirm")).toBeHidden();
      expect(b.errors, "uncaught errors on device B").toEqual([]);
    } finally {
      await b.context.close();
    }
  });

  test("a bad link shows the friendly error and your own link changes nothing", async ({ page, game }) => {
    const a = await game.startFresh();
    const code = await showTransferCode(game);
    const playerCalls: string[] = [];
    page.on("request", (r) => {
      if (r.url().endsWith("/api/player")) playerCalls.push(r.postDataJSON()?.action);
    });

    // Garbage: no prompt, no server call, the friendly copy, and the hash is gone.
    await openFresh(page, game, "/#transfer=garbage");
    expect(new URL(page.url()).hash).toBe("");
    await expect(game.toast("error").filter({ hasText: INVALID })).toBeVisible();
    await expect(page.getByTestId("transfer-confirm")).toBeHidden();
    expect(playerCalls).toEqual([]);

    // A well-formed code for another player id, so its signature is wrong: the server refuses it
    // after the confirm.
    const forged = code.replace(/^\d/, (d) => (d === "9" ? "8" : String(Number(d) + 1)));
    const booted = await openFresh(page, game, linkTo(forged));
    expect(booted.player.id).toBe(a.player.id);
    await tap(page.getByTestId("transfer-switch"), game.device.touch);
    await expect(game.toast("error").filter({ hasText: INVALID })).toBeVisible();
    await expect(page.getByTestId("transfer-confirm")).toBeHidden();

    // Your own code: nothing to switch.
    playerCalls.length = 0;
    const own = await openFresh(page, game, linkTo(code));
    expect(own.player.id).toBe(a.player.id);
    expect(new URL(page.url()).hash).toBe("");
    await expect(game.toast("info").filter({ hasText: "You're already playing as this player" })).toBeVisible();
    await expect(page.getByTestId("transfer-confirm")).toBeHidden();
    expect(playerCalls).not.toContain("redeem");
  });
});
