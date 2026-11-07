// (9) THE returning legacy player. A real 2023 player's browser has (a) a Workbox service worker
// that serves the old app shell cache-first for every navigation, and (b) their progress in
// localStorage. When the same origin starts serving v2, that browser must end up on the new
// game by itself (the kill-switch service-worker.js), with the library and challenge history
// restored exactly once, a single welcome-back notice, and no first-run onboarding in the way.
//
// This spec controls its own origin: it serves the fake 2023 app on a dedicated port, then
// rebinds that same port to a transparent proxy in front of the suite's netlify dev, so the
// browser sees one origin switch deployments, exactly like alchemy.sshh.io will.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { BrowserContext, Request } from "@playwright/test";
import type { BootstrapRequest, BootstrapResponse, Tier } from "../src/shared/api.ts";
import { startLegacyServer, startOriginProxy, type RunningServer } from "./legacy-fixture/server.ts";
import { Game } from "./support/game.ts";
import { expect, snapshot, test } from "./support/test.ts";

const LEGACY_PORT_BASE = 8890;
const TIER_ORDER: Tier[] = ["easy", "hard", "expert"];

test.describe("returning legacy player", () => {
  test.skip(({ browserName }) => browserName !== "chromium", "needs a persistent Chromium profile (service workers + storage)");

  test("the 2023 app hands over to v2 with progress restored exactly once", async ({ playwright, fx, device }, testInfo) => {
    test.slow();
    const user = fx.legacyUsers[device.index];
    if (!user) throw new Error(`fixtures.json needs a legacy user for project #${device.index} (${device.project})`);
    const port = LEGACY_PORT_BASE + device.index;
    const use = testInfo.project.use;
    // The proxy fronts whichever server the run targets (a config may point baseURL elsewhere).
    const appPort = Number(new URL(use.baseURL!).port);
    // A short profile path: Chromium's Cache Storage nests deeply and silently fails to write
    // past Windows' 260-char path limit (the old worker would never finish installing).
    const profile = fs.mkdtempSync(path.join(os.tmpdir(), `ia-legacy-${device.index}-`));
    const launch = () =>
      playwright.chromium.launchPersistentContext(profile, {
        headless: use.headless ?? true,
        viewport: use.viewport,
        screen: use.screen,
        deviceScaleFactor: use.deviceScaleFactor,
        isMobile: use.isMobile,
        hasTouch: use.hasTouch,
        userAgent: use.userAgent,
        baseURL: `http://localhost:${port}`,
      });
    const firstPage = (ctx: BrowserContext) => ctx.pages()[0] ?? ctx.newPage();
    const servers: RunningServer[] = [];
    const contexts: BrowserContext[] = [];

    try {
      // ---------------------------------------------------------------- A: the 2023 app
      await test.step("A: a player uses the 2023 app (service worker + localStorage)", async () => {
        servers.push(await startLegacyServer(port, { userId: user.userId, elements: user.elements }));
        const ctx = await launch();
        contexts.push(ctx);
        const page = await firstPage(ctx);
        await page.goto("/");
        await expect(page.locator("#legacy-app")).toBeVisible();
        await page.waitForFunction(() => navigator.serviceWorker.controller !== null, null, { timeout: 20_000 });
        const stored = await page.evaluate(() => ({
          userId: localStorage.getItem("alchemy:userId"),
          elements: localStorage.getItem("elements"),
          info: localStorage.getItem("infomodal:closed"),
        }));
        expect(JSON.parse(stored.userId!)).toEqual({ value: user.userId });
        expect(JSON.parse(stored.elements!)).toEqual(user.elements);
        expect(stored.info).toBe("true");
        expect(await page.evaluate(() => caches.keys())).not.toHaveLength(0);
        await snapshot(page, testInfo, "A-legacy-2023-app");
        await ctx.close();
        contexts.pop();
        await servers.pop()!.close(); // the old deployment is gone
      });

      // ---------------------------------------------------------------- B: same origin, now v2
      servers.push(await startOriginProxy(port, appPort));
      const ctx = await launch();
      contexts.push(ctx);
      const page = await firstPage(ctx);
      const pageErrors: string[] = [];
      page.on("pageerror", (e) => pageErrors.push(e.stack ?? e.message));
      const navigations: Request[] = [];
      const bootstrapBodies: BootstrapRequest[] = [];
      const workerScripts: number[] = []; // statuses of /service-worker.js update checks
      ctx.on("response", (r) => {
        if (new URL(r.url()).pathname === "/service-worker.js") workerScripts.push(r.status());
      });
      page.on("request", (r) => {
        if (r.isNavigationRequest() && r.frame() === page.mainFrame()) navigations.push(r);
        if (r.url().endsWith("/api/bootstrap")) bootstrapBodies.push(r.postDataJSON() as BootstrapRequest);
      });
      const game = new Game(page, device);

      const boot = await test.step("B: the returning player opens the site and lands on v2 by itself", async () => {
        const booted = game.waitForBootstrap(60_000);
        const first = await page.goto("/", { waitUntil: "commit" });
        // We really start from the stale 2023 shell, served by the old service worker...
        expect(first?.fromServiceWorker(), "the first navigation is answered by the 2023 service worker").toBe(true);
        // ...and end up in the new app without anyone pressing reload.
        const body = await booted;
        await game.waitReady();
        await snapshot(page, testInfo, "B-new-app");
        expect(navigations.length, "at most one automatic reload after our navigation").toBeLessThanOrEqual(2);
        expect(workerScripts, "the browser fetched the new service-worker.js (the kill switch)").toContain(200);
        await expect(page.locator("#legacy-app")).toHaveCount(0);
        await expect
          .poll(() => page.evaluate(async () => (await navigator.serviceWorker.getRegistrations()).length), {
            message: "the kill switch unregistered every service worker",
          })
          .toBe(0);
        expect(await page.evaluate(() => caches.keys()), "old precaches deleted").toEqual([]);
        expect(await page.evaluate(() => !!navigator.serviceWorker.controller)).toBe(false);
        return body;
      });

      await test.step("B: legacy progress is sent once, adopted and imported", async () => {
        const legacyCalls = bootstrapBodies.filter((b) => b.legacy);
        expect(legacyCalls.length).toBeGreaterThanOrEqual(1);
        const sent = legacyCalls.at(-1)!.legacy!;
        expect(sent.userId).toBe(user.userId);
        for (const el of user.elements.filter((e) => !e.starterElement)) expect(sent.elementIds).toContain(el.id);
        expect(boot.player.legacy).toBe(true);
        expect(boot.legacyImport?.adopted).toBe(true);
        expect(boot.legacyImport?.imported).toBeGreaterThan(0);
        // Quarantined and unknown legacy ids are skipped, not fatal.
        expect(boot.legacyImport?.skipped).toBeGreaterThanOrEqual(user.expectAbsent.length);

        const names = boot.library.map((e) => e.name);
        for (const n of user.expectPresent) expect(names, `${n} restored`).toContain(n);
        for (const n of user.expectAbsent) expect(names, `${n} (quarantined) not restored`).not.toContain(n);
        expect(new Set(boot.library.map((e) => e.id)).size, "no duplicate library entries").toBe(boot.library.length);
        if (user.firstDiscovery) {
          expect(boot.library.find((e) => e.name === user.firstDiscovery)?.first, `${user.firstDiscovery} is credited as a first`).toBe(true);
          expect(boot.stats.firsts).toBeGreaterThanOrEqual(1);
        }
        for (const h of user.history) {
          const day = boot.history.find((d) => d.day === h.day);
          expect(day, `history has ${h.day}`).toBeTruthy();
          expect([...day!.completed].sort()).toEqual([...h.completed].sort());
        }
        expect(await page.evaluate(() => localStorage.getItem("ia:legacyImported"))).not.toBeNull();
      });

      await test.step("B: one welcome-back notice, no onboarding, the board is usable at once", async () => {
        await expect(game.welcomeBack).toHaveCount(1);
        await expect(game.welcomeBack).toBeVisible();
        await expect(game.onboarding).toBeHidden();
        await snapshot(page, testInfo, "B-welcome-back");
        // Non-blocking: the player can act without dismissing anything first.
        await game.spawnByTap(user.expectPresent[0]!);
        await game.clearCanvas();
      });

      await test.step("B: the restored library shows mapped elements and hides quarantined ones", async () => {
        await game.expectLibraryCount(boot.library.length);
        for (const n of user.expectPresent) {
          await game.searchLibrary(n);
          await expect(game.libraryTile(n)).toHaveCount(1);
        }
        for (const n of user.expectAbsent) {
          await game.searchLibrary(n);
          await expect(game.libraryTile(n)).toHaveCount(0);
        }
        await game.clearSearch();
        await snapshot(page, testInfo, "B-library");
      });

      await test.step("B: legacy challenge history is in the challenges sheet", async () => {
        const sheet = await game.openChallenges();
        const history = page.getByTestId("challenge-history");
        for (const h of user.history) {
          const row = history.locator(`[data-testid="challenge-history-day"][data-day="${h.day}"]`);
          await row.scrollIntoViewIfNeeded();
          await expect(row).toBeVisible();
          const tiers = TIER_ORDER.filter((t) => h.completed.includes(t)).join(",");
          await expect(row).toHaveAttribute("data-completed", tiers);
        }
        await snapshot(page, testInfo, "B-history");
        await game.closeSheet(sheet);
      });

      await test.step("C: a second reload does not import again or duplicate anything", async () => {
        const sentBefore = bootstrapBodies.length;
        const again: BootstrapResponse = await game.reload();
        expect(bootstrapBodies.slice(sentBefore).some((b) => b.legacy), "no legacy payload after the import").toBe(false);
        expect(again.legacyImport).toBeUndefined();
        expect(again.player.id).toBe(boot.player.id);
        expect(again.library.length).toBe(boot.library.length);
        expect(new Set(again.library.map((e) => e.id)).size).toBe(again.library.length);
        await game.expectLibraryCount(boot.library.length);
        await page.waitForTimeout(1_000);
        await expect(game.welcomeBack).toBeHidden();
        await expect(game.onboarding).toBeHidden();
        // The client never deletes the legacy keys (a rollback must stay possible).
        const keys = await page.evaluate(() => ({
          userId: localStorage.getItem("alchemy:userId"),
          elements: localStorage.getItem("elements"),
          imported: localStorage.getItem("ia:legacyImported"),
        }));
        expect(JSON.parse(keys.userId!)).toEqual({ value: user.userId });
        expect(JSON.parse(keys.elements!)).toEqual(user.elements);
        expect(keys.imported).not.toBeNull();
        await snapshot(page, testInfo, "C-second-reload");
      });

      await test.step("D: the adopted player keeps playing on the same origin and the result is saved", async () => {
        const steam = fx.recipes.find((r) => r.result === "Steam");
        expect(steam, "fixtures.json lists a recipe for Steam").toBeTruthy();
        const res = await game.combineByTap(steam!.ingredients);
        expect(res.result.name).toBe("Steam");
        await game.dismissCelebrations(res);
        const libraryAfter = boot.library.length + (res.newForPlayer ? 1 : 0);
        await game.expectLibraryCount(libraryAfter);
        await snapshot(page, testInfo, "D-combined");

        const again = await game.reload();
        expect(again.player.id).toBe(boot.player.id);
        expect(again.legacyImport).toBeUndefined();
        expect(again.library.map((e) => e.name)).toContain("Steam");
        expect(again.library.length).toBe(libraryAfter);
      });

      expect(pageErrors, "uncaught errors in the page").toEqual([]);
    } finally {
      for (const ctx of contexts) await ctx.close().catch(() => {});
      for (const s of servers) await s.close();
      fs.rmSync(profile, { recursive: true, force: true, maxRetries: 3 });
    }
  });
});
