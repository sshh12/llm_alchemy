// (idle) "Today in your lab" (experiment idleCard). Forced into an arm with the ia:exp override
// and given a 1.5 s idle threshold with ia:idleTest (both ignored on the production host), a
// player who has made 10 discoveries today and pauses gets the card once that local day: it
// dismisses, stays gone after a reload, steps aside for a sheet, offers a held-back install
// prompt (and the iPad tip), and "Play at home" opens Settings. Control never sees it.
// Discoveries are made through /api/combine from the page (known recipes, so no world-firsts
// and no celebration cards), then a reload brings them into the library like a later session.
import type { Page } from "@playwright/test";
import { API_HEADER, type BootstrapResponse, type CombineResponse } from "../src/shared/api.ts";
import type { Fixtures } from "./support/fixtures.ts";
import type { Game } from "./support/game.ts";
import { tap } from "./support/gestures.ts";
import { expect, test } from "./support/test.ts";

test.skip(({ device }) => device.engine !== "chromium", "Chromium projects (touch emulation; the event hooks are Chromium's)");

const IDLE_MS = 1_500;
/** Long enough for the card to have appeared if it were going to (idle threshold plus a check). */
const WAIT_MS = IDLE_MS * 3;
const SHOWN_KEY = "ia:idleCard";

interface Tracked {
  name: string;
  params?: Record<string, unknown>;
}

/** Arm override, short timers and a gtag stand-in that records events (GA itself only runs in production). */
async function prepare(page: Page, idleCard: "treatment" | "control"): Promise<void> {
  await page.addInitScript(
    ({ idleCard, idleMs }) => {
      // Other experiments pinned to control so onboarding and toasts are the ones these steps expect.
      localStorage.setItem("ia:exp", JSON.stringify({ idleCard, firstRun: "control", goals: "control" }));
      localStorage.setItem("ia:idleTest", JSON.stringify({ idleMs }));
      const w = window as unknown as { __events: Tracked[]; gtag: (cmd: string, name: string, params?: Record<string, unknown>) => void };
      w.__events = [];
      w.gtag = (cmd, name, params) => {
        if (cmd === "event") w.__events.push({ name, params });
      };
    },
    { idleCard, idleMs: IDLE_MS },
  );
}

const events = (page: Page, name: string) =>
  page.evaluate((n) => (window as unknown as { __events: Tracked[] }).__events.filter((e) => e.name === n).map((e) => e.params ?? {}), name);

/** Make `n` known recipes in order via /api/combine (each uses only starters or earlier results). */
async function discover(page: Page, fx: Fixtures, boot: BootstrapResponse, n: number): Promise<void> {
  const ids = new Map(boot.library.map((e) => [e.name, e.id]));
  for (const r of fx.recipes.slice(0, n)) {
    const { status, body } = await page.evaluate(
      async ({ ids, header }) => {
        const d = new Date();
        const clientDate = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
        const res = await fetch("/api/combine", {
          method: "POST",
          headers: { "content-type": "application/json", [header]: "1" },
          body: JSON.stringify({ ids, clientDate }),
          credentials: "same-origin",
        });
        return { status: res.status, body: (await res.json()) as CombineResponse };
      },
      { ids: r.ingredients.map((name) => ids.get(name)!), header: API_HEADER },
    );
    expect(status, `combine ${r.ingredients.join(" + ")}: ${JSON.stringify(body)}`).toBe(200);
    expect(body.result.name).toBe(r.result);
    expect(body.newForPlayer).toBe(true);
    ids.set(body.result.name, body.result.id);
  }
}

/** A fresh player with 10 discoveries today, reloaded so they are in the library. */
async function playedToday(game: Game, fx: Fixtures): Promise<void> {
  const boot = await game.startFresh();
  await discover(game.page, fx, boot, 10);
  await game.reload();
  await game.expectLibraryCount(boot.library.length + 10);
}

/** Chromium's beforeinstallprompt, faked (headless Chromium never fires it); resolves to defaultPrevented. */
const offerInstall = (page: Page, outcome: "accepted" | "dismissed") =>
  page.evaluate((outcome) => {
    const e = new Event("beforeinstallprompt", { cancelable: true });
    Object.assign(e, { prompt: async () => {}, userChoice: Promise.resolve({ outcome, platform: "web" }) });
    dispatchEvent(e);
    return e.defaultPrevented;
  }, outcome);

test("treatment: once a day after 10 discoveries and a pause, dismissible, never over a sheet", async ({ game, fx, page, device, snap }) => {
  await prepare(page, "treatment");
  const card = page.getByTestId("idle-card");
  const boot = await game.startFresh();

  // Fewer than 10 discoveries today: a pause shows nothing.
  await page.waitForTimeout(WAIT_MS);
  await expect(card).toHaveCount(0);

  await discover(page, fx, boot, 10);
  await game.reload();
  await expect(card).toBeVisible();
  await expect(card).toHaveAttribute("data-via", "idle");
  await expect(card.getByTestId("idle-card-stats")).toHaveAttribute("data-discoveries", "10");
  await expect(card.getByTestId("idle-card-stats")).toHaveAttribute("data-firsts", "0");
  await expect(card).toContainText("10 discoveries");
  await expect(card.getByTestId("idle-card-teaser")).toContainText(/Next target in \d+(h|m|s)/);
  await expect(card.getByTestId("idle-card-home")).toBeVisible();
  // iPad (iPad UA here; iPadOS Safari says "Macintosh" with touch points) gets the Home Screen tip.
  await expect(card.getByTestId("idle-card-tip")).toHaveCount(device.project === "ipad" ? 1 : 0);
  await expect(card.getByTestId("idle-card-install")).toHaveCount(0);
  // Not a modal: nothing else was opened and focus stayed where it was.
  await game.expectNoDialogs();
  await expect(card.locator(":focus")).toHaveCount(0);
  const shown = await events(page, "idle_card");
  expect(shown).toEqual([expect.objectContaining({ action: "shown", via: "idle", discoveries: 10, firsts: 0, offer: device.project === "ipad" ? "tip" : "none" })]);
  await snap("shown");

  // The browser says the app is installable: treatment holds its prompt back for the card.
  expect(await offerInstall(page, "dismissed")).toBe(true);
  expect(await events(page, "install_eligible")).toEqual([{ prevented: true, arm: "treatment" }]);
  const install = card.getByTestId("idle-card-install");
  await expect(install).toBeVisible();
  await expect(card.getByTestId("idle-card-tip")).toHaveCount(0);
  await tap(install, device.touch);
  await expect(install).toHaveCount(0); // an event prompts once
  await expect.poll(() => events(page, "install_prompt")).toEqual([{ outcome: "dismissed" }]);

  await tap(card.getByTestId("idle-card-dismiss"), device.touch);
  await expect(card).toHaveCount(0);
  expect((await events(page, "idle_card")).map((p) => p.action)).toEqual(["shown", "install", "dismiss"]);

  // Same day, new page load: not again.
  await game.reload();
  await page.waitForTimeout(WAIT_MS);
  await expect(card).toHaveCount(0);
  expect(await events(page, "idle_card")).toEqual([]);

  // The next day (the remembered day is yesterday's): it comes back, but not over a sheet.
  await page.evaluate((k) => localStorage.setItem(k, "2000-01-01"), SHOWN_KEY);
  await game.reload();
  const settings = await game.openSettings();
  await page.waitForTimeout(WAIT_MS);
  await expect(card).toHaveCount(0);
  await game.closeSheet(settings);
  await expect(card).toBeVisible();

  // Keyboard: every action is a button in the tab order, and Escape inside the card dismisses it.
  await card.getByTestId("idle-card-home").focus();
  await page.keyboard.press("Escape");
  await expect(card).toHaveCount(0);
  expect((await events(page, "idle_card")).map((p) => p.action)).toEqual(["shown", "dismiss"]);
});

test("treatment: Play at home opens the transfer code in Settings", async ({ game, fx, page, device }) => {
  test.skip(device.project !== "desktop-chrome" && device.project !== "pixel-7", "one desktop and one phone cover it");
  await prepare(page, "treatment");
  await playedToday(game, fx);
  const card = page.getByTestId("idle-card");
  await expect(card).toBeVisible();
  await tap(card.getByTestId("idle-card-home"), device.touch);
  await expect(card).toHaveCount(0);
  await expect(game.settingsSheet).toBeVisible();
  await expect(game.settingsSheet.getByRole("button", { name: "Show my transfer code" })).toBeVisible();
  expect((await events(page, "idle_card")).map((p) => p.action)).toEqual(["shown", "home"]);
  // Closing Settings doesn't bring the card back: it was today's.
  await game.closeSheet(game.settingsSheet);
  await page.waitForTimeout(WAIT_MS);
  await expect(card).toHaveCount(0);
});

test("control: never shows the card and keeps the browser's install prompt", async ({ game, fx, page }) => {
  await prepare(page, "control");
  await playedToday(game, fx);
  await page.waitForTimeout(WAIT_MS);
  await expect(page.getByTestId("idle-card")).toHaveCount(0);
  expect(await offerInstall(page, "dismissed")).toBe(false);
  expect(await events(page, "install_eligible")).toEqual([{ prevented: false, arm: "control" }]);
  await page.waitForTimeout(WAIT_MS);
  await expect(page.getByTestId("idle-card")).toHaveCount(0);
  expect(await events(page, "idle_card")).toEqual([]);
  expect(await page.evaluate((k) => localStorage.getItem(k), SHOWN_KEY)).toBeNull();
});
