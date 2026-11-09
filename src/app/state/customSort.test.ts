// Engine tests for the custom library sort: request scheduling, batching, failures, caches,
// the combine piggyback and the session mirror. Each test loads fresh modules over memory
// Web Storage, a fake transport (requests are answered by hand or by `auto`) and fake timers.
import { afterEach, describe, expect, it, vi } from "vitest";
import { SORT_RUBRIC, type CombineResponse, type ElementDTO, type SortRequest, type SortResponse, type SortSpec } from "../../shared/api.ts";

type Mods = {
  api: typeof import("../lib/api.ts");
  game: typeof import("./game.ts");
  ui: typeof import("./ui.ts");
  cs: typeof import("./customSort.ts");
  ls: typeof import("../lib/librarySort.ts");
};

interface Call {
  path: string;
  body: SortRequest;
  signal: AbortSignal;
  reply(status: number, body: unknown): void;
  fail(): void;
}

let m: Mods;
let calls: Call[];
let auto: ((body: SortRequest) => { status: number; body: unknown } | null) | null;
let online: (() => void) | null;
let pagehide: (() => void) | null;
let gtag: ReturnType<typeof vi.fn>;

const SPOOKY: SortSpec = { kind: "rank", prompt: "spookiest" };
const CUTE: SortSpec = { kind: "rank", prompt: "cutest" };
const ZOO: SortSpec = { kind: "groups", groups: ["Animals", "Food"] };

function memoryStorage(init: Record<string, string> = {}): Storage {
  const s = new Map(Object.entries(init));
  return {
    get length() {
      return s.size;
    },
    clear: () => s.clear(),
    getItem: (k) => s.get(k) ?? null,
    key: (i) => [...s.keys()][i] ?? null,
    removeItem: (k) => void s.delete(k),
    setItem: (k, v) => void s.set(k, String(v)),
  };
}

/** Just what lib/api.ts reads from a Response (avoids real body streams under fake timers). */
const fakeResponse = (status: number, body: unknown) =>
  ({ ok: status >= 200 && status < 300, status, statusText: "", headers: new Headers(), json: async () => body }) as unknown as Response;

const scoreOf = (id: string) => (Number(id) * 37) % 1000;

/** What the server would answer right now: every requested owned id (or the whole library). */
function answer(body: SortRequest): SortResponse {
  const owned = m.game.useGame.getState().owned;
  const ids = body.ids ? body.ids.filter((id) => id in owned) : Object.keys(owned);
  const groups = body.spec.kind === "groups";
  return {
    engine: `fake/${SORT_RUBRIC}`,
    ids,
    s: ids.map(scoreOf),
    ...(groups ? { g: ids.map((id) => Number(id) % 2), n: ids.map(() => 900) } : {}),
    retry: [],
  };
}

async function load(init: { local?: Record<string, string>; session?: Record<string, string> } = {}): Promise<void> {
  vi.useFakeTimers();
  vi.resetModules();
  calls = [];
  auto = (body) => ({ status: 200, body: answer(body) });
  online = null;
  pagehide = null;
  gtag = vi.fn();
  vi.stubGlobal("window", {
    localStorage: memoryStorage(init.local),
    sessionStorage: memoryStorage(init.session),
    addEventListener: (type: string, fn: () => void) => {
      if (type === "online") online = fn;
      if (type === "pagehide") pagehide = fn;
    },
    gtag,
  });
  const api = await import("../lib/api.ts");
  m = { api, game: await import("./game.ts"), ui: await import("./ui.ts"), cs: await import("./customSort.ts"), ls: await import("../lib/librarySort.ts") };
  api.setTransport(
    (path, req) =>
      new Promise<Response>((resolve, reject) => {
        const signal = req.signal!;
        const call: Call = {
          path,
          body: JSON.parse(String(req.body)) as SortRequest,
          signal,
          reply: (status, body) => resolve(fakeResponse(status, body)),
          fail: () => reject(new TypeError("Failed to fetch")),
        };
        signal.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")), { once: true });
        calls.push(call);
        const r = auto?.(call.body);
        if (r) call.reply(r.status, r.body);
      }),
  );
}

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

function el(id: string): ElementDTO {
  return { id, name: `El${id}`, emoji: null, img: null, art: "missing", description: null, notable: false, depth: 2, rarity: "common", starter: false };
}

function boot(ids: string[], player = "p1"): void {
  const now = Date.now();
  m.game.useGame.setState({
    status: "ready",
    player: { id: player, createdAt: "", legacy: false },
    elements: Object.fromEntries(ids.map((id) => [id, el(id)])),
    owned: Object.fromEntries(ids.map((id, i) => [id, { discoveredAt: new Date(now - (i + 1) * 60_000).toISOString(), first: false }])),
  });
}

function combineRes(id: string, sortScore?: CombineResponse["sortScore"]): CombineResponse {
  const e = el(id);
  return {
    result: e,
    newForPlayer: true,
    firstEver: false,
    recipeNew: true,
    completed: [],
    entry: { ...e, discoveredAt: new Date().toISOString(), first: false },
    ...(sortScore ? { sortScore } : {}),
  };
}

const discover = (id: string) => m.game.applyCombine(combineRes(id));

/** Let timers run and promise chains settle. */
async function tick(ms = 0): Promise<void> {
  await vi.advanceTimersByTimeAsync(ms);
}

const sortCalls = () => calls.filter((c) => c.path === "/api/sort");
const st = () => m.cs.useCustomSort.getState();
const ids4 = ["1", "2", "3", "4"];

/** Custom sort applied and committed for a 4-element library. */
async function ready(spec: SortSpec = SPOOKY): Promise<void> {
  await load();
  boot(ids4);
  m.cs.applyCustomSort(spec);
  await tick();
  expect(st().status).toBe("ready");
}

describe("full runs", () => {
  it("apply → one full request, commit, epoch + 1", async () => {
    await load();
    boot(ids4);
    m.cs.applyCustomSort({ kind: "rank", prompt: "  Spookiest " }, { source: "example" });
    expect(m.ui.useUi.getState().sort).toBe("custom");
    expect(st().status).toBe("scoring");
    expect(m.ui.useUi.getState().live.polite).toBe("Weighing 4 elements for “Spookiest”.");
    await tick();
    expect(sortCalls().map((c) => c.body)).toEqual([{ spec: { kind: "rank", prompt: "Spookiest" } }]);
    const s = st();
    expect(s.status).toBe("ready");
    expect(s.epoch).toBe(1);
    expect(s.committed?.key).toBe("r:spookiest");
    expect([...s.committed!.scores.keys()].sort()).toEqual(ids4);
    expect(m.ui.useUi.getState().live.polite).toMatch(/^Sorted by “Spookiest”\. First: El\d, El\d, El\d\.$/);
    await tick(120_000);
    expect(sortCalls()).toHaveLength(1);
  });

  it("persists the spec and remembers the previous sort", async () => {
    await load();
    boot(ids4);
    m.ui.setLibraryView({ sort: "rarity" });
    m.cs.applyCustomSort(SPOOKY);
    const stored = JSON.parse(window.localStorage.getItem("ia:customSort")!);
    expect(stored).toMatchObject({ v: 1, spec: SPOOKY, prevSort: "rarity", recent: [{ spec: SPOOKY }] });
    m.cs.clearCustomSort();
    expect(m.ui.useUi.getState().sort).toBe("rarity");
    expect(m.ui.useUi.getState().live.polite).toBe("Back to Rarity.");
  });

  it("sends the analytics event once per apply, without the prompt", async () => {
    await ready();
    const events = gtag.mock.calls.filter((c) => c[1] === "custom_sort");
    expect(events).toEqual([["event", "custom_sort", { kind: "rank", groups: 0, from: "typed", size: "lt100", cached: false, outcome: "ok" }]]);
    m.cs.applyCustomSort(CUTE, { source: "recent" });
    await tick();
    m.cs.activateCustom();
    m.cs.applyCustomSort(SPOOKY, { source: "recent" });
    await tick();
    const all = gtag.mock.calls.filter((c) => c[1] === "custom_sort").map((c) => c[2]);
    expect(all.map((p) => [p.from, p.cached])).toEqual([
      ["typed", false],
      ["recent", false],
      ["select", true],
      ["recent", true],
    ]);
    expect(JSON.stringify(gtag.mock.calls)).not.toMatch(/spook|cutest/i);
  });

  it("spec change mid-run → the old result is cached, not committed; switching back makes 0 requests", async () => {
    await load();
    auto = null;
    boot(ids4);
    m.cs.applyCustomSort(SPOOKY);
    m.cs.applyCustomSort(CUTE);
    expect(sortCalls()).toHaveLength(2);
    expect(sortCalls()[0]!.signal.aborted).toBe(false); // full runs survive a spec change
    sortCalls()[0]!.reply(200, answer(sortCalls()[0]!.body));
    await tick();
    expect(st().committed).toBeNull();
    expect(st().status).toBe("scoring");
    expect(m.cs.isCached(SPOOKY)).toBe(true);
    sortCalls()[1]!.reply(200, answer(sortCalls()[1]!.body));
    await tick();
    expect(st().committed?.key).toBe("r:cutest");
    const epoch = st().epoch;
    m.cs.applyCustomSort({ kind: "rank", prompt: "SPOOKIEST" });
    expect(st().committed?.key).toBe("r:spookiest");
    expect(st().status).toBe("ready");
    expect(st().epoch).toBe(epoch + 1);
    await tick(60_000);
    expect(sortCalls()).toHaveLength(2);
  });

  it("a third concurrent full run aborts the oldest inactive one", async () => {
    await load();
    auto = null;
    boot(ids4);
    m.cs.applyCustomSort(SPOOKY);
    m.cs.applyCustomSort(CUTE);
    m.cs.applyCustomSort(ZOO);
    expect(sortCalls().map((c) => c.signal.aborted)).toEqual([true, false, false]);
    await tick();
    expect(st().failure).toBeNull();
  });

  it("a transient failure retries once after 5 s, then shows the error and waits for Retry", async () => {
    await load();
    auto = () => ({ status: 503, body: { error: "ai_unavailable", message: "busy" } });
    boot(ids4);
    m.cs.applyCustomSort(SPOOKY);
    await tick();
    expect(st().status).toBe("scoring");
    expect(st().failure).toBeNull();
    await tick(4_999);
    expect(sortCalls()).toHaveLength(1);
    await tick(1);
    expect(sortCalls()).toHaveLength(2);
    expect(st().status).toBe("error");
    expect(st().failure).toMatchObject({ code: "ai_unavailable", scope: "full" });
    expect(m.ui.useUi.getState().live.assertive).toBe("The lab's scales are busy. Your order is safe.");
    await tick(120_000);
    expect(sortCalls()).toHaveLength(2);
    auto = (body) => ({ status: 200, body: answer(body) });
    m.cs.retryCustomSort();
    await tick();
    expect(sortCalls()).toHaveLength(3);
    expect(st().status).toBe("ready");
    expect(st().failure).toBeNull();
  });

  it("429 → nothing before `until`, one request after", async () => {
    await load();
    auto = () => ({ status: 429, body: { error: "rate_limited", message: "slow down", retryAfterMs: 8_000 } });
    boot(ids4);
    m.cs.applyCustomSort(SPOOKY);
    await tick();
    expect(st().failure).toMatchObject({ code: "rate_limited", scope: "full" });
    expect(st().status).toBe("error");
    expect(m.cs.customSortFailureText(st().failure!)).toBe("Easy there, alchemist. Weighing resumes in 0:08.");
    auto = (body) => ({ status: 200, body: answer(body) });
    discover("5"); // a reconcile while waiting sends nothing either
    await tick(7_998);
    expect(sortCalls()).toHaveLength(1);
    await tick(2);
    expect(sortCalls()).toHaveLength(2);
    expect(st().status).toBe("ready");
    expect(st().failure).toBeNull();
  });

  it("budget_exhausted → nothing is sent and the combine piggyback stops", async () => {
    await load();
    auto = () => ({ status: 503, body: { error: "budget_exhausted", message: "resting", retryAfterMs: 3_600_000 } });
    boot(ids4);
    m.cs.applyCustomSort(SPOOKY);
    await tick();
    expect(m.cs.budgetBlocked()).toBe(true);
    expect(m.cs.customSortForCombine()).toBeNull();
    discover("5");
    m.cs.applyCustomSort(CUTE);
    await tick(600_000);
    expect(sortCalls()).toHaveLength(1);
    expect(st().pending.size).toBe(0);
    const events = gtag.mock.calls.filter((c) => c[1] === "custom_sort").map((c) => c[2].outcome);
    expect(events).toEqual(["budget_exhausted", "budget_exhausted"]);
  });

  it("a network failure waits for the browser to come back online", async () => {
    await load();
    auto = null;
    boot(ids4);
    m.cs.applyCustomSort(SPOOKY);
    sortCalls()[0]!.fail();
    await tick(60_000);
    expect(st().failure).toMatchObject({ code: "network" });
    expect(sortCalls()).toHaveLength(1);
    auto = (body) => ({ status: 200, body: answer(body) });
    online!();
    await tick();
    expect(sortCalls()).toHaveLength(2);
    expect(st().status).toBe("ready");
  });

  it("flags a run that takes more than 6 s", async () => {
    await load();
    auto = null;
    boot(ids4);
    m.cs.applyCustomSort(SPOOKY);
    await tick(5_999);
    expect(st().slow).toBe(false);
    await tick(1);
    expect(st().slow).toBe(true);
    sortCalls()[0]!.reply(200, { ...answer(sortCalls()[0]!.body), truncated: true });
    await tick();
    expect(st().slow).toBe(false);
    expect(st().truncated).toBe(true);
  });
});

describe("incremental scoring", () => {
  it("a discovery during a full run waits for the commit, then goes out as one {ids} request after 2.5 s", async () => {
    await load();
    auto = null;
    boot(ids4);
    m.cs.applyCustomSort(SPOOKY);
    discover("5");
    await tick(10_000);
    expect(sortCalls()).toHaveLength(1);
    // The server's library query predates the discovery.
    sortCalls()[0]!.reply(200, { engine: `fake/${SORT_RUBRIC}`, ids: ids4, s: ids4.map(scoreOf), retry: [] });
    await tick();
    expect(st().committed?.scores.size).toBe(4);
    expect([...st().pending]).toEqual(["5"]);
    auto = (body) => ({ status: 200, body: answer(body) });
    await tick(2_499);
    expect(sortCalls()).toHaveLength(1);
    await tick(1);
    expect(sortCalls()[1]!.body).toEqual({ spec: SPOOKY, ids: ["5"] });
    expect(st().committed?.scores.get("5")).toBe(scoreOf("5"));
    expect(st().pending.size).toBe(0);
    expect(st().epoch).toBe(1); // incremental commits never replay the stagger
    await tick(1_500);
    expect(m.ui.useUi.getState().live.polite).toMatch(/^El5 ranks #\d of 5 for “spookiest”\.$/);
  });

  it("two discoveries 1 s apart → one request", async () => {
    await ready();
    discover("5");
    await tick(1_000);
    discover("6");
    await tick(2_499);
    expect(sortCalls()).toHaveLength(1);
    await tick(1);
    expect(sortCalls().map((c) => c.body.ids)).toEqual([undefined, ["5", "6"]]);
  });

  it("flushes at most 8 s after the first queued id", async () => {
    await ready();
    for (let i = 0; i < 6; i++) {
      discover(String(10 + i));
      await tick(2_000);
    }
    // Discoveries at 0, 2, 4 and 6 s keep pushing the debounce; the 8 s cap sends at 8 s.
    expect(sortCalls()[1]?.body.ids).toEqual(["10", "11", "12", "13"]);
    await tick(500);
    expect(sortCalls()[2]?.body.ids).toEqual(["14", "15"]);
  });

  it("flushes at once at 100 queued ids; more than half the library new → a full run instead", async () => {
    await load();
    const big = Array.from({ length: 300 }, (_, i) => String(1_000 + i));
    boot(big);
    m.cs.applyCustomSort(SPOOKY);
    await tick();
    const add = (from: number, n: number) => {
      const g = m.game.useGame.getState();
      const owned = { ...g.owned };
      const elements = { ...g.elements };
      for (let i = 0; i < n; i++) {
        const id = String(from + i);
        owned[id] = { discoveredAt: new Date().toISOString(), first: false };
        elements[id] = el(id);
      }
      m.game.useGame.setState({ elements, owned });
    };
    add(5_000, 100);
    await tick();
    expect(sortCalls()).toHaveLength(2);
    expect(sortCalls()[1]!.body.ids).toHaveLength(100);
    add(6_000, 500); // 500 of 900 missing
    await tick();
    expect(sortCalls()).toHaveLength(3);
    expect(sortCalls()[2]!.body).toEqual({ spec: SPOOKY });
  });

  it("at most one incremental request in flight", async () => {
    await ready();
    auto = null;
    discover("5");
    await tick(2_500);
    expect(sortCalls()).toHaveLength(2);
    discover("6");
    await tick(30_000 - 1);
    expect(sortCalls()).toHaveLength(2);
    sortCalls()[1]!.reply(200, answer(sortCalls()[1]!.body));
    await tick(2_500);
    expect(sortCalls()).toHaveLength(3);
    expect(sortCalls()[2]!.body.ids).toEqual(["6"]);
  });

  it("ingestSortScore → the discovery is scored without any /api/sort", async () => {
    await ready();
    const sent = m.cs.customSortForCombine();
    expect(sent).toEqual({ spec: SPOOKY, key: "r:spookiest" });
    const res = combineRes("5", { s: 990 });
    m.cs.ingestSortScore(sent!.key, res);
    m.game.applyCombine(res);
    await tick(60_000);
    expect(sortCalls()).toHaveLength(1);
    expect(st().committed?.scores.get("5")).toBe(990);
    expect(st().pending.size).toBe(0);
    expect(m.ui.useUi.getState().live.polite).toBe("El5 ranks #1 of 5 for “spookiest”.");
  });

  it("a piggyback for a spec that is still weighing waits for that run's commit", async () => {
    await ready();
    auto = null;
    m.cs.applyCustomSort(CUTE);
    const sent = m.cs.customSortForCombine()!;
    const res = combineRes("5", { s: 990 });
    m.cs.ingestSortScore(sent.key, res);
    expect(st().committed?.key).toBe("r:spookiest"); // the old order stays on screen
    m.game.applyCombine(res);
    sortCalls()[1]!.reply(200, { engine: `fake/${SORT_RUBRIC}`, ids: ids4, s: ids4.map(scoreOf), retry: [] });
    await tick(60_000);
    expect(st().committed?.key).toBe("r:cutest");
    expect(st().committed?.scores.get("5")).toBe(990);
    expect(sortCalls()).toHaveLength(2);
  });

  it("unscorable ids are never requested again", async () => {
    await load();
    auto = (body) => {
      const r = answer(body);
      const keep = r.ids.map((id, i) => [id, r.s[i]] as const).filter(([id]) => id !== "4");
      return { status: 200, body: { ...r, ids: keep.map((k) => k[0]), s: keep.map((k) => k[1]) } };
    };
    boot(ids4);
    m.cs.applyCustomSort(SPOOKY);
    await tick();
    discover("5");
    await tick(3_000);
    expect(sortCalls().map((c) => c.body.ids)).toEqual([undefined, ["5"]]);
    discover("6");
    await tick(3_000);
    expect(sortCalls().map((c) => c.body.ids)).toEqual([undefined, ["5"], ["6"]]);
  });

  it("retry ids come back after 4 s and 20 s, then count as unweighed until Retry", async () => {
    await load();
    auto = (body) => {
      const r = answer(body);
      const i = r.ids.indexOf("4");
      if (i >= 0) {
        r.ids.splice(i, 1);
        r.s.splice(i, 1);
        r.retry.push("4");
      }
      return { status: 200, body: r };
    };
    boot(ids4);
    m.cs.applyCustomSort(SPOOKY);
    await tick();
    expect([...st().pending]).toEqual(["4"]);
    await tick(4_000 + 2_499);
    expect(sortCalls()).toHaveLength(1);
    await tick(1);
    expect(sortCalls()[1]!.body.ids).toEqual(["4"]);
    await tick(20_000 + 2_500);
    expect(sortCalls()).toHaveLength(3);
    expect(st().unweighed).toBe(1);
    expect(st().pending.size).toBe(0);
    await tick(120_000);
    expect(sortCalls()).toHaveLength(3);
    auto = (body) => ({ status: 200, body: answer(body) });
    m.cs.retryCustomSort();
    await tick();
    expect(sortCalls()).toHaveLength(4);
    expect(st().unweighed).toBe(0);
    expect(st().committed?.scores.has("4")).toBe(true);
  });

  it("an incremental failure backs off instead of failing the sort", async () => {
    await ready();
    auto = () => ({ status: 503, body: { error: "server_error", message: "x" } });
    discover("5");
    await tick(2_500);
    expect(sortCalls()).toHaveLength(2);
    expect(st().failure).toBeNull();
    expect(st().status).toBe("ready");
    expect([...st().pending]).toEqual(["5"]);
    auto = (body) => ({ status: 200, body: answer(body) });
    await tick(4_000 + 2_500);
    expect(sortCalls()).toHaveLength(3);
    expect(st().committed?.scores.has("5")).toBe(true);
  });

  it("an incremental request aborted by a spec change is not a failure", async () => {
    await ready();
    auto = null;
    discover("5");
    await tick(2_500);
    const incr = sortCalls()[1]!;
    m.cs.applyCustomSort(CUTE);
    expect(incr.signal.aborted).toBe(true);
    await tick();
    expect(st().failure).toBeNull();
    expect(sortCalls()).toHaveLength(3); // CUTE's full run
    expect(sortCalls()[2]!.body).toEqual({ spec: CUTE });
  });
});

describe("display options and leaving custom", () => {
  it("leaving custom drops the queue and leaves no timers behind", async () => {
    await ready();
    discover("5");
    expect([...st().pending]).toEqual(["5"]);
    m.cs.clearCustomSort();
    expect(m.ui.useUi.getState().sort).toBe("recent");
    expect(st().pending.size).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
    discover("6");
    await tick(60_000);
    expect(sortCalls()).toHaveLength(1);
    expect(m.cs.customSortForCombine()).toBeNull();
  });

  it("nothing is scheduled while another sort is active", async () => {
    await load();
    boot(ids4);
    discover("5");
    await tick(60_000);
    expect(calls).toHaveLength(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("reverse and Other are display-only: 0 requests, epoch + 1", async () => {
    await ready();
    const e0 = st().epoch;
    m.cs.setBucket("matches");
    m.cs.toggleReverse();
    expect(st().view.reverse).toBe(true);
    expect(st().bucket).toBeNull();
    expect(st().epoch).toBe(e0 + 1);
    expect(m.ui.useUi.getState().live.polite).toMatch(/^Reversed\. El\d comes first\.$/);
    m.cs.applyCustomSort(ZOO, { other: true });
    await tick();
    expect(sortCalls()).toHaveLength(2);
    const e1 = st().epoch;
    m.cs.setBucket(-1);
    m.cs.setOtherView(false);
    expect(st().epoch).toBe(e1 + 1);
    expect(st().bucket).toBeNull();
    expect(st().recent[0]).toEqual({ spec: ZOO, other: false });
    m.cs.toggleReverse(); // groups: no-op
    expect(st().view.reverse).toBe(false);
    await tick(60_000);
    expect(sortCalls()).toHaveLength(2);
  });

  it("leaving custom with a full run in flight keeps the run and caches its result", async () => {
    await load();
    auto = null;
    boot(ids4);
    m.cs.applyCustomSort(SPOOKY);
    m.ui.setLibraryView({ sort: "az" });
    expect(sortCalls()[0]!.signal.aborted).toBe(false);
    sortCalls()[0]!.reply(200, answer(sortCalls()[0]!.body));
    await tick();
    expect(st().epoch).toBe(0); // no stagger/scroll on the built-in list
    m.cs.activateCustom();
    expect(st().status).toBe("ready");
    expect(st().epoch).toBe(1);
    expect(sortCalls()).toHaveLength(1);
  });
});

describe("reload, players and resets", () => {
  const stored = (spec: SortSpec, sort: "custom" | "recent" = "custom") => ({
    "ia:customSort": JSON.stringify({ v: 1, spec, view: { reverse: false, other: true }, recent: [], prevSort: "recent", seen: true }),
    "ia:libraryView": JSON.stringify({ filter: "all", sort }),
  });
  const mirror = (p: string, k = "r:spookiest", r = SORT_RUBRIC) => ({
    "ia:customSortScores": JSON.stringify({ v: 1, r, p, k, ids: ids4, s: ids4.map(scoreOf) }),
  });

  it("restores custom on boot and commits the session mirror for the same player with 0 requests", async () => {
    await load({ local: stored(SPOOKY), session: mirror("p1") });
    expect(m.ui.useUi.getState().sort).toBe("custom");
    boot(ids4, "p1");
    expect(st().status).toBe("ready");
    expect(st().committed?.scores.size).toBe(4);
    expect(st().epoch).toBe(0);
    await tick(60_000);
    expect(sortCalls()).toHaveLength(0);
  });

  it("queues only ids missing from the mirror", async () => {
    await load({ local: stored(SPOOKY), session: mirror("p1") });
    boot([...ids4, "5"], "p1");
    await tick(2_500);
    expect(sortCalls().map((c) => c.body.ids)).toEqual([["5"]]);
  });

  it("ignores a mirror from another player, spec or rubric", async () => {
    for (const session of [mirror("p2"), mirror("p1", "r:cutest"), mirror("p1", "r:spookiest", "r0")]) {
      await load({ local: stored(SPOOKY), session });
      boot(ids4, "p1");
      expect(st().committed).toBeNull();
      await tick();
      expect(sortCalls()).toHaveLength(1);
      expect(sortCalls()[0]!.body).toEqual({ spec: SPOOKY });
    }
  });

  it("an invalid stored spec boots into Recent", async () => {
    await load({ local: stored({ kind: "rank", prompt: "   " }) });
    expect(m.ui.useUi.getState().sort).toBe("recent");
    expect(st().spec).toBeNull();
  });

  it("writes the mirror a second after a commit", async () => {
    await ready();
    expect(window.sessionStorage.getItem("ia:customSortScores")).toBeNull();
    await tick(1_000);
    expect(JSON.parse(window.sessionStorage.getItem("ia:customSortScores")!)).toMatchObject({ v: 1, p: "p1", k: "r:spookiest", ids: ids4 });
  });

  it("a reload inside the mirror debounce still writes it (pagehide)", async () => {
    await ready();
    expect(window.sessionStorage.getItem("ia:customSortScores")).toBeNull();
    pagehide!();
    expect(JSON.parse(window.sessionStorage.getItem("ia:customSortScores")!)).toMatchObject({ v: 1, p: "p1", k: "r:spookiest", ids: ids4 });
    expect(vi.getTimerCount()).toBe(0);
  });

  it("a library reset forgets every score and drops responses still in flight", async () => {
    await ready();
    await tick(1_000);
    auto = null;
    discover("5");
    await tick(2_500);
    const incr = sortCalls()[1]!;
    // resetLibraryLocal: only (here) two elements survive.
    const owned = m.game.useGame.getState().owned;
    m.game.useGame.setState({ owned: { "1": owned["1"]!, "2": owned["2"]! } });
    expect(incr.signal.aborted).toBe(true);
    expect(window.sessionStorage.getItem("ia:customSortScores")).toBeNull();
    expect(m.cs.isCached(SPOOKY)).toBe(false);
    expect(st().committed).toBeNull();
    expect(st().status).toBe("scoring");
    incr.reply(200, answer({ spec: SPOOKY, ids: ["5"] }));
    const rerun = sortCalls()[2]!;
    expect(rerun.body).toEqual({ spec: SPOOKY });
    rerun.reply(200, answer(rerun.body));
    await tick();
    expect([...st().committed!.scores.keys()].sort()).toEqual(["1", "2"]);
  });

  it("another player's scores are never shown", async () => {
    await ready();
    await tick(1_000);
    auto = null;
    m.game.useGame.setState({ player: { id: "p2", createdAt: "", legacy: false } });
    expect(st().committed).toBeNull();
    expect(m.cs.isCached(SPOOKY)).toBe(false);
    expect(window.sessionStorage.getItem("ia:customSortScores")).toBeNull();
    expect(sortCalls()).toHaveLength(2);
    expect(sortCalls()[1]!.body).toEqual({ spec: SPOOKY });
  });

  it("a reload of a truncated library re-weighs nothing: the mirror keeps what the server ruled out", async () => {
    const lib = Array.from({ length: 10 }, (_, i) => String(i + 1));
    const cut = new Set(["5", "6", "7", "8", "9", "10"]); // the oldest six, past SORT_MAX_ELEMENTS
    await load();
    auto = (body) => {
      const r = answer(body);
      if (body.ids) return { status: 200, body: r };
      const keep = r.ids.map((id, i) => [id, r.s[i]!] as const).filter(([id]) => !cut.has(id));
      return { status: 200, body: { ...r, ids: keep.map((k) => k[0]), s: keep.map((k) => k[1]), truncated: true } };
    };
    boot(lib);
    m.cs.applyCustomSort(SPOOKY);
    await tick(1_000);
    expect(st().truncated).toBe(true);
    expect(sortCalls()).toHaveLength(1);
    const local = { "ia:customSort": window.localStorage.getItem("ia:customSort")!, "ia:libraryView": window.localStorage.getItem("ia:libraryView")! };
    const session = { "ia:customSortScores": window.sessionStorage.getItem("ia:customSortScores")! };
    expect(JSON.parse(session["ia:customSortScores"])).toMatchObject({ ids: ["1", "2", "3", "4"], u: [...cut], t: true });
    // The reload, same tab.
    await load({ local, session });
    boot(lib);
    expect(st().status).toBe("ready");
    expect(st().truncated).toBe(true);
    await tick(60_000);
    expect(sortCalls()).toHaveLength(0);
    discover("11"); // a new discovery is still weighed (incrementally)
    await tick(2_500);
    expect(sortCalls().map((c) => c.body.ids)).toEqual([["11"]]);
  });

  it("activating a spec found only in the mirror is a cached apply: epoch + 1, announcement, analytics, 0 requests", async () => {
    // Custom was used, then the player went back to Recent and reloaded.
    await load({ local: stored(SPOOKY, "recent"), session: mirror("p1") });
    boot(ids4, "p1");
    expect(m.ui.useUi.getState().sort).toBe("recent");
    expect(st().committed).toBeNull();
    m.cs.activateCustom();
    expect(st().status).toBe("ready");
    expect(st().epoch).toBe(1);
    expect(st().committed?.scores.size).toBe(4);
    expect(m.ui.useUi.getState().live.polite).toMatch(/^Sorted by “spookiest”\. First: El\d, El\d, El\d\.$/);
    const events = gtag.mock.calls.filter((c) => c[1] === "custom_sort").map((c) => c[2]);
    expect(events).toEqual([{ kind: "rank", groups: 0, from: "select", size: "lt100", cached: true, outcome: "ok" }]);
    await tick(60_000);
    expect(sortCalls()).toHaveLength(0);
  });

  it("isCached sees this tab's mirror, so budget gating matches what applying would do", async () => {
    await load({ local: stored(SPOOKY, "recent"), session: mirror("p1") });
    boot(ids4, "p1");
    expect(m.cs.isCached(SPOOKY)).toBe(true);
    expect(m.cs.isCached(CUTE)).toBe(false);
  });
});

describe("stale responses", () => {
  // Each reply below is already resolved when the reset/switch happens (its continuation is
  // still queued), so only the generation and key checks can keep it out.
  it("a full run resolved just before a player switch is dropped", async () => {
    await load();
    auto = null;
    boot(ids4, "p1");
    m.cs.applyCustomSort(SPOOKY);
    sortCalls()[0]!.reply(200, { engine: "stale", ids: ids4, s: [999, 998, 997, 996], retry: [] });
    m.game.useGame.setState({ player: { id: "p2", createdAt: "", legacy: false } });
    await tick();
    expect(st().committed).toBeNull();
    expect(st().status).toBe("scoring");
    const rerun = sortCalls()[1]!;
    expect(rerun.body).toEqual({ spec: SPOOKY });
    rerun.reply(200, answer(rerun.body));
    await tick();
    expect([...st().committed!.scores.values()]).toEqual(ids4.map(scoreOf));
  });

  it("an incremental reply resolved just before a library reset is dropped", async () => {
    await ready();
    auto = null;
    discover("5");
    await tick(2_500);
    const incr = sortCalls()[1]!;
    expect(incr.body.ids).toEqual(["5"]);
    // Distinctive scores for ids that survive the reset.
    incr.reply(200, { engine: "stale", ids: ["1", "2"], s: [999, 998], retry: [] });
    const owned = m.game.useGame.getState().owned;
    m.game.useGame.setState({ owned: { "1": owned["1"]!, "2": owned["2"]! } });
    await tick();
    const rerun = sortCalls()[2]!;
    expect(rerun.body).toEqual({ spec: SPOOKY });
    // The rerun can't score "2" this time: a stale 998 would survive in the entry.
    rerun.reply(200, { engine: "x", ids: ["1"], s: [scoreOf("1")], retry: ["2"] });
    await tick();
    expect([...st().committed!.scores]).toEqual([["1", scoreOf("1")]]);
    await tick(1_000);
    expect(window.sessionStorage.getItem("ia:customSortScores")).not.toMatch(/99[89]/);
  });

  it("an incremental reply for the previous spec only lands in that spec's entry", async () => {
    await ready();
    auto = null;
    discover("5");
    await tick(2_500);
    sortCalls()[1]!.reply(200, { engine: "old", ids: ["5"], s: [999], retry: [] });
    m.cs.applyCustomSort(CUTE);
    await tick();
    const cute = sortCalls()[2]!;
    expect(cute.body).toEqual({ spec: CUTE });
    cute.reply(200, { engine: "x", ids: ids4, s: ids4.map(scoreOf), retry: ["5"] });
    await tick();
    expect(st().committed?.key).toBe("r:cutest");
    expect(st().committed?.scores.has("5")).toBe(false);
    m.cs.applyCustomSort(SPOOKY);
    expect(st().committed?.key).toBe("r:spookiest");
    expect(st().committed?.scores.get("5")).toBe(999);
  });
});

describe("cached means a whole order", () => {
  it("a piggybacked score alone doesn't make a still-weighing spec cached", async () => {
    await load();
    auto = null;
    boot(ids4);
    m.cs.applyCustomSort(SPOOKY);
    const sent = m.cs.customSortForCombine()!;
    const res = combineRes("5", { s: 990 });
    m.cs.ingestSortScore(sent.key, res);
    m.game.applyCombine(res);
    expect(m.cs.isCached(SPOOKY)).toBe(false);
    m.cs.clearCustomSort();
    m.cs.activateCustom();
    expect(st().status).toBe("scoring");
    expect(st().committed).toBeNull();
    expect(st().epoch).toBe(0);
    sortCalls()[0]!.reply(200, { engine: "x", ids: ids4, s: ids4.map(scoreOf), retry: [] });
    await tick();
    expect(st().status).toBe("ready");
    expect(st().epoch).toBe(1); // the run's commit is the fresh one: stagger, scroll to top
    expect(st().committed?.scores.size).toBe(5);
    expect(m.ui.useUi.getState().live.polite).toMatch(/^Sorted by “spookiest”\. First: El5, /);
    const events = gtag.mock.calls.filter((c) => c[1] === "custom_sort").map((c) => [c[2].from, c[2].cached, c[2].outcome]);
    expect(events).toEqual([["select", false, "ok"]]);
    expect(sortCalls()).toHaveLength(1);
  });

  it("a whole-library rerun that can't re-score an already scored id keeps it in place (never pending)", async () => {
    await load();
    const lib = ["1", "2", "3", "4", "5"];
    let run = 0;
    auto = (body) => {
      const r = answer(body);
      run++;
      // Run 1 scores 1 and 2 only; run 2 (more than half still missing) scores the rest but not 1.
      const retry = run === 1 ? ["3", "4", "5"] : ["1"];
      const keep = r.ids.map((id, i) => [id, r.s[i]!] as const).filter(([id]) => !retry.includes(id));
      return { status: 200, body: { ...r, ids: keep.map((k) => k[0]), s: keep.map((k) => k[1]), retry } };
    };
    boot(lib);
    m.cs.applyCustomSort(SPOOKY);
    await tick();
    expect([...st().pending].sort()).toEqual(["3", "4", "5"]);
    await tick(4_000);
    expect(sortCalls().map((c) => c.body)).toEqual([{ spec: SPOOKY }, { spec: SPOOKY }]);
    expect(st().pending.size).toBe(0);
    expect(st().committed?.scores.get("1")).toBe(scoreOf("1"));
    expect(st().committed?.scores.size).toBe(5);
    await tick(120_000);
    expect(sortCalls()).toHaveLength(2);
    expect(st().unweighed).toBe(0);
  });
});

describe("search bridge and reverse", () => {
  it("the Matches bucket turns reverse off (its chip is hidden while reversed)", async () => {
    await ready();
    m.cs.toggleReverse();
    expect(st().view.reverse).toBe(true);
    m.cs.applyCustomSort({ kind: "rank", prompt: "Spookiest" }, { source: "search", bucket: "matches" });
    expect(st().key).toBe("r:spookiest");
    expect(st().bucket).toBe("matches");
    expect(st().view.reverse).toBe(false);
    expect(JSON.parse(window.localStorage.getItem("ia:customSort")!).view.reverse).toBe(false);
    // Any other same-key re-apply keeps the player's reverse.
    m.cs.toggleReverse();
    m.cs.applyCustomSort(SPOOKY, { source: "recent" });
    expect(st().view.reverse).toBe(true);
    expect(sortCalls()).toHaveLength(1);
  });
});

describe("announcements", () => {
  const view = () => {
    const g = m.game.useGame.getState();
    const ui = m.ui.useUi.getState();
    const s = st();
    return m.ls.orderLibrary({
      owned: g.owned,
      elements: g.elements,
      pins: ui.pins,
      filter: ui.filter,
      sort: ui.sort,
      query: ui.query,
      now: Date.now(),
      custom: { committed: s.committed, pending: s.pending, reverse: s.view.reverse, other: s.view.other, bucket: s.bucket, prevSort: s.prevSort, key: s.key },
    });
  };
  const nameOf = (id: string) => m.game.useGame.getState().elements[id]!.name;

  it("“First: …” and “… comes first” name the head of the grid's order", async () => {
    await load();
    boot(["1", "2", "3", "4", "5", "6", "7", "8"]);
    m.ui.togglePin("8");
    m.cs.applyCustomSort(SPOOKY);
    await tick();
    const head = view().ids.slice(0, 3).map(nameOf);
    expect(m.ui.useUi.getState().live.polite).toBe(`Sorted by “spookiest”. First: ${head.join(", ")}.`);
    m.cs.toggleReverse();
    expect(m.ui.useUi.getState().live.polite).toBe(`Reversed. ${nameOf(view().ids[0]!)} comes first.`);
    m.cs.toggleReverse();
    expect(m.ui.useUi.getState().live.polite).toBe(`${nameOf(view().ids[0]!)} comes first.`);
  });

  it("groups: “Grouped: …” counts every group and Other", async () => {
    await load();
    boot(["1", "2", "3", "4", "5"]);
    m.cs.applyCustomSort(ZOO, { other: true });
    await tick();
    // answer(): g = id % 2 (1, 3, 5 → Food; 2, 4 → Animals), fit 900 (no Other).
    expect(m.ui.useUi.getState().live.polite).toBe("Grouped: 2 Animals, 3 Food, 0 Other.");
    expect(view().counts).toEqual({ kind: "groups", all: 5, groups: [2, 3], other: 0 });
  });
});

describe("select activation hold", () => {
  const storedRecent = (spec: SortSpec) => ({
    "ia:customSort": JSON.stringify({ v: 1, spec, view: { reverse: false, other: true }, recent: [], prevSort: "recent", seen: true }),
    "ia:libraryView": JSON.stringify({ filter: "all", sort: "recent" }),
  });

  it("an uncached ✦ activation starts its run after 400 ms", async () => {
    await load({ local: storedRecent(SPOOKY) });
    boot(ids4);
    m.cs.activateCustom();
    expect(m.ui.useUi.getState().sort).toBe("custom");
    expect(st().status).toBe("scoring"); // no "idle" flash before the run
    await tick(399);
    expect(sortCalls()).toHaveLength(0);
    await tick(1);
    expect(sortCalls().map((c) => c.body)).toEqual([{ spec: SPOOKY }]);
    expect(st().status).toBe("ready");
  });

  it("arrowing past ✦ onto another sort sends nothing", async () => {
    await load({ local: storedRecent(SPOOKY) });
    boot(ids4);
    m.ui.setLibraryView({ sort: "rarity" });
    m.cs.activateCustom();
    await tick(150);
    m.ui.setLibraryView({ sort: "az" });
    await tick(60_000);
    expect(calls).toHaveLength(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("a new spec inside the hold sends only that spec's run", async () => {
    await load({ local: storedRecent(SPOOKY) });
    boot(ids4);
    m.cs.activateCustom();
    await tick(100);
    m.cs.applyCustomSort(CUTE);
    await tick(60_000);
    expect(sortCalls().map((c) => c.body)).toEqual([{ spec: CUTE }]);
  });

  it("the sort sheet opened inside the hold keeps it until the sheet closes", async () => {
    await load({ local: storedRecent(SPOOKY) });
    boot(ids4);
    m.cs.activateCustom();
    await tick(200);
    m.ui.openSheet("customSort"); // arrowed on to "Custom…" and opened it
    await tick(10_000);
    expect(sortCalls()).toHaveLength(0);
    expect(st().slow).toBe(false); // nothing is being weighed yet
    m.ui.openSheet(null); // Cancel: the library is still on ✦
    await tick();
    expect(sortCalls().map((c) => c.body)).toEqual([{ spec: SPOOKY }]);
  });

  it("typed applies and cached activations don't wait", async () => {
    await load({ local: storedRecent(SPOOKY) });
    boot(ids4);
    m.cs.applyCustomSort(SPOOKY, { source: "recent" });
    expect(sortCalls()).toHaveLength(1);
    await tick();
    m.cs.clearCustomSort();
    m.cs.activateCustom();
    expect(st().status).toBe("ready");
    expect(sortCalls()).toHaveLength(1);
  });
});

describe("long rate limits", () => {
  it("an hour-long 429 shows queued ids as unscored until 30 s before `until`, then flushes them", async () => {
    await ready();
    auto = () => ({ status: 429, body: { error: "rate_limited", message: "slow down", retryAfterMs: 3_000_000 } });
    discover("5");
    expect([...st().pending]).toEqual(["5"]);
    await tick(2_500);
    expect(sortCalls()).toHaveLength(2);
    expect(st().failure).toMatchObject({ code: "rate_limited" });
    expect(st().pending.size).toBe(0); // sorts as unscored, no shimmer for the whole hour
    expect(st().status).toBe("ready");
    discover("6");
    expect(st().pending.size).toBe(0);
    auto = (body) => ({ status: 200, body: answer(body) });
    await tick(3_000_000 - 30_000 - 1);
    expect(st().pending.size).toBe(0);
    await tick(1);
    expect([...st().pending].sort()).toEqual(["5", "6"]);
    expect(sortCalls()).toHaveLength(2);
    await tick(29_999);
    expect(sortCalls()).toHaveLength(2);
    await tick(2); // the flush right at `until` (fake timers run a 0 ms timer set inside a tick 1 ms later)
    expect(sortCalls()).toHaveLength(3);
    expect([...sortCalls()[2]!.body.ids!].sort()).toEqual(["5", "6"]);
    expect(st().committed?.scores.has("6")).toBe(true);
    expect(st().pending.size).toBe(0);
  });

  it("a short 429 keeps queued ids pending", async () => {
    await ready();
    auto = () => ({ status: 429, body: { error: "rate_limited", message: "slow down", retryAfterMs: 8_000 } });
    discover("5");
    await tick(2_500);
    expect(st().failure).toMatchObject({ code: "rate_limited" });
    expect([...st().pending]).toEqual(["5"]);
  });
});
