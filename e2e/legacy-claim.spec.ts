// (10) Adopt-once for legacy players. The 2023 API published every element's creator id, so a
// legacy user id alone is not proof of anything: the first browser that presents it binds the
// player to its claim token ('ia:legacyClaim'). Another browser presenting the same id (and the
// same inventory) gets a NEW player with a copy of the elements only: no firsts, no challenge
// history, and a notice that explains how to move the real progress. The binding browser can
// adopt again (e.g. after its cookie was cleared), because it still holds the token.
//
// Uses its own seeded legacy user (fixtures.legacyUsers[5]) and runs on one project only: a
// legacy player can be claimed once per seed. It also checks that a purge-quarantined ('review')
// element from the inventory is kept in the library (hidden) so a purge restore brings it back.
import type { BrowserContext, Page } from "@playwright/test";
import "../scripts/lib/env.ts";
import type { BootstrapRequest, BootstrapResponse } from "../src/shared/api.ts";
import { createPool } from "../scripts/lib/db.ts";
import { E2E_SCHEMA } from "./support/env.ts";
import type { LegacyUser } from "./support/fixtures.ts";
import { Game } from "./support/game.ts";
import { expect, snapshot, test } from "./support/test.ts";

const CLAIM_USER = 5;
const CLAIM_KEY = "ia:legacyClaim";
/** Rows written now() by the old code would be this close to the request; real dates are older. */
const CLOCK_MARGIN_MS = 30_000;

test.skip(({ device }) => device.project !== "desktop-chrome", "one seeded legacy user, claimable once per seed");

/** The 2023 app's localStorage, written before any page script runs (only if absent, so later edits stick). */
async function installLegacy(ctx: BrowserContext, user: LegacyUser) {
  await ctx.addInitScript(
    ({ userId, elements }) => {
      if (localStorage.getItem("alchemy:userId") !== null) return;
      localStorage.setItem("alchemy:userId", JSON.stringify({ value: userId }));
      localStorage.setItem("elements", JSON.stringify(elements));
      localStorage.setItem("infomodal:closed", "true");
    },
    { userId: user.userId, elements: user.elements },
  );
}

/** Bootstrap bodies the page sends (to read the claim token that went out). */
function recordBootstraps(page: Page): BootstrapRequest[] {
  const sent: BootstrapRequest[] = [];
  page.on("request", (r) => {
    if (r.url().endsWith("/api/bootstrap")) sent.push(r.postDataJSON() as BootstrapRequest);
  });
  return sent;
}

/** Library rows straight from the e2e schema, hidden (non-active) elements included. Read-only. */
async function dbLibrary(publicId: string): Promise<{ element_id: string; source: string }[]> {
  const pool = createPool(1);
  try {
    const c = await pool.connect();
    try {
      await c.query("SET default_transaction_read_only = on");
      const r = await c.query<{ element_id: string; source: string }>(
        `SELECT d.element_id, d.source FROM ${E2E_SCHEMA}.discoveries d JOIN ${E2E_SCHEMA}.players p ON p.id = d.player_id
          WHERE p.public_id = $1`,
        [publicId],
      );
      return r.rows;
    } finally {
      c.release();
    }
  } finally {
    await pool.end();
  }
}

const names = (boot: BootstrapResponse) => boot.library.map((e) => e.name);

test.describe("legacy adopt-once", () => {
  test("the first browser binds the legacy player; another one gets a copy of the elements", async ({ browser, context, page, game, fx }, testInfo) => {
    test.slow();
    const user = fx.legacyUsers[CLAIM_USER];
    const review = fx.reviewQuarantined;
    if (!user || !review) throw new Error("fixtures.json needs legacyUsers[5] and reviewQuarantined (npm run db:seed-e2e)");
    const copied = ["Steam", "Mud", "Brick", "Cloud", "Stone"]; // the inventory's active non-starters
    const firsts = user.firstDiscovery!;

    // ---------------------------------------------------------------- A: binds the player
    await installLegacy(context, user);
    const sentA = recordBootstraps(page);
    const t0 = Date.now();
    const a = await game.open("/");
    const claimA = await page.evaluate((k) => localStorage.getItem(k), CLAIM_KEY);

    await test.step("A adopts the legacy player and stores its claim token first", async () => {
      expect(a.legacyImport).toMatchObject({ adopted: true, claimed: false });
      expect(a.player.legacy).toBe(true);
      expect(claimA).toMatch(/^[0-9a-f]{32}$/);
      expect(sentA.at(-1)?.legacy?.claim).toBe(claimA);
      for (const n of user.expectPresent) expect(names(a), `${n} restored`).toContain(n);
      for (const n of user.expectAbsent) expect(names(a), `${n} hidden`).not.toContain(n);
      expect(a.library.find((e) => e.name === firsts)?.first).toBe(true);
      expect(a.stats.firsts).toBeGreaterThanOrEqual(1);
      for (const h of user.history) expect(a.history.map((d) => d.day)).toContain(h.day);
      // Counts match what the player sees: quarantined (incl. 'review') and unknown ids are skipped.
      expect(a.legacyImport?.imported).toBe(copied.length);
      expect(a.legacyImport?.skipped).toBe(user.expectAbsent.length + 1);
      await expect(game.welcomeBack).toBeVisible();
      await expect(page.getByTestId("legacy-claimed")).toHaveCount(0);
      await snapshot(page, testInfo, "A-adopted");
    });

    await test.step("A: starters are dated at the player's creation and nothing restored looks new", async () => {
      for (const e of a.library.filter((x) => x.starter)) expect(e.discoveredAt, `${e.name} starter date`).toBe(a.player.createdAt);
      for (const e of a.library) expect(Date.parse(e.discoveredAt), `${e.name} is not dated now()`).toBeLessThan(t0 - CLOCK_MARGIN_MS);
    });

    await test.step("A: the purge-quarantined element is kept (hidden) for a restore", async () => {
      const rows = await dbLibrary(a.player.id);
      expect(rows).toContainEqual({ element_id: review.elementId, source: "legacy" });
      expect(names(a)).not.toContain(review.name);
    });

    // ---------------------------------------------------------------- B: same id, other browser
    const ctxB = await browser.newContext({ baseURL: testInfo.project.use.baseURL, viewport: testInfo.project.use.viewport });
    try {
      await installLegacy(ctxB, user);
      const pageB = await ctxB.newPage();
      const errorsB: string[] = [];
      pageB.on("pageerror", (e) => errorsB.push(e.stack ?? e.message));
      const sentB = recordBootstraps(pageB);
      const gameB = new Game(pageB, game.device);
      const t1 = Date.now();
      const b = await gameB.open("/");

      await test.step("B (no claim token of A's) gets a new player with a copy of the elements only", async () => {
        const claimB = await pageB.evaluate((k) => localStorage.getItem(k), CLAIM_KEY);
        expect(claimB).toMatch(/^[0-9a-f]{32}$/);
        expect(claimB).not.toBe(claimA);
        expect(sentB.every((r) => r.legacy?.userId === user.userId)).toBe(true);
        expect(b.legacyImport).toMatchObject({ adopted: false, claimed: true });
        expect(b.player.id).not.toBe(a.player.id);
        expect(b.player.legacy).toBe(false);
        expect(b.stats.firsts).toBe(0);
        expect(b.history).toEqual([]);
        expect(b.legacyImport?.imported).toBe(copied.length);
        for (const n of [...fx.starters, ...copied]) expect(names(b), `${n} copied`).toContain(n);
        expect(names(b), "a first stays with the bound player").not.toContain(firsts);
        for (const n of user.expectAbsent) expect(names(b)).not.toContain(n);
        expect(b.library.some((e) => e.first)).toBe(false);
        for (const n of copied) {
          const e = b.library.find((x) => x.name === n)!;
          expect(Date.parse(e.discoveredAt), `${n} is dated when it was made`).toBeLessThan(t1 - CLOCK_MARGIN_MS);
        }
        expect(await dbLibrary(b.player.id)).toContainEqual({ element_id: review.elementId, source: "legacy" });
      });

      await test.step("B: one notice explains where the progress is; no onboarding, no welcome-back", async () => {
        const notice = pageB.getByTestId("legacy-claimed");
        await expect(notice).toHaveCount(1);
        await expect(notice).toBeVisible();
        await expect(notice).toContainText("already linked to another browser");
        await expect(notice).toContainText("transfer code");
        await expect(gameB.onboarding).toBeHidden();
        await expect(gameB.welcomeBack).toHaveCount(0);
        await snapshot(pageB, testInfo, "B-claimed-elsewhere");
      });

      await test.step("B: a reload sends no legacy payload and keeps B's player", async () => {
        const before = sentB.length;
        const again = await gameB.reload();
        expect(sentB.slice(before).some((r) => r.legacy)).toBe(false);
        expect(again.player.id).toBe(b.player.id);
        expect(again.legacyImport).toBeUndefined();
        await expect(pageB.getByTestId("legacy-claimed")).toHaveCount(0);
      });
      expect(errorsB, "uncaught errors in B").toEqual([]);
    } finally {
      await ctxB.close();
    }

    // ---------------------------------------------------------------- A again, cookie cleared
    await test.step("A, with its cookie cleared, adopts the same player again with its token", async () => {
      await context.clearCookies();
      await page.evaluate(() => localStorage.removeItem("ia:legacyImported"));
      const again = await game.reload();
      expect(await page.evaluate((k) => localStorage.getItem(k), CLAIM_KEY)).toBe(claimA);
      expect(again.legacyImport).toMatchObject({ adopted: true, claimed: false });
      expect(again.player.id).toBe(a.player.id);
      expect(again.stats.firsts).toBe(a.stats.firsts);
      expect(again.history.map((d) => d.day)).toEqual(a.history.map((d) => d.day));
      await snapshot(page, testInfo, "A-readopted");
    });
  });
});
