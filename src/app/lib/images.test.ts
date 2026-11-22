import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ElementDTO, ImageResponse } from "../../shared/api.ts";

// The art queue keeps module state, so every test imports a fresh copy (and a fresh mock store).
const m = vi.hoisted(() => ({ requestImage: vi.fn() }));
vi.mock("./api.ts", async (orig) => ({ ...(await orig<typeof import("./api.ts")>()), requestImage: m.requestImage }));
vi.mock("../state/game.ts", async () => {
  const { create } = await import("zustand");
  const useGame = create<{ elements: Record<string, ElementDTO>; owned: Record<string, unknown>; challenge: unknown }>(() => ({
    elements: {},
    owned: {},
    challenge: null,
  }));
  const setElementArt = (id: string, art: ElementDTO["art"], img: string | null) =>
    useGame.setState((s) => ({ elements: { ...s.elements, [id]: { ...s.elements[id]!, art, img } } }));
  return { useGame, setElementArt };
});

type Queue = typeof import("./images.ts");
type Game = typeof import("../state/game.ts");
let q: Queue;
let game: Game;

const MIN = 60_000;
const el = (id: string): ElementDTO => ({
  id,
  name: `E${id}`,
  emoji: "✨",
  img: null,
  art: "missing",
  description: null,
  notable: false,
  depth: 1,
  rarity: "common",
  starter: false,
});

/** Owned elements without art. */
function own(...ids: string[]): void {
  game.useGame.setState((s) => ({
    elements: { ...s.elements, ...Object.fromEntries(ids.map((id) => [id, el(id)])) },
    owned: { ...s.owned, ...Object.fromEntries(ids.map((id) => [id, { discoveredAt: "", first: false }])) },
  }));
}

const asked = () => m.requestImage.mock.calls.map(([req]) => (req as { id: string }).id);
const tick = (ms = 0) => vi.advanceTimersByTimeAsync(ms);
/** Show a tile, then (optionally) hide it again. */
const view = (id: string) => q.setArtVisible(id, true);
const hide = (id: string) => q.setArtVisible(id, false);
const deferred = (over: Partial<Extract<ImageResponse, { state: "deferred" }>> = {}): ImageResponse => ({
  state: "deferred",
  retryAfterMs: MIN,
  limited: true,
  lane: "backlog",
  reason: "pace",
  ...over,
});

beforeEach(async () => {
  vi.useFakeTimers();
  vi.resetModules();
  m.requestImage.mockReset();
  game = await import("../state/game.ts");
  q = await import("./images.ts");
});

afterEach(() => {
  vi.useRealTimers();
});

describe("art queue", () => {
  it("leaves a deferred backlog element resting, with no timer re-request", async () => {
    own("1");
    m.requestImage.mockResolvedValue(deferred());
    view("1");
    await tick();
    expect(asked()).toEqual(["1"]);
    await tick(6 * 60 * MIN); // hours on screen: no polling
    expect(asked()).toEqual(["1"]);
    expect(game.useGame.getState().elements["1"]!.art).toBe("missing"); // the emoji stays
  });

  it("asks again the next time a tile shows it after the rest", async () => {
    own("1");
    m.requestImage.mockResolvedValue(deferred({ retryAfterMs: MIN }));
    view("1");
    await tick();
    hide("1");
    await tick(5 * MIN);
    view("1"); // too soon: rests at least 10 minutes
    await tick();
    expect(asked()).toEqual(["1"]);
    hide("1");
    await tick(6 * MIN);
    m.requestImage.mockResolvedValue({ state: "ready", img: "/img/1/a.webp" });
    view("1");
    await tick();
    expect(asked()).toEqual(["1", "1"]);
    expect(game.useGame.getState().elements["1"]).toMatchObject({ art: "ready", img: "/img/1/a.webp" });
  });

  it("puts fresh discoveries at the front of the queue", async () => {
    own("1", "2", "3", "9");
    const pending: ((r: ImageResponse) => void)[] = [];
    m.requestImage.mockImplementation(() => new Promise((resolve) => pending.push(resolve)));
    view("1");
    view("2"); // two in flight
    view("3"); // waits
    q.noteFresh("9");
    view("9"); // waits, but ahead of 3
    await tick();
    expect(asked()).toEqual(["1", "2"]);
    pending[0]!({ state: "ready", img: "/img/1/a.webp" });
    await tick();
    expect(asked()).toEqual(["1", "2", "9"]);
  });

  it("holds the backlog after a limited deferral while fresh art keeps going", async () => {
    own("1", "2", "9");
    m.requestImage.mockResolvedValueOnce(deferred({ retryAfterMs: 5 * MIN })).mockResolvedValue({ state: "ready", img: "/img/x.webp" });
    view("1");
    await tick();
    view("2"); // a library scroll during the hold: not sent yet
    q.noteFresh("9");
    view("9");
    await tick(MIN);
    expect(asked()).toEqual(["1", "9"]);
    await tick(4 * MIN);
    expect(asked()).toEqual(["1", "9", "2"]);
  });

  it("retries deferred fresh art on a timer while it is on screen, at most three deferrals", async () => {
    own("9");
    q.noteFresh("9");
    m.requestImage.mockResolvedValue(deferred({ lane: "fresh", retryAfterMs: 30_000 }));
    view("9");
    await tick();
    await tick(2 * MIN); // retried after max(30 s, 2 min)
    expect(asked()).toEqual(["9", "9"]);
    await tick(2 * MIN);
    expect(asked()).toEqual(["9", "9", "9"]);
    await tick(60 * MIN); // the third deferral put it to rest
    expect(asked()).toHaveLength(3);
  });

  it("exempts fresh art from the session cap, which counts only requests that could generate", async () => {
    const ids = Array.from({ length: 152 }, (_, i) => String(i + 1));
    own(...ids, "999");
    // A deferral and a poll don't count: 1 is deferred, 2 is pending then polled, 3..151 are ready.
    m.requestImage
      .mockResolvedValueOnce({ state: "deferred", retryAfterMs: 6 * 60 * MIN, lane: "backlog", reason: "gave_up" })
      .mockResolvedValueOnce({ state: "pending", retryAfterMs: 3_000 })
      .mockResolvedValue({ state: "ready", img: "/img/x.webp" });
    for (const id of ids.slice(0, 151)) {
      view(id);
      await tick(3_000);
    }
    expect(asked()).toHaveLength(152); // 151 elements, one of them polled once: 150 counted
    view("152");
    await tick();
    expect(asked()).toHaveLength(152); // capped
    q.noteFresh("999");
    view("999");
    await tick();
    expect(asked().at(-1)).toBe("999");
  });

  it("pauses the whole queue briefly on an HTTP 429", async () => {
    const { ApiFailure } = await import("./api.ts");
    own("1", "2");
    m.requestImage.mockRejectedValueOnce(new ApiFailure("rate_limited", "slow down", 429, undefined, undefined, "platform"));
    m.requestImage.mockResolvedValue({ state: "ready", img: "/img/x.webp" });
    view("1");
    await tick();
    view("2");
    await tick(9_000);
    expect(asked()).toEqual(["1"]);
    await tick(1_000);
    expect(asked()).toEqual(["1", "1", "2"]); // the limited element is retried too
  });

  it("waits for a share card's art even with no tile on screen", async () => {
    own("5");
    m.requestImage.mockImplementation(async () => {
      await new Promise((r) => setTimeout(r, 2_000));
      return { state: "ready", img: "/img/5/a.webp" };
    });
    const art = q.waitForArt("5", 3_000);
    await tick(2_000);
    await expect(art).resolves.toBe("/img/5/a.webp");
    m.requestImage.mockImplementation(() => new Promise(() => {}));
    own("6");
    const late = q.waitForArt("6", 3_000);
    await tick(3_000);
    await expect(late).resolves.toBeNull();
  });

  it("stops a share card's wait as soon as the art can't arrive in time", async () => {
    const { ApiFailure } = await import("./api.ts");
    /** The promise's value once it settles (undefined while it waits). */
    const watch = (p: Promise<string | null>) => {
      const out: { v?: string | null } = {};
      void p.then((v) => (out.v = v));
      return out;
    };
    own("1", "2", "3", "4");
    m.requestImage.mockResolvedValueOnce(deferred({ lane: "backlog", reason: "pace" })); // an old library element
    const deferredWait = watch(q.waitForArt("1", 10_000));
    m.requestImage.mockRejectedValueOnce(new ApiFailure("not_found", "gone", 404));
    const goneWait = watch(q.waitForArt("2", 10_000));
    await tick(); // the replies, not the 10 s timeout
    expect(deferredWait.v).toBeNull();
    expect(goneWait.v).toBeNull();
    // A 429 pauses the queue for at least 10 s: every waiter stops, including one still queued.
    let fail: (e: unknown) => void = () => {};
    m.requestImage.mockImplementationOnce(() => new Promise((_, reject) => (fail = reject)));
    const limitedWait = watch(q.waitForArt("3", 10_000));
    const queuedWait = watch(q.waitForArt("4", 10_000));
    await tick();
    expect(limitedWait.v).toBeUndefined(); // still waiting while the request is in flight
    fail(new ApiFailure("rate_limited", "slow down", 429, 1_000, undefined, "platform"));
    await tick();
    expect(limitedWait.v).toBeNull();
    expect(queuedWait.v).toBeNull();
  });

  it("keeps waiting while art is being generated", async () => {
    own("1");
    m.requestImage.mockResolvedValueOnce({ state: "pending", retryAfterMs: 1_500 }).mockResolvedValue({ state: "ready", img: "/img/1/a.webp" });
    const art = q.waitForArt("1", 3_000);
    await tick(1_500);
    await expect(art).resolves.toBe("/img/1/a.webp");
  });

  it("does not re-ask for a share card after a firm refusal, until its hint passes", async () => {
    own("1");
    m.requestImage.mockResolvedValue(deferred({ reason: "player", retryAfterMs: 15 * MIN }));
    view("1");
    await tick();
    expect(asked()).toEqual(["1"]);
    await expect(q.waitForArt("1", 3_000)).resolves.toBeNull();
    expect(asked()).toEqual(["1"]); // the server would only say no again
    await tick(15 * MIN);
    void q.waitForArt("1", 3_000);
    await tick();
    expect(asked()).toEqual(["1", "1"]);
  });

  it("treats a discovery made before a reload (owned.discoveredAt) as fresh", async () => {
    own("1", "2");
    game.useGame.setState((s) => ({ owned: { ...s.owned, "2": { discoveredAt: new Date(Date.now() - MIN).toISOString(), first: false } } }));
    m.requestImage.mockResolvedValueOnce(deferred({ retryAfterMs: 5 * MIN })).mockResolvedValue({ state: "ready", img: "/img/x.webp" });
    view("1"); // an old tile: deferred, so the backlog is held for 5 minutes
    await tick();
    view("2"); // discovered a minute ago, in an earlier page load: skips the hold
    await tick();
    expect(asked()).toEqual(["1", "2"]);
  });

  it("counts a retry after a failed generation against the session cap", async () => {
    const ids = Array.from({ length: 76 }, (_, i) => String(i + 1));
    own(...ids);
    const seen = new Set<string>();
    // Every generation fails once (pending + failed), then succeeds: two counted requests each.
    m.requestImage.mockImplementation(async ({ id }: { id: string }) => {
      if (seen.has(id)) return { state: "ready", img: `/img/${id}/a.webp` };
      seen.add(id);
      return { state: "pending", retryAfterMs: 5_000, failed: true };
    });
    for (const id of ids.slice(0, 75)) {
      view(id);
      await tick(6_000);
    }
    expect(asked()).toHaveLength(150);
    view("76");
    await tick(6_000);
    expect(asked()).toHaveLength(150); // capped
  });
});
