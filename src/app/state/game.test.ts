import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { BootstrapResponse } from "../../shared/api.ts";
import { localDay } from "../../shared/dates.ts";
import { ApiFailure, setTransport } from "../lib/api.ts";
import { bootBand, bootGame, classifyEntry, refreshIfNewDay, retryDelayMs, shouldRetryBoot, useGame } from "./game.ts";

const PLAYER = { id: "0b3e5a1c-7d2f-4c8e-9a6b-1f2e3d4c5a01", createdAt: "2026-11-30T00:00:00.000Z", legacy: false };

function bootResponse(over: Partial<BootstrapResponse> = {}): BootstrapResponse {
  return {
    player: PLAYER,
    library: [],
    stats: { known: 10, mine: 5, firsts: 0, challengesCompleted: 0, streak: { current: 0, best: 0 } },
    challenge: null,
    history: [],
    recent: [],
    ...over,
  };
}

const jsonResponse = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

afterAll(() => setTransport((path, init) => fetch(path, init)));

describe("boot retry decision", () => {
  const fail = (code: ConstructorParameters<typeof ApiFailure>[0], status = 0) => new ApiFailure(code, "x", status);

  it("retries transient failures once the browser is not offline", () => {
    for (const e of [fail("network"), fail("timeout"), fail("server_error", 500), fail("server_error", 503), fail("server_error", 200)]) {
      expect(shouldRetryBoot(e, true), e.code).toBe(true);
      expect(shouldRetryBoot(e, undefined), e.code).toBe(true);
      expect(shouldRetryBoot(e, false), e.code).toBe(false);
    }
  });

  it("never retries client errors, limits or proof-of-work", () => {
    for (const e of [
      fail("rate_limited", 429),
      fail("pow_required", 401),
      fail("unauthorized", 401),
      fail("forbidden", 403),
      fail("bad_request", 400),
      fail("not_found", 404),
      fail("budget_exhausted", 503),
      fail("server_error", 413),
    ]) {
      expect(shouldRetryBoot(e, true), `${e.code} ${e.status}`).toBe(false);
    }
    expect(shouldRetryBoot(new Error("render"), true)).toBe(false);
  });

  it("waits 1.5 to 3 seconds", () => {
    expect(retryDelayMs(0)).toBe(1_500);
    expect(retryDelayMs(0.5)).toBe(2_250);
    expect(retryDelayMs(1)).toBe(3_000);
  });

  it("buckets boot time in the server's boot_abandon bands", () => {
    expect([0, 1_999, 2_000, 3_999, 4_000, 7_999, 8_000, 14_999, 15_000, 29_999, 30_000, 90_000].map(bootBand)).toEqual([
      "<2s",
      "<2s",
      "2-4s",
      "2-4s",
      "4-8s",
      "4-8s",
      "8-15s",
      "8-15s",
      "15-30s",
      "15-30s",
      "30s+",
      "30s+",
    ]);
  });
});

describe("entry classification", () => {
  it("names search engines, direct loads and installed apps, never the URL", () => {
    expect(classifyEntry("https://www.google.com/", false)).toBe("search");
    expect(classifyEntry("https://www.google.co.uk/", false)).toBe("search");
    expect(classifyEntry("android-app://com.google.android.googlequicksearchbox/", false)).toBe("search");
    expect(classifyEntry("https://www.bing.com/search?q=x", false)).toBe("search");
    expect(classifyEntry("https://duckduckgo.com/", false)).toBe("search");
    expect(classifyEntry("https://search.yahoo.com/", false)).toBe("search");
    expect(classifyEntry("https://www.ecosia.org/", false)).toBe("search");
    expect(classifyEntry("", false)).toBe("direct");
    expect(classifyEntry("", true)).toBe("standalone");
    expect(classifyEntry("https://www.google.com/", true)).toBe("standalone");
  });

  it("calls Google's apps, other sites and the game itself other", () => {
    expect(classifyEntry("https://classroom.google.com/", false)).toBe("other");
    expect(classifyEntry("https://docs.google.com/document/d/1", false)).toBe("other");
    expect(classifyEntry("https://googleusercontent.com/", false)).toBe("other");
    expect(classifyEntry("https://alchemy.sshh.io/how-to-play", false)).toBe("other");
    expect(classifyEntry("https://notbing.com.evil.example/", false)).toBe("other");
    expect(classifyEntry("not a url", false)).toBe("other");
  });
});

describe("bootGame", () => {
  let calls: { path: string; body: Record<string, unknown> }[];

  beforeEach(() => {
    vi.useFakeTimers();
    calls = [];
    useGame.setState({ status: "booting", bootError: null, player: null });
  });
  afterEach(() => vi.useRealTimers());

  /** Answer bootstrap POSTs in order: an Error rejects like a dropped connection. */
  function serve(...answers: (Response | Error)[]) {
    setTransport(async (path, init) => {
      calls.push({ path, body: JSON.parse(String(init.body)) as Record<string, unknown> });
      const next = answers.shift();
      if (!next) throw new Error("unexpected request");
      if (next instanceof Error) throw next;
      return next;
    });
  }

  const settle = async (p: Promise<void>) => {
    await vi.advanceTimersByTimeAsync(5_000);
    await p;
  };

  it("does not retry a rate-limited boot", async () => {
    serve(jsonResponse({ error: "rate_limited", message: "Easy there.", retryAfterMs: 20_000 }, 429));
    await settle(bootGame());
    expect(calls).toHaveLength(1);
    expect(useGame.getState()).toMatchObject({ status: "error", bootError: "rate_limited" });
  });

  it("retries a network failure once, then shows the error", async () => {
    serve(new TypeError("Failed to fetch"), new TypeError("Failed to fetch"));
    const p = bootGame();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(calls).toHaveLength(1);
    expect(useGame.getState().status).toBe("booting"); // still the boot pill, not the error card
    await settle(p);
    expect(calls).toHaveLength(2);
    expect(useGame.getState()).toMatchObject({ status: "error", bootError: "network" });
  });

  it("recovers on the automatic retry and sends the client hints", async () => {
    serve(jsonResponse({ error: "server_error", message: "oops" }, 500), jsonResponse(bootResponse({ tomorrow: { img: null, letters: 6 } })));
    await settle(bootGame());
    expect(calls).toHaveLength(2);
    expect(useGame.getState()).toMatchObject({ status: "ready", player: PLAYER, tomorrow: { img: null, letters: 6 } });
    const hint = calls[1]!.body.hint as Record<string, unknown>;
    expect(hint).toMatchObject({ touch: false, standalone: false, wide: false, prior: false, entry: "direct" });
  });

  it("shares one run between overlapping calls", async () => {
    // The last test left a resolved bootstrap: a new run reuses it without a request.
    const a = bootGame();
    const b = bootGame();
    expect(a).toBe(b);
    await settle(a);
    expect(calls).toHaveLength(0);
  });
});

describe("resumed tab on a new day", () => {
  const yesterday = "2000-01-01";
  let calls: Record<string, unknown>[];
  const ready = () =>
    useGame.setState({ status: "ready", player: PLAYER, day: yesterday, challenge: null, owned: {}, elements: {}, tomorrow: null });

  beforeEach(() => {
    calls = [];
    ready();
  });

  const serve = (res: Response) =>
    setTransport(async (_path, init) => {
      calls.push(JSON.parse(String(init.body)) as Record<string, unknown>);
      return res;
    });

  it("loads the new day's challenge silently", async () => {
    const challenge = { day: localDay(), targets: [] };
    serve(jsonResponse(bootResponse({ challenge, tomorrow: { img: "/img/1/a.webp", letters: 4 } })));
    await refreshIfNewDay();
    // No PoW, no legacy, no hint; `refresh` so the server counts no load (not a return day).
    expect(calls).toEqual([{ clientDate: localDay(), refresh: true }]);
    expect(useGame.getState()).toMatchObject({ status: "ready", day: localDay(), challenge, tomorrow: { img: "/img/1/a.webp", letters: 4 } });
  });

  it("never solves a proof-of-work (so it can't create a player)", async () => {
    serve(jsonResponse({ error: "pow_required", message: "Solve it.", pow: { salt: "s", bits: 8 } }, 401));
    await refreshIfNewDay();
    expect(calls).toHaveLength(1);
    expect(useGame.getState()).toMatchObject({ status: "ready", day: yesterday });
  });

  it("ignores another player's answer and same-day visits", async () => {
    serve(jsonResponse(bootResponse({ player: { ...PLAYER, id: "someone-else" } })));
    await refreshIfNewDay();
    expect(useGame.getState().day).toBe(yesterday);
    useGame.setState({ day: localDay() });
    await refreshIfNewDay();
    expect(calls).toHaveLength(1);
  });
});

describe("abandon beacon", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("is taken back when a page hidden mid-boot comes back, and sent again on a real exit", async () => {
    vi.resetModules();
    const listeners = new Map<string, ((e: Event) => void)[]>();
    const on = (type: string, fn: (e: Event) => void) => listeners.set(type, [...(listeners.get(type) ?? []), fn]);
    const fire = (type: string, e: Event = new Event(type)) => listeners.get(type)?.forEach((fn) => fn(e));
    const doc = { visibilityState: "visible", referrer: "", addEventListener: on };
    const beacons: Record<string, unknown>[] = [];
    const gtag = vi.fn();
    vi.stubGlobal("document", doc);
    vi.stubGlobal("addEventListener", on);
    vi.stubGlobal("navigator", {
      onLine: true,
      maxTouchPoints: 0,
      sendBeacon: (_url: string, body: string) => beacons.push(JSON.parse(body) as Record<string, unknown>) > 0,
    });
    vi.stubGlobal("window", { gtag });
    const api = await import("../lib/api.ts");
    const fresh = await import("./game.ts");
    api.setTransport(() => new Promise<Response>(() => {})); // the boot never answers
    void fresh.bootGame();
    const plain = (b: Record<string, unknown>) => ({ phase: b.phase, resumed: b.resumed });

    doc.visibilityState = "hidden";
    fire("visibilitychange");
    fire("pagehide"); // hidden, then closed: still one abandon
    expect(beacons.map(plain)).toEqual([{ phase: "bootstrap1", resumed: undefined }]);

    doc.visibilityState = "visible";
    fire("visibilitychange");
    expect(beacons).toHaveLength(2);
    expect(beacons[1]).toEqual({ ...beacons[0], resumed: true }); // same phase and ms: nets out

    doc.visibilityState = "hidden";
    fire("visibilitychange");
    fire("pageshow", Object.assign(new Event("pageshow"), { persisted: true })); // restored from the back/forward cache
    expect(beacons.map(plain).slice(2)).toEqual([
      { phase: "bootstrap1", resumed: undefined },
      { phase: "bootstrap1", resumed: true },
    ]);
    // GA hears it once per page, with app_ready's boot_ms name.
    const ga = gtag.mock.calls.filter((c) => c[0] === "event" && c[1] === "boot_abandon").map((c) => c[2] as Record<string, unknown>);
    expect(ga).toEqual([{ phase: "bootstrap1", boot_ms: beacons[0]!.ms }]);
  });
});
