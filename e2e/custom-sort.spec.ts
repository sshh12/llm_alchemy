// (12) Custom library sort ("Sort by anything"): a player's own words order the library. The
// server scores with the deterministic mock (AI_MODE=mock: weather words score 850+, everything
// else below 500), so the orders below are exact. Covers the whole-library run, the session
// mirror on reload, discoveries scored inside /api/combine with the batched /api/sort fallback,
// failures, groups with bucket chips and Other, reverse/clear, the search bridge and layout.
import type { Page } from "@playwright/test";
import type { ApiError, ElementId } from "../src/shared/api.ts";
import { recipePathTo, type Fixtures, type Recipe } from "./support/fixtures.ts";
import { tap } from "./support/gestures.ts";
import { expect, test } from "./support/test.ts";

/** Weather elements reachable in five combines (Steam, Cloud, Energy, Storm, Rain). */
const WEATHER = ["Cloud", "Storm", "Rain"];

function pathsTo(fx: Fixtures, targets: string[]): Recipe[] {
  const out: Recipe[] = [];
  for (const t of targets) for (const r of recipePathTo(fx, t)) if (!out.some((x) => x.result === r.result)) out.push(r);
  return out;
}

async function failNext(page: Page, path: string, status: number, body: ApiError): Promise<void> {
  await page.route(`**${path}`, (route) =>
    route.fulfill({
      status,
      contentType: "application/json",
      headers: { "retry-after": String(Math.ceil((body.retryAfterMs ?? 1000) / 1000)) },
      body: JSON.stringify(body),
    }),
  );
}

/** Raw codes or status numbers must never reach the player. */
const RAW = /rate_limited|budget_exhausted|ai_unavailable|\b429\b|\b503\b|error code|undefined/i;

/** Finger-sized on phones/tablets (44 px), WCAG 2.5.8's 24 px for a mouse (as in layout.spec.ts). */
const minTarget = (project: string) => (project === "desktop-chrome" ? 24 : 44);

const tileAttr = (page: Page, attr: string) =>
  page.getByTestId("library-tile").evaluateAll((els, a) => els.map((e) => e.getAttribute(a)), attr);

test("weather ranks weather first and survives reload", async ({ page, game, fx, snap }) => {
  await game.startFresh();
  await game.makeAll(pathsTo(fx, WEATHER));
  const owned = fx.starters.length + 5;
  await expect(game.libraryTiles()).toHaveCount(owned);

  const sheet = await game.openCustomSort();
  await expect(sheet.getByTestId("custom-sort-example")).toHaveCount(8);
  await expect(sheet.getByTestId("custom-sort-apply")).toHaveText(`Sort ${owned} elements`);
  await snap("sheet rank");

  // Hold the answer back for a moment so the weighing state is observable.
  await page.route("**/api/sort", async (route) => {
    await new Promise((r) => setTimeout(r, 2_500));
    await route.continue();
  });
  const recentOrder = await game.libraryNames();
  const sorted = game.nextSort();
  await game.submitCustomSort("weather");
  await expect(game.sortSelect()).toHaveValue("custom");
  await expect(game.customSortBar()).toHaveAttribute("data-status", "scoring");
  await expect(game.customSortBar()).toContainText(`Weighing ${owned}…`);
  await expect(page.getByTestId("library")).toHaveAttribute("data-sort-state", "scoring");
  expect(await game.libraryNames(), "the old order stays while weighing").toEqual(recentOrder);
  await snap("scoring");

  const res = await sorted;
  expect(res.status()).toBe(200);
  const body = (await res.json()) as { engine: string; ids: ElementId[] };
  await page.unroute("**/api/sort");
  expect(body.engine).toMatch(/^mock\//);
  expect(body.ids).toHaveLength(owned);
  await expect(game.customSortBar()).toHaveAttribute("data-status", "ready");
  await expect(page.getByTestId("library")).toHaveAttribute("data-sort-state", "ready");

  await expect.poll(async () => new Set((await game.libraryNames()).slice(0, 3))).toEqual(new Set(WEATHER));
  expect(await tileAttr(page, "data-score"), "every tile is weighed").toEqual(Array.from({ length: owned }, () => expect.stringMatching(/^\d+$/)));
  await expect(page.getByTestId("custom-sort-matches")).toContainText("Matches 3");
  await snap("rank result");

  // The details popover places the element in the order.
  const menu = await game.openQuickActions("Cloud");
  await expect(menu.getByTestId("quick-actions-custom-sort")).toHaveText(
    new RegExp(`^#[1-3] of ${owned} for “weather” · (Clear|Perfect) match$`),
  );
  await snap("details line");
  await page.keyboard.press("Escape");
  await expect(menu).toBeHidden();
  await game.clearSearch();
  const order = await game.libraryNames();

  // Reload: the session mirror puts the same order back without asking the server again.
  const sent = game.recordSorts();
  await game.reload();
  await game.openSortControls();
  await expect(game.sortSelect()).toHaveValue("custom");
  await expect(game.customSortBar()).toHaveAttribute("data-status", "ready");
  await expect.poll(() => game.libraryNames()).toEqual(order);
  await page.waitForTimeout(3_000); // longer than the incremental flush debounce
  expect(sent, "no /api/sort after a reload with the session mirror").toEqual([]);
});

test("a new discovery is scored inside combine", async ({ page, game, device, snap }) => {
  await game.startFresh();
  await game.openSortControls();
  await game.applyCustomSort("weather");
  await game.collapseLibrary();
  if (device.project !== "desktop-chrome" && device.project !== "ipad") {
    await expect(page.getByTestId("custom-sort-peek")).toBeVisible();
    await snap("peek");
  }

  const sent = game.recordSorts();
  const res = await game.combineByTap(["Water", "Earth"]);
  expect(res.result.name).toBe("Mud");
  expect(res.newForPlayer).toBe(true);
  expect(res.sortScore, "combine carries the score of a discovery").toMatchObject({ s: expect.any(Number) });
  await game.dismissCelebrations(res);

  await game.openSortControls();
  await expect(game.libraryTile("Mud")).toHaveAttribute("data-score", String(res.sortScore!.s));
  await page.waitForTimeout(4_000);
  expect(sent, "the piggybacked score needs no /api/sort").toEqual([]);
});

test("falls back to a batched /api/sort when combine brings no score", async ({ page, game }) => {
  await game.startFresh();
  await game.openSortControls();
  await game.applyCustomSort("weather");
  await game.collapseLibrary();

  // As if scoring inside combine had timed out.
  await page.route("**/api/combine", async (route) => {
    const response = await route.fetch();
    const body = (await response.json()) as Record<string, unknown>;
    delete body.sortScore;
    await route.fulfill({ response, json: body });
  });
  const sent = game.recordSorts();
  const res = await game.combineByTap(["Water", "Earth"]);
  expect(res.result.name).toBe("Mud");
  expect(res.sortScore).toBeUndefined();
  await game.dismissCelebrations(res);

  await expect.poll(() => sent.length, { timeout: 6_000, message: "one batched /api/sort" }).toBe(1);
  expect(sent[0]).toEqual({ spec: { kind: "rank", prompt: "weather" }, ids: [res.result.id] });
  await game.openSortControls();
  await expect(game.libraryTile("Mud")).toHaveAttribute("data-score", /^\d+$/);
  await page.waitForTimeout(3_000);
  expect(sent).toHaveLength(1);
  await page.unroute("**/api/combine");
});

test("custom sort failures are friendly and recoverable", async ({ page, game, device, snap }) => {
  await game.startFresh();
  await game.openSortControls();
  const recentOrder = await game.libraryNames();

  // The provider is down: one silent retry, then a calm message; the order on screen stays.
  await failNext(page, "/api/sort", 503, { error: "ai_unavailable", message: "jev: provider rejected the request (500)" });
  await game.submitCustomSort("weather");
  const bar = game.customSortBar();
  await expect(bar).toHaveAttribute("data-status", "error", { timeout: 20_000 });
  const message = page.getByTestId("custom-sort-message");
  await expect(message).toHaveText(/The lab's scales are busy\. Your order is safe\./);
  await expect(message).toHaveAttribute("role", "alert");
  await expect(bar).not.toContainText(RAW);
  expect(await game.libraryNames(), "the Recent order stays").toEqual(recentOrder);
  await snap("error");

  await page.unroute("**/api/sort");
  const retried = game.nextSort();
  await tap(page.getByTestId("custom-sort-retry"), device.touch);
  // Keyboard/mouse only: a tap never moves focus (see wantsFocusHandoff).
  if (device.touch) await expect(page.getByTestId("custom-sort-edit"), "a tap on Retry leaves focus alone").not.toBeFocused();
  else await expect(page.getByTestId("custom-sort-edit"), "Retry hands focus to the lens (its line goes)").toBeFocused();
  expect((await retried).status()).toBe(200);
  await expect(bar).toHaveAttribute("data-status", "ready");
  // No starter is weathery: the error gives way to the weak-match hint.
  await expect(message).toHaveText(/^Nothing clearly matches “weather”. Try a quality, like “cutest”.Edit$/);
  await expect(message).toHaveAttribute("role", "status");

  // Rate limited: a countdown, still friendly.
  await failNext(page, "/api/sort", 429, { error: "rate_limited", message: "Easy there, alchemist. Try again in a moment.", retryAfterMs: 20_000 });
  await tap(page.getByTestId("custom-sort-edit"), device.touch);
  await expect(game.customSortSheet).toBeVisible();
  await game.submitCustomSort("spookiest");
  await expect(message).toHaveText(/^Easy there, alchemist\. Weighing resumes in 0:[0-2]\d\.$/);
  await expect(bar).not.toContainText(RAW);
  await snap("rate limited");
  await page.unroute("**/api/sort");
});

test("groups: bucket chips, weak fits in Other, and Done without a request", async ({ page, game, fx, device, snap }) => {
  await game.startFresh();
  await game.makeAll(pathsTo(fx, WEATHER));
  const owned = fx.starters.length + 5;

  const res = await game.applyCustomSort({ groups: ["Weather", "Space"] });
  expect(res.g).toHaveLength(owned);
  expect(res.n).toHaveLength(owned);
  await expect(game.customSortBar()).toHaveAttribute("data-kind", "groups");
  const bucket = (b: string) => page.locator(`[data-testid="custom-sort-bucket"][data-bucket="${b}"]`);
  await expect(bucket("all")).toContainText(`All ${owned}`);
  await expect(bucket("0")).toContainText("Weather 3");
  await expect(bucket("1")).toContainText("Space 0");
  await expect(bucket("other")).toContainText(`Other ${owned - 3}`);
  // Groups are contiguous: the weather group first, then Other.
  await expect.poll(async () => new Set((await game.libraryNames()).slice(0, 3))).toEqual(new Set(WEATHER));
  for (const s of fx.starters) await expect(game.libraryTile(s)).toHaveAttribute("data-group", "other");
  await snap("groups result");

  await tap(bucket("0"), device.touch);
  await expect(bucket("0")).toHaveAttribute("aria-pressed", "true");
  await expect.poll(async () => new Set(await game.libraryNames())).toEqual(new Set(WEATHER));
  expect(await tileAttr(page, "data-group")).toEqual(["0", "0", "0"]);
  await tap(bucket("0"), device.touch);
  await expect(game.libraryTiles()).toHaveCount(owned);

  // Only the Other switch changed: "Done" re-renders the order with no request.
  const sent = game.recordSorts();
  await tap(page.getByTestId("custom-sort-edit"), device.touch);
  const sheet = game.customSortSheet;
  await expect(sheet).toBeVisible();
  await expect(sheet.getByTestId("custom-sort-group").nth(0)).toHaveValue("Weather");
  await tap(sheet.getByTestId("custom-sort-other"), device.touch);
  await expect(sheet.getByTestId("custom-sort-other")).toHaveAttribute("aria-checked", "false");
  await expect(sheet.getByTestId("custom-sort-apply")).toHaveAttribute("data-action", "done");
  await expect(sheet.getByTestId("custom-sort-apply")).toHaveText("Done");
  await tap(sheet.getByTestId("custom-sort-apply"), device.touch);
  await expect(sheet).toBeHidden();
  await expect(page.locator('[data-testid="library-tile"][data-cs="other"]')).toHaveCount(0);
  await expect(bucket("other")).toHaveCount(0);
  await page.waitForTimeout(1_000);
  expect(sent).toEqual([]);
});

test("reverse and clear never ask the server", async ({ page, game, device }) => {
  await game.startFresh();
  await game.openSortControls();
  const recentOrder = await game.libraryNames();
  await game.applyCustomSort("weather");
  // Every tile must carry a numeric score first: a missing data-score would read as 0, and an
  // all-zero list passes both checks. The ends must also differ, so an unchanged order fails.
  const scores = async () => {
    const raw = await tileAttr(page, "data-score");
    return raw.length > 1 && raw.every((s) => s !== null && /^\d+$/.test(s)) ? raw.map(Number) : null;
  };
  const desc = (xs: number[] | null) => !!xs && xs[0]! > xs.at(-1)! && xs.every((x, i) => i === 0 || xs[i - 1]! >= x);
  const asc = (xs: number[] | null) => !!xs && xs[0]! < xs.at(-1)! && xs.every((x, i) => i === 0 || xs[i - 1]! <= x);
  expect(await scores(), "every tile has a numeric score").not.toBeNull();
  expect(desc(await scores()), "strongest match first").toBe(true);

  const sent = game.recordSorts();
  const reverse = page.getByTestId("custom-sort-reverse");
  await tap(reverse, device.touch);
  await expect(reverse).toHaveAttribute("aria-pressed", "true");
  await expect(page.getByTestId("custom-sort-edit")).toContainText("“weather”, reversed");
  await expect.poll(async () => asc(await scores()), { message: "weakest match first" }).toBe(true);

  await tap(page.getByTestId("custom-sort-clear"), device.touch);
  await expect(game.sortSelect()).toHaveValue("recent");
  await expect(game.customSortBar()).toHaveCount(0);
  // Keyboard/mouse only: focusing the select from a tap could open the iOS picker wheel.
  if (device.touch) await expect(game.sortSelect(), "a tap on × leaves focus alone").not.toBeFocused();
  else await expect(game.sortSelect(), "× hands focus to the select (the bar is gone)").toBeFocused();
  await expect.poll(() => game.libraryNames()).toEqual(recentOrder);
  await expect(game.libraryTiles().first()).not.toHaveAttribute("data-score", /.*/);

  // "✦ Weather" re-applies it from memory, still reversed (same spec, same view).
  await expect(game.sortSelect().locator('option[value="custom"]')).toHaveText("✦ Weather");
  await game.sortSelect().selectOption("custom");
  await expect(game.customSortBar()).toHaveAttribute("data-status", "ready");
  await expect(reverse).toHaveAttribute("aria-pressed", "true");
  await expect.poll(async () => asc(await scores()), { message: "re-applied with every score, still weakest first" }).toBe(true);
  await page.waitForTimeout(1_000);
  expect(sent, "reverse, clear and re-select are all client-side").toEqual([]);
});

test("arrowing through the sort select arms ✦ and Custom… instead of applying them", async ({ page, game, device }) => {
  test.skip(device.project !== "desktop-chrome", "keyboard on a closed native <select> (Chromium on Windows/Linux)");
  await game.startFresh();
  await game.openSortControls();
  const select = game.sortSelect();
  await expect(select).toHaveValue("recent");
  await select.focus();
  // Recent → A–Z → Rarity → Custom…: each step fires `change`; the last one only arms.
  for (let i = 0; i < 3; i++) await page.keyboard.press("ArrowDown");
  await expect(select).toHaveValue("__edit");
  await expect(select).toHaveAttribute("data-armed", "__edit");
  await expect(game.customSortSheet).toBeHidden();
  await page.keyboard.press("Enter");
  await expect(game.customSortSheet).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(game.customSortSheet).toBeHidden();
  await expect(select).toBeFocused();
  await expect(select, "back on the last real sort").toHaveValue("rarity");
  await expect(select).not.toHaveAttribute("data-armed", /.*/);

  // Leaving an armed select disarms it.
  await page.keyboard.press("ArrowDown");
  await expect(select).toHaveAttribute("data-armed", "__edit");
  await page.keyboard.press("Tab");
  await expect(select).toHaveValue("rarity");
  await expect(select).not.toHaveAttribute("data-armed", /.*/);
  await expect(game.customSortSheet).toBeHidden();

  // Type-ahead steps too: "c" jumps to Custom…, which only arms.
  await select.focus();
  await page.keyboard.press("c");
  await expect(select).toHaveValue("__edit");
  await expect(select).toHaveAttribute("data-armed", "__edit");
  await expect(game.customSortSheet).toBeHidden();
  await page.keyboard.press("Escape");
  await expect(select).toHaveValue("rarity");
  await expect(select).not.toHaveAttribute("data-armed", /.*/);

  // With a stored sort that is not cached (a new tab: no memory, no session copy), the "✦ …"
  // option sits between Rarity and Custom…. Arrowing past it must not start a weighing run.
  await game.applyCustomSort("weather");
  await select.selectOption("rarity");
  await page.evaluate(() => sessionStorage.clear());
  await game.reload();
  await game.openSortControls();
  await expect(select).toHaveValue("rarity");
  const sent = game.recordSorts();
  await select.focus();
  await page.keyboard.press("ArrowDown");
  await expect(select).toHaveValue("custom");
  await expect(select).toHaveAttribute("data-armed", "custom");
  await page.keyboard.press("ArrowDown");
  await expect(select).toHaveValue("__edit");
  await expect(select).toHaveAttribute("data-armed", "__edit");
  await page.keyboard.press("Escape");
  await expect(select, "back on the real sort").toHaveValue("rarity");
  await page.waitForTimeout(1_000); // longer than any deferral
  expect(sent, "stepping past ✦ costs nothing").toEqual([]);
  await expect(game.customSortBar()).toBeHidden();

  // Enter on an armed ✦ applies it (one whole-library run).
  const sorted = game.nextSort();
  await page.keyboard.press("ArrowDown");
  await expect(select).toHaveAttribute("data-armed", "custom");
  await page.keyboard.press("Enter");
  expect((await sorted).status()).toBe(200);
  await expect(select).toHaveValue("custom");
  await expect(select).not.toHaveAttribute("data-armed", /.*/);
  await expect(game.customSortBar()).toHaveAttribute("data-status", "ready");
});

test("a search that finds nothing becomes a custom sort", async ({ page, game, fx, device, snap }) => {
  await game.startFresh();
  await game.searchLibrary("storm");
  await expect(game.libraryTiles()).toHaveCount(0);
  const bridge = page.getByTestId("custom-sort-from-search");
  await expect(bridge).toHaveText("Rank everything by “storm”");

  const sorted = game.nextSort();
  await tap(bridge, device.touch);
  expect((await sorted).status()).toBe(200);
  await expect(game.search).toHaveValue("");
  if (device.touch) await expect(page.getByTestId("custom-sort-edit"), "a tap on the chip leaves focus alone").not.toBeFocused();
  else await expect(page.getByTestId("custom-sort-edit"), "the chip hands focus to the new bar's lens").toBeFocused();
  await expect(game.customSortBar()).toHaveAttribute("data-status", "ready");
  await expect(page.getByTestId("custom-sort-matches")).toHaveAttribute("aria-pressed", "true");
  // Nothing the player owns is stormy yet: the bucket is empty and its own empty state says so
  // (scoped to it: the bar's weak-match line starts with the same words).
  const empty = page.getByTestId("library-empty");
  await expect(empty).toHaveAttribute("data-state", "matches");
  await expect(empty).toContainText("Nothing clearly matches “storm”.");
  await expect(empty).toContainText("Tap Matches again to see everything.");
  await expect(game.libraryTiles()).toHaveCount(0);
  await snap("bridge");

  await tap(page.getByTestId("custom-sort-matches"), device.touch);
  await expect(game.libraryTiles()).toHaveCount(fx.starters.length);
});

test("layout: custom sort sheet and bar fit @layout", async ({ page, game, device, snap }) => {
  await game.startFresh();
  const MIN = minTarget(device.project);
  const sheet = await game.openCustomSort();
  const fit = await sheet.evaluate((el) => {
    const r = el.getBoundingClientRect();
    const body = el.querySelector(".sheet-body") ?? el;
    return {
      inside: r.left >= -1 && r.top >= -1 && r.right <= window.innerWidth + 1 && r.bottom <= window.innerHeight + 1,
      overflow: Math.max(el.scrollWidth - el.clientWidth, body.scrollWidth - body.clientWidth),
      page: Math.max(document.documentElement.scrollWidth, document.body.scrollWidth) - document.documentElement.clientWidth,
    };
  });
  expect(fit.inside, "sheet inside the viewport").toBe(true);
  expect(fit.overflow, "no sideways scroll inside the sheet").toBeLessThanOrEqual(0);
  expect(fit.page, "no sideways page scroll").toBeLessThanOrEqual(0);
  const input = sheet.getByTestId("custom-sort-input");
  // iOS zooms into inputs under 16px.
  expect(await input.evaluate((el) => parseFloat(getComputedStyle(el).fontSize))).toBeGreaterThanOrEqual(16);
  const size = async (id: string) => {
    const box = await page.getByTestId(id).first().boundingBox();
    expect(box, `${id} is rendered`).not.toBeNull();
    return Math.min(box!.width, box!.height);
  };
  expect.soft(await size("custom-sort-apply"), "custom-sort-apply").toBeGreaterThanOrEqual(MIN);
  await snap("sheet");

  await game.submitCustomSort("weather");
  await expect(game.customSortBar()).toHaveAttribute("data-status", "ready");
  for (const id of ["custom-sort-edit", "custom-sort-reverse", "custom-sort-clear"]) {
    expect.soft(await size(id), id).toBeGreaterThanOrEqual(MIN);
  }
  const pageOverflow = await page.evaluate(
    () => Math.max(document.documentElement.scrollWidth, document.body.scrollWidth) - document.documentElement.clientWidth,
  );
  expect(pageOverflow, "no sideways page scroll with the bar").toBeLessThanOrEqual(0);
  await snap("bar");

  // Phone peek: the ✦ says a custom order is on and opens the controls.
  await game.collapseLibrary();
  const peek = page.getByTestId("custom-sort-peek");
  if ((await page.getByRole("button", { name: "Expand library" }).count()) > 0) {
    await expect(peek).toBeVisible();
    expect.soft(await size("custom-sort-peek"), "custom-sort-peek").toBeGreaterThanOrEqual(MIN);
    // The peek row clips vertically: every tile's meter must sit inside it.
    const clipped = await game.libraryPeekRow().evaluate((row) => {
      const r = row.getBoundingClientRect();
      return [...row.querySelectorAll('[data-testid="library-tile"][data-cs]')]
        .filter((t) => {
          const m = getComputedStyle(t, "::after");
          const top = t.getBoundingClientRect().top + parseFloat(m.top);
          return top < r.top - 0.5 || top + parseFloat(m.height) > r.bottom + 0.5;
        })
        .map((t) => t.getAttribute("data-name"));
    });
    expect(clipped, "peek tiles whose meter is clipped").toEqual([]);
    await expect(game.libraryPeekRow().locator('[data-testid="library-tile"][data-cs="rank"]').first()).toBeVisible();
    await snap("peek");
    await tap(peek, device.touch);
    await expect(game.customSortBar()).toBeVisible();
  } else {
    await expect(peek).toHaveCount(0);
  }
});
