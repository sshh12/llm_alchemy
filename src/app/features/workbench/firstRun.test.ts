import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ElementDTO, LibraryEntry } from "../../../shared/api.ts";
import { coachText, demoSpots } from "./firstRun.ts";

const B = { w: 400, h: 600, left: 8, right: 8, top: 8, bottom: 8 };

describe("coach copy", () => {
  it("names the real gesture for the device", () => {
    expect(coachText("drag", "Water", "Fire", null)).toBe("Drag Water onto Fire");
    expect(coachText("tap", "Water", "Fire", null)).toBe("Tap Water, then tap Fire");
  });

  it("asks for the other tile once one is selected (tapTile selects, the next tap combines)", () => {
    expect(coachText("tap", "Water", "Fire", "a")).toBe("Now tap Fire");
    expect(coachText("tap", "Water", "Fire", "b")).toBe("Now tap Water");
    expect(coachText("drag", "Water", "Fire", "a")).toBe("Now click Fire");
  });
});

describe("demoSpots", () => {
  it("puts the pair side by side, one tile apart, a little above the middle", () => {
    const [a, b] = demoSpots(B, 76, []);
    expect(a.y).toBe(b.y);
    expect(b.x - a.x).toBe(152);
    expect((a.x + b.x) / 2).toBe(200);
    expect(a.y).toBeLessThan(300);
    expect(a.y).toBeGreaterThan(200);
  });

  it("stays inside a narrow canvas and out of obstacles", () => {
    const narrow = { ...B, w: 200 };
    for (const p of demoSpots(narrow, 76, [])) {
      expect(p.x - 38).toBeGreaterThanOrEqual(narrow.left);
      expect(p.x + 38).toBeLessThanOrEqual(narrow.w - narrow.right);
    }
    const block = { x: 0, y: 180, w: 400, h: 120 };
    for (const p of demoSpots(B, 76, [block])) expect(p.y + 38 <= block.y || p.y - 38 >= block.y + block.h).toBe(true);
  });

  it("goes below the collapsed welcome card on a short canvas (no room above it)", () => {
    const short = { ...B, w: 360, h: 240 };
    const card = { x: 6, y: 4, w: 348, h: 66 }; // the measured card plus its 6 px margin
    for (const p of demoSpots(short, 76, [card])) {
      expect(p.y - 38).toBeGreaterThanOrEqual(card.y + card.h);
      expect(p.y + 38).toBeLessThanOrEqual(short.h - short.bottom);
    }
    // A wide canvas whose card sits off to the left keeps the usual row.
    expect(demoSpots(B, 76, [{ x: 6, y: 4, w: 40, h: 66 }])).toEqual(demoSpots(B, 76, []));
  });
});

// ------------------------------------------------------------------ enterFirstRun (fresh module per test)

function memoryStorage(): Storage {
  const m = new Map<string, string>();
  return {
    get length() {
      return m.size;
    },
    clear: () => m.clear(),
    getItem: (k) => m.get(k) ?? null,
    key: (i) => [...m.keys()][i] ?? null,
    removeItem: (k) => void m.delete(k),
    setItem: (k, v) => void m.set(k, String(v)),
  };
}

const el = (id: string, name: string): ElementDTO => ({
  id,
  name,
  emoji: null,
  img: null,
  art: "missing",
  description: null,
  notable: false,
  depth: 0,
  rarity: "common",
  starter: true,
});
const STARTERS = [el("1", "Earth"), el("2", "Water"), el("3", "Air"), el("4", "Fire"), el("5", "Time")];

async function load() {
  vi.resetModules();
  const game = await import("../../state/game.ts");
  const canvas = await import("../../state/canvas.ts");
  const ui = await import("../../state/ui.ts");
  const fr = await import("./firstRun.ts");
  game.useGame.setState({
    status: "ready",
    elements: Object.fromEntries(STARTERS.map((e) => [e.id, e])),
    owned: Object.fromEntries(STARTERS.map((e) => [e.id, { discoveredAt: "2026-11-30T00:00:00Z", first: false } satisfies Omit<LibraryEntry, keyof ElementDTO>])),
  });
  canvas.useCanvas.setState({ bounds: B, T: 76, size: { w: B.w, h: B.h } });
  return { game, canvas, ui, fr };
}

/** The Workbench measuring itself again (it does in the commit that mounts the welcome card). */
const remeasure = (canvas: Awaited<ReturnType<typeof load>>["canvas"], obstacles: { x: number; y: number; w: number; h: number }[] = []) =>
  canvas.useCanvas.setState({ obstacles });

describe("enterFirstRun", () => {
  let local: Storage;
  let gtag: ReturnType<typeof vi.fn>;
  const events = () => gtag.mock.calls.filter((c) => c[0] === "event").map((c) => [c[1], c[2]]);

  beforeEach(() => {
    local = memoryStorage();
    gtag = vi.fn();
    vi.stubGlobal("window", { localStorage: local, sessionStorage: memoryStorage(), gtag });
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("a brand-new player gets the demo pair on the board, the coach and the collapsed welcome", async () => {
    const { game, canvas, ui, fr } = await load();
    game.useGame.setState({ powSolving: true }); // this load solved proof-of-work: it created the player
    game.useGame.setState({ powSolving: false });
    fr.enterFirstRun({ welcome: true });
    remeasure(canvas);
    const tiles = canvas.useCanvas.getState().tiles;
    expect(tiles.map((t) => t.elementId)).toEqual(["2", "4"]); // Water, Fire
    const coach = ui.useUi.getState().coach;
    expect(coach).toMatchObject({ a: tiles[0]!.uid, b: tiles[1]!.uid });
    expect(ui.useUi.getState().welcome).toBe("collapsed");
    expect(events()).toEqual([["coach", { action: "shown", mode: "tap" }]]);
    // Once per page load.
    fr.enterFirstRun({ welcome: true });
    expect(canvas.useCanvas.getState().tiles).toHaveLength(2);
  });

  it("the first combine ends the coach (done, demo pair) and onboards the player", async () => {
    const { game, canvas, ui, fr } = await load();
    game.useGame.setState({ powSolving: true });
    fr.enterFirstRun({ welcome: true });
    remeasure(canvas);
    const [a, b] = canvas.useCanvas.getState().tiles;
    fr.noteCombine([a!.uid, b!.uid]);
    expect(ui.useUi.getState().coach).toBeNull();
    expect(local.getItem("ia:onboarded")).toBe("1");
    expect(events().at(-1)).toEqual(["coach", { action: "done", mode: "tap", secs: 0, demo: true }]);
    // The card stays (collapsed) until the player closes it.
    expect(ui.useUi.getState().welcome).toBe("collapsed");
  });

  it("taking a demo tile off the board without combining dismisses the coach", async () => {
    const { game, canvas, ui, fr } = await load();
    game.useGame.setState({ powSolving: true });
    fr.enterFirstRun({ welcome: true });
    remeasure(canvas);
    const [a] = canvas.useCanvas.getState().tiles;
    canvas.removeTiles([a!.uid]);
    await vi.runAllTimersAsync();
    expect(ui.useUi.getState().coach).toBeNull();
    expect(events().at(-1)).toEqual(["coach", { action: "dismiss", mode: "tap", secs: 0, via: "removed" }]);
    expect(local.getItem("ia:coachDone")).toBe("1");
  });

  it("a merge in flight (or one that fails and restores its inputs) keeps the coach", async () => {
    const { game, canvas, ui, fr } = await load();
    game.useGame.setState({ powSolving: true });
    fr.enterFirstRun({ welcome: true });
    remeasure(canvas);
    const [a, b] = canvas.useCanvas.getState().tiles;
    const saved = [a!, b!].map((t) => ({ uid: t.uid, elementId: t.elementId!, x: t.x, y: t.y }));
    canvas.addTile({ uid: "p", elementId: null, x: 0, y: 0, pending: { ingredients: ["2", "4"], inputs: saved } });
    canvas.markLeaving([a!.uid, b!.uid]);
    canvas.removeTiles([a!.uid, b!.uid]);
    await vi.runAllTimersAsync();
    expect(ui.useUi.getState().coach).not.toBeNull();
    // The combine failed: the pending tile goes and the inputs come back (two store updates).
    canvas.removeTiles(["p"]);
    for (const t of saved) canvas.addTile(t);
    await vi.runAllTimersAsync();
    expect(ui.useUi.getState().coach).not.toBeNull();
  });

  it("no seeding for a player this load did not create; the coach returns if the pair is still there", async () => {
    const { canvas, ui, fr } = await load();
    canvas.addTile({ elementId: "2", x: 100, y: 200 });
    canvas.addTile({ elementId: "4", x: 250, y: 200 });
    fr.enterFirstRun({ welcome: true });
    expect(canvas.useCanvas.getState().tiles).toHaveLength(2);
    expect(ui.useUi.getState().coach).not.toBeNull();
  });

  it("no coach once the player has ever combined, or after the coach was done", async () => {
    local.setItem("ia:hasMerged", "1");
    let m = await load();
    m.canvas.addTile({ elementId: "2", x: 100, y: 200 });
    m.canvas.addTile({ elementId: "4", x: 250, y: 200 });
    m.fr.enterFirstRun({ welcome: false });
    expect(m.ui.useUi.getState().coach).toBeNull();
    expect(m.ui.useUi.getState().welcome).toBeNull();

    local.clear();
    local.setItem("ia:coachDone", "1");
    m = await load();
    m.canvas.addTile({ elementId: "2", x: 100, y: 200 });
    m.canvas.addTile({ elementId: "4", x: 250, y: 200 });
    m.fr.enterFirstRun({ welcome: true });
    expect(m.ui.useUi.getState().coach).toBeNull();
  });

  it("a brand-new player whose board already has tiles (earlier state here) is left alone", async () => {
    const { game, canvas, ui, fr } = await load();
    canvas.addTile({ elementId: "1", x: 100, y: 200 });
    game.useGame.setState({ powSolving: true });
    fr.enterFirstRun({ welcome: true });
    remeasure(canvas);
    expect(canvas.useCanvas.getState().tiles.map((t) => t.elementId)).toEqual(["1"]);
    expect(ui.useUi.getState().coach).toBeNull();
  });

  it("waits for the workbench to measure itself before seeding", async () => {
    const { game, canvas, fr } = await load();
    canvas.useCanvas.setState({ bounds: null });
    game.useGame.setState({ powSolving: true });
    fr.enterFirstRun({ welcome: true });
    expect(canvas.useCanvas.getState().tiles).toHaveLength(0);
    canvas.useCanvas.setState({ bounds: B, obstacles: [] });
    expect(canvas.useCanvas.getState().tiles).toHaveLength(2);
  });

  it("waits for the measurement that includes the welcome card, and keeps the pair clear of it", async () => {
    const { game, canvas, fr } = await load();
    const short = { ...B, w: 360, h: 240 };
    canvas.useCanvas.setState({ bounds: short, size: { w: short.w, h: short.h } });
    game.useGame.setState({ powSolving: true });
    fr.enterFirstRun({ welcome: true });
    // The workbench had measured itself already, before the card went up: not yet.
    expect(canvas.useCanvas.getState().tiles).toHaveLength(0);
    const card = { x: 6, y: 4, w: 348, h: 66 };
    remeasure(canvas, [card]);
    const tiles = canvas.useCanvas.getState().tiles;
    expect(tiles).toHaveLength(2);
    for (const t of tiles) expect(t.y - 38).toBeGreaterThanOrEqual(card.y + card.h);
  });

  it("seeds anyway when the workbench doesn't measure again", async () => {
    const { game, canvas, fr } = await load();
    game.useGame.setState({ powSolving: true });
    fr.enterFirstRun({ welcome: true });
    expect(canvas.useCanvas.getState().tiles).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(300);
    expect(canvas.useCanvas.getState().tiles).toHaveLength(2);
  });

  it("the welcome card reports shown, expand, link and its close, and onboards on close", async () => {
    const { ui, fr } = await load();
    fr.enterFirstRun({ welcome: true });
    fr.welcomeShown();
    fr.welcomeShown();
    fr.toggleWelcome();
    expect(ui.useUi.getState().welcome).toBe("expanded");
    fr.welcomeLink("teachers");
    fr.toggleWelcome();
    expect(ui.useUi.getState().welcome).toBe("collapsed");
    fr.closeWelcome("dismiss");
    fr.closeWelcome("dismiss");
    expect(ui.useUi.getState().welcome).toBeNull();
    expect(local.getItem("ia:onboarded")).toBe("1");
    expect(events()).toEqual([
      ["onboarding", { action: "shown" }],
      ["onboarding", { action: "expand", secs: 0 }],
      ["onboarding", { action: "link", target: "teachers", secs: 0 }],
      ["onboarding", { action: "dismiss", secs: 0 }],
    ]);
  });
});
