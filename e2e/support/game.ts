// Page object for the game. All selectors live here so the specs read like the journeys
// they describe, and the data-testid contract (e2e/README.md) has one home.
import { expect, type Locator, type Page, type Response } from "@playwright/test";
import type { BootstrapResponse, CombineResponse, SortRequest, SortResponse } from "../../src/shared/api.ts";
import { center, drag, pressAndHold, tap, touchLongPress, type Point } from "./gestures.ts";

export interface Device {
  project: string;
  /** Index in PROJECTS; selects per-project fixture resources. */
  index: number;
  /** Chromium with touch emulation: gestures use CDP touch events. */
  touch: boolean;
  engine: "chromium" | "webkit" | "firefox";
}

const byTestId = (id: string, attrs: Record<string, string> = {}) =>
  `[data-testid="${id}"]` + Object.entries(attrs).map(([k, v]) => `[data-${k}="${cssEscape(v)}"]`).join("");

function cssEscape(s: string): string {
  return s.replace(/["\\]/g, "\\$&");
}

/** What to sort by: a rank prompt, or groups (blank rows are dropped; `other` sets the switch). */
export type CustomSortInput = string | { groups: string[]; other?: boolean };

export class Game {
  readonly app: Locator;
  readonly onboarding: Locator;
  readonly welcomeBack: Locator;
  readonly search: Locator;
  readonly canvas: Locator;
  readonly toasts: Locator;
  readonly discoveryCard: Locator;
  readonly challengeComplete: Locator;
  readonly challengesSheet: Locator;
  readonly settingsSheet: Locator;
  readonly customSortSheet: Locator;

  constructor(
    readonly page: Page,
    readonly device: Device,
  ) {
    this.app = page.getByTestId("app");
    this.onboarding = page.getByTestId("onboarding");
    this.welcomeBack = page.getByTestId("welcome-back");
    this.search = page.getByTestId("library-search");
    this.canvas = page.getByTestId("canvas");
    this.toasts = page.getByTestId("toast");
    this.discoveryCard = page.getByTestId("discovery-card");
    this.challengeComplete = page.getByTestId("challenge-complete");
    this.challengesSheet = page.getByTestId("challenges-sheet");
    this.settingsSheet = page.getByTestId("settings-sheet");
    this.customSortSheet = page.getByTestId("custom-sort-sheet");
  }

  // ------------------------------------------------------------------ locators

  libraryTile(name: string): Locator {
    return this.page.locator(byTestId("library-tile", { name }));
  }

  libraryTiles(): Locator {
    return this.page.getByTestId("library-tile");
  }

  canvasTile(name: string): Locator {
    return this.page.locator(byTestId("canvas-tile", { name }));
  }

  canvasTiles(): Locator {
    return this.page.getByTestId("canvas-tile");
  }

  toast(kind?: string): Locator {
    return kind ? this.page.locator(byTestId("toast", { kind })) : this.toasts;
  }

  // ------------------------------------------------------------------ lifecycle

  /** Navigate and wait until bootstrap (incl. PoW for new players) has succeeded. */
  async open(path = "/"): Promise<BootstrapResponse> {
    const boot = this.waitForBootstrap();
    await this.page.goto(path);
    const res = await boot;
    await this.waitReady();
    return res;
  }

  async reload(): Promise<BootstrapResponse> {
    const boot = this.waitForBootstrap();
    await this.page.reload();
    const res = await boot;
    await this.waitReady();
    return res;
  }

  /** Resolves with the first successful bootstrap body (a 401 pow_required precedes it for new players). */
  async waitForBootstrap(timeout = 45_000): Promise<BootstrapResponse> {
    const res = await this.page.waitForResponse(
      (r) => r.url().endsWith("/api/bootstrap") && r.request().method() === "POST" && r.status() === 200,
      { timeout },
    );
    return (await res.json()) as BootstrapResponse;
  }

  async waitReady(): Promise<void> {
    await expect(this.app).toHaveAttribute("data-ready", "true", { timeout: 45_000 });
  }

  async dismissOnboarding(): Promise<void> {
    await expect(this.onboarding).toBeVisible();
    await tap(this.page.getByTestId("onboarding-dismiss"), this.device.touch);
    await expect(this.onboarding).toBeHidden();
    await this.expectNoDialogs();
  }

  /** Modal dialogs (and their overlays) are fully gone, exit animations included. */
  async expectNoDialogs(): Promise<void> {
    await expect(this.page.locator('[role="dialog"], [role="alertdialog"]')).toHaveCount(0);
  }

  /** Fresh player: wait for onboarding and dismiss it so the board is free. */
  async startFresh(): Promise<BootstrapResponse> {
    const boot = await this.open();
    await this.dismissOnboarding();
    return boot;
  }

  // ------------------------------------------------------------------ library

  async libraryCount(): Promise<number> {
    const el = this.page.getByTestId("library-count").first();
    const attr = await el.getAttribute("data-count");
    const text = attr ?? (await el.textContent()) ?? "";
    const n = Number.parseInt(text.replace(/[^\d]/g, ""), 10);
    if (!Number.isFinite(n)) throw new Error(`library-count is not a number: "${text}"`);
    return n;
  }

  async expectLibraryCount(n: number): Promise<void> {
    await expect.poll(() => this.libraryCount(), { message: `library count should be ${n}` }).toBe(n);
  }

  async searchLibrary(query: string): Promise<void> {
    await this.search.fill(query);
  }

  async clearSearch(): Promise<void> {
    await this.search.fill("");
  }

  /** A visible library tile for `name`; searches for it when the list is long or virtualized. */
  async findInLibrary(name: string): Promise<Locator> {
    const tile = this.libraryTile(name).first();
    if (!(await tile.isVisible())) {
      await this.searchLibrary(name);
      await expect(tile).toBeVisible();
    }
    await tile.scrollIntoViewIfNeeded();
    return tile;
  }

  async openQuickActions(name: string): Promise<Locator> {
    const tile = await this.findInLibrary(name);
    if (this.device.touch) await touchLongPress(this.page, await center(tile));
    else await tile.click({ button: "right" });
    const menu = this.page.getByTestId("quick-actions");
    await expect(menu).toBeVisible();
    return menu;
  }

  /** Names of the rendered library tiles, in display order. */
  async libraryNames(): Promise<string[]> {
    return this.libraryTiles().evaluateAll((els) => els.map((e) => e.getAttribute("data-name") ?? ""));
  }

  // ------------------------------------------------------------------ custom sort

  sortSelect(): Locator {
    return this.page.getByTestId("sort-select");
  }

  customSortBar(): Locator {
    return this.page.getByTestId("custom-sort-bar");
  }

  /** Phones keep the sort controls in the expanded shelf (not in peek); the rail always shows them. */
  async openSortControls(): Promise<void> {
    const expand = this.page.getByRole("button", { name: "Expand library" });
    if (await expand.isVisible()) await tap(expand, this.device.touch);
    await expect(this.sortSelect()).toBeVisible();
  }

  /** Back to the phone shelf's peek row, so the canvas is free to play on (no-op on the rail). */
  async collapseLibrary(): Promise<void> {
    const collapse = this.page.getByRole("button", { name: "Collapse library" });
    if (!(await collapse.isVisible())) return;
    await tap(collapse, this.device.touch);
    // The peek row replaces the grid once the shelf has finished settling.
    await expect(this.libraryPeekRow()).toBeVisible();
  }

  /** The phone shelf's one-row library (peek); absent on the rail and while the shelf is open. */
  libraryPeekRow(): Locator {
    return this.page.locator('.peek-row[data-testid="library"]');
  }

  /** "Custom…" in the sort select opens "Sort by anything". */
  async openCustomSort(): Promise<Locator> {
    await this.openSortControls();
    await this.sortSelect().selectOption("__edit");
    await expect(this.customSortSheet).toBeVisible();
    await this.entranceDone(this.customSortSheet);
    return this.customSortSheet;
  }

  /** The element's own enter animation (a sheet sliding or scaling in) has finished. */
  async entranceDone(el: Locator): Promise<void> {
    await el.evaluate((node) => Promise.all(node.getAnimations().map((a) => a.finished.catch(() => undefined))));
  }

  /** Fill the sheet (opening it unless it already is) without applying. */
  async fillCustomSort(input: CustomSortInput): Promise<Locator> {
    const sheet = (await this.customSortSheet.isVisible()) ? this.customSortSheet : await this.openCustomSort();
    const mode = (m: string) => sheet.locator(`${byTestId("custom-sort-mode")} [data-mode="${m}"]`);
    if (typeof input === "string") {
      await tap(mode("rank"), this.device.touch);
      await sheet.getByTestId("custom-sort-input").fill(input);
      return sheet;
    }
    await tap(mode("groups"), this.device.touch);
    const fields = sheet.getByTestId("custom-sort-group");
    while ((await fields.count()) < input.groups.length) await tap(sheet.getByTestId("custom-sort-add-group"), this.device.touch);
    const rows = await fields.count();
    for (let i = 0; i < rows; i++) await fields.nth(i).fill(input.groups[i] ?? "");
    if (input.other !== undefined) {
      const sw = sheet.getByTestId("custom-sort-other");
      if ((await sw.getAttribute("aria-checked")) !== String(input.other)) await tap(sw, this.device.touch);
      await expect(sw).toHaveAttribute("aria-checked", String(input.other));
    }
    return sheet;
  }

  /** Fill and press Apply (or Done); the sheet closes. Waits for no request. */
  async submitCustomSort(input: CustomSortInput): Promise<void> {
    const sheet = await this.fillCustomSort(input);
    const apply = sheet.getByTestId("custom-sort-apply");
    await expect(apply).toBeEnabled();
    await tap(apply, this.device.touch);
    await expect(this.customSortSheet).toBeHidden();
  }

  /** Apply a custom sort that needs a full run; resolves with its /api/sort answer once it is on screen. */
  async applyCustomSort(input: CustomSortInput): Promise<SortResponse> {
    const sorted = this.nextSort();
    await this.submitCustomSort(input);
    const res = await sorted;
    const body = (await res.json()) as SortResponse;
    expect(res.status(), `sort failed: ${JSON.stringify(body)}`).toBe(200);
    await expect(this.customSortBar()).toHaveAttribute("data-status", "ready");
    return body;
  }

  /** The next /api/sort response (register before triggering it). */
  nextSort(): Promise<Response> {
    return this.page.waitForResponse((r) => r.url().endsWith("/api/sort") && r.request().method() === "POST", {
      timeout: 30_000,
    });
  }

  /** Every /api/sort request body sent from now on (keeps recording across reloads of this page). */
  recordSorts(): SortRequest[] {
    const sent: SortRequest[] = [];
    this.page.on("request", (r) => {
      if (r.url().endsWith("/api/sort") && r.method() === "POST") sent.push(r.postDataJSON() as SortRequest);
    });
    return sent;
  }

  // ------------------------------------------------------------------ canvas

  async canvasNames(): Promise<string[]> {
    return this.canvasTiles().evaluateAll((els) => els.map((e) => e.getAttribute("data-name") ?? ""));
  }

  /**
   * An empty spot on the canvas: the candidate farthest from existing tiles whose topmost
   * element is the canvas itself (not a tile, the toolbar, the shelf or an overlay).
   */
  async freeCanvasPoint(): Promise<Point> {
    let p: Point | null = null;
    // Retry briefly: a closing dialog or a settling tile can cover the canvas for a few frames.
    await expect
      .poll(async () => (p = await this.findFreeCanvasPoint()), { message: "a free spot on the canvas", timeout: 5_000 })
      .not.toBeNull();
    return p!;
  }

  private async findFreeCanvasPoint(): Promise<Point | null> {
    const p = await this.page.evaluate(() => {
      const canvas = document.querySelector('[data-testid="canvas"]');
      if (!canvas) return null;
      const r = canvas.getBoundingClientRect();
      const tiles = [...document.querySelectorAll('[data-testid="canvas-tile"]')].map((t) => {
        const b = t.getBoundingClientRect();
        return { x: b.x + b.width / 2, y: b.y + b.height / 2 };
      });
      let best: { x: number; y: number; d: number } | null = null;
      for (let fy = 0.22; fy <= 0.7; fy += 0.08) {
        for (let fx = 0.2; fx <= 0.8; fx += 0.075) {
          const x = r.x + r.width * fx;
          const y = r.y + r.height * fy;
          // the spot and a tile-sized neighborhood must be bare canvas
          const clear = [
            [0, 0],
            [-40, -40],
            [40, -40],
            [-40, 40],
            [40, 40],
          ].every(([ox, oy]) => {
            const hit = document.elementFromPoint(x + ox!, y + oy!);
            return !!hit && canvas.contains(hit) && !hit.closest('[data-testid="canvas-tile"], button, [role="dialog"]');
          });
          if (!clear) continue;
          const d = tiles.length ? Math.min(...tiles.map((t) => Math.hypot(t.x - x, t.y - y))) : 1e6 - Math.hypot(fx - 0.5, fy - 0.45);
          if (!best || d > best.d) best = { x, y, d };
        }
      }
      return best;
    });
    return p ? { x: p.x, y: p.y } : null;
  }

  /**
   * Center of a tile once it has stopped moving. Spawn springs overshoot (a tapped tile flies
   * past its spot and back) and pause for a moment at each turning point, so the tile must stay
   * within half a pixel for longer than half a period of the bounciest spring, sampled every frame.
   */
  async settledCenter(tile: Locator): Promise<Point> {
    return tile.evaluate(
      (el, { stillMs, timeoutMs }) =>
        new Promise<Point>((resolve) => {
          const start = performance.now();
          let anchor: Point | null = null;
          let stillSince = start;
          const step = () => {
            const b = el.getBoundingClientRect();
            const c = { x: b.x + b.width / 2, y: b.y + b.height / 2 };
            const now = performance.now();
            if (!anchor || Math.abs(c.x - anchor.x) > 0.5 || Math.abs(c.y - anchor.y) > 0.5) {
              anchor = c;
              stillSince = now;
            }
            if (now - stillSince >= stillMs || now - start >= timeoutMs) resolve(c);
            else requestAnimationFrame(step);
          };
          requestAnimationFrame(step);
        }),
      { stillMs: 300, timeoutMs: 4_000 },
    );
  }

  /** Drag a library element onto the canvas (empty spot or a point) and return its canvas tile. */
  async dragFromLibrary(name: string, to?: Point): Promise<Locator> {
    const before = await this.canvasTile(name).count();
    const tile = await this.findInLibrary(name);
    const from = await center(tile);
    const target = to ?? (await this.freeCanvasPoint());
    await drag(this.page, from, target, this.device.touch);
    if (!to) {
      await expect(this.canvasTile(name)).toHaveCount(before + 1);
      return this.canvasTile(name).nth(before);
    }
    return this.canvasTile(name).last();
  }

  /** Tap a library element: it spawns onto the canvas. */
  async spawnByTap(name: string): Promise<Locator> {
    const before = await this.canvasTile(name).count();
    await tap(await this.findInLibrary(name), this.device.touch);
    await expect(this.canvasTile(name)).toHaveCount(before + 1);
    const spawned = this.canvasTile(name).nth(before);
    await this.settledCenter(spawned);
    return spawned;
  }

  /** The next /api/combine response (register before triggering the combine). */
  nextCombine(): Promise<Response> {
    return this.page.waitForResponse((r) => r.url().endsWith("/api/combine") && r.request().method() === "POST", {
      timeout: 30_000,
    });
  }

  /**
   * Combine by dragging: `a` from the library onto an empty canvas spot, then each further
   * ingredient from the library onto it. Returns the server's answer for the final drop.
   */
  async combineByDrag(names: string[]): Promise<CombineResponse> {
    if (names.length !== 2) throw new Error("combineByDrag supports two ingredients");
    const [a, b] = names as [string, string];
    const placed = await this.dragFromLibrary(a);
    const target = await this.settledCenter(placed);
    const combined = this.nextCombine();
    await drag(this.page, await center(await this.findInLibrary(b)), target, this.device.touch);
    return this.expectCombineOk(await combined);
  }

  /** Accessible alternative: spawn both by tapping, then tap A (select) and tap B (combine). */
  async combineByTap(names: string[]): Promise<CombineResponse> {
    if (names.length !== 2) throw new Error("combineByTap supports two ingredients");
    const [a, b] = names as [string, string];
    const tileA = await this.spawnByTap(a);
    const tileB = await this.spawnByTap(b);
    await tap(tileA, this.device.touch);
    await expect(tileA).toHaveAttribute("data-selected", "true");
    const combined = this.nextCombine();
    await tap(tileB, this.device.touch);
    return this.expectCombineOk(await combined);
  }

  async expectCombineOk(res: Response): Promise<CombineResponse> {
    const body = (await res.json()) as CombineResponse & { error?: string };
    expect(res.status(), `combine failed: ${JSON.stringify(body)}`).toBe(200);
    await expect(this.canvasTile(body.result.name).first()).toBeVisible();
    await expect(this.canvasTile(body.result.name).first()).not.toHaveAttribute("data-pending", "true");
    return body;
  }

  /** Make every element of `recipes` in order (tap path: fastest and device-independent). */
  async makeAll(recipes: { ingredients: string[]; result: string }[]): Promise<CombineResponse[]> {
    const out: CombineResponse[] = [];
    for (const r of recipes) {
      const res = await this.combineByTap(r.ingredients);
      expect(res.result.name).toBe(r.result);
      out.push(res);
      await this.dismissCelebrations(res);
      await this.clearCanvas();
    }
    return out;
  }

  async clearCanvas(): Promise<void> {
    if ((await this.canvasTiles().count()) === 0) return;
    await tap(this.page.getByTestId("canvas-clear"), this.device.touch);
    await expect(this.canvasTiles()).toHaveCount(0);
  }

  /**
   * Close the celebration cards a combine produced (first-ever and/or challenge, queued one
   * after another), then wait until no modal is left on top of the board.
   */
  async dismissCelebrations(res?: CombineResponse): Promise<void> {
    const expected = (res?.firstEver ? 1 : 0) + (res?.completed.length ? 1 : 0);
    const cards = this.discoveryCard.or(this.challengeComplete);
    for (let shown = 0; shown < expected; shown++) {
      await expect(cards).toBeVisible();
      await this.page.keyboard.press("Escape");
      await expect(cards).toBeHidden();
    }
    // Anything else still up (e.g. a card from an earlier combine) goes too.
    while (await cards.isVisible()) {
      await this.page.keyboard.press("Escape");
      await expect(cards).toBeHidden();
    }
    await this.expectNoDialogs();
  }

  // ------------------------------------------------------------------ sheets

  async openChallenges(): Promise<Locator> {
    await tap(this.page.getByTestId("challenge-chip").first(), this.device.touch);
    await expect(this.challengesSheet).toBeVisible();
    return this.challengesSheet;
  }

  challengeTarget(tier: string): Locator {
    return this.page.locator(byTestId("challenge-target", { tier })).first();
  }

  async closeSheet(sheet: Locator): Promise<void> {
    await this.page.keyboard.press("Escape");
    await expect(sheet).toBeHidden();
  }

  async openSettings(): Promise<Locator> {
    await tap(this.page.getByTestId("menu-button"), this.device.touch);
    await expect(this.settingsSheet).toBeVisible();
    return this.settingsSheet;
  }

  /** Settings -> Reset progress -> hold the confirm button for `holdMs`. */
  async resetProgress(holdMs = 2_200): Promise<void> {
    const settings = await this.openSettings();
    await tap(settings.getByTestId("reset-progress"), this.device.touch);
    const confirm = this.page.getByTestId("reset-confirm");
    await expect(confirm).toBeVisible();
    await pressAndHold(this.page, await center(confirm), holdMs, this.device.touch);
  }
}
