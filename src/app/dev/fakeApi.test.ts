// The dev fake's custom sort: POST /api/sort (whole library, ids, validation, the ?fake=errors
// rotation) and the combine piggyback, all scored by the shared mock scorer.
import { afterEach, describe, expect, it, vi } from "vitest";
import { SORT_RUBRIC, type BootstrapResponse, type CombineResponse, type SortRequest, type SortResponse, type SortSpec } from "../../shared/api.ts";
import { mockSortScores } from "../../shared/mockSort.ts";
import type { Transport } from "../lib/api.ts";

let transport: Transport | null = null;
vi.mock("../lib/api.ts", () => ({ setTransport: (t: Transport) => (transport = t) }));

const WEATHER: SortSpec = { kind: "rank", prompt: "weather" };

async function load(mode: string) {
  vi.resetModules();
  transport = null;
  vi.stubGlobal("location", { search: `?fake=${mode}` });
  vi.stubGlobal("window", {});
  vi.spyOn(console, "info").mockImplementation(() => {});
  // Only the fake's latency sleeps are faked; Response bodies keep their real scheduling.
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  const { installFakeApi } = await import("./fakeApi.ts");
  installFakeApi();
}

async function call<T>(path: string, body: unknown): Promise<{ status: number; body: T }> {
  const p = transport!(path, { method: "POST", body: JSON.stringify(body) });
  await vi.advanceTimersByTimeAsync(3_000);
  const res = await p;
  return { status: res.status, body: (await res.json()) as T };
}

const library = async () => (await call<BootstrapResponse>("/api/bootstrap", { clientDate: "2026-11-07" })).body.library;

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("fake /api/sort", () => {
  it("scores the whole library with the shared mock scorer", async () => {
    await load("rich");
    const lib = await library();
    const { status, body } = await call<SortResponse>("/api/sort", { spec: WEATHER } satisfies SortRequest);
    expect(status).toBe(200);
    expect(body.engine).toBe(`fake/${SORT_RUBRIC}`); // the real rubric, so mirrors key it like a real response
    expect(new Set(body.ids)).toEqual(new Set(lib.map((e) => e.id)));
    expect(body.s).toHaveLength(body.ids.length);
    expect(body.g).toBeUndefined();
    expect(body.retry).toEqual([]);
    const name = new Map(lib.map((e) => [e.id, e.name]));
    expect(body.s).toEqual(mockSortScores(WEATHER, body.ids.map((id) => ({ id, name: name.get(id)! }))).map((x) => x.s));
    const top = body.ids.map((id, i) => [name.get(id)!, body.s[i]!] as const).sort((a, b) => b[1] - a[1]).slice(0, 4);
    expect(new Set(top.map((t) => t[0]))).toEqual(new Set(["Mist", "Cloud", "Lightning", "Rainbow"]));
  });

  it("groups get aligned g/n; ids are deduped and unowned ones dropped silently", async () => {
    await load("rich");
    const lib = await library();
    const [a, b] = [lib[0]!.id, lib[1]!.id];
    const { body } = await call<SortResponse>("/api/sort", {
      spec: { kind: "groups", groups: ["Weather", "Space"] },
      ids: [a, b, a, "1999999999999999999"],
    } satisfies SortRequest);
    expect(body.ids).toEqual([a, b]);
    expect(body.g).toHaveLength(2);
    expect(body.n).toHaveLength(2);
    expect(body.retry).toEqual([]);
  });

  it("rejects a spec the server would reject", async () => {
    await load("rich");
    const { status, body } = await call<{ error: string }>("/api/sort", { spec: { kind: "groups", groups: ["Weather", "Other"] } });
    expect(status).toBe(400);
    expect(body.error).toBe("bad_request");
  });

  it("?fake=errors rotates rate_limited, ai_unavailable, budget_exhausted, then succeeds", async () => {
    await load("errors");
    const seen = [];
    for (let i = 0; i < 4; i++) {
      const { status, body } = await call<{ error?: string; retryAfterMs?: number }>("/api/sort", { spec: WEATHER });
      seen.push([status, body.error ?? "ok", body.retryAfterMs]);
    }
    expect(seen).toEqual([
      [429, "rate_limited", 8_000],
      [503, "ai_unavailable", undefined],
      [503, "budget_exhausted", 60_000],
      [200, "ok", undefined],
    ]);
  });
});

describe("fake /api/combine with a custom sort", () => {
  it("scores a discovery that is new for the player, and only then", async () => {
    await load("");
    const lib = await library();
    const id = (n: string) => lib.find((e) => e.name === n)!.id;
    const ids = [id("Water"), id("Fire")];
    const first = await call<CombineResponse>("/api/combine", { ids, clientDate: "2026-11-07", sort: WEATHER });
    expect(first.body.result.name).toBe("Steam");
    expect(first.body.newForPlayer).toBe(true);
    expect(first.body.sortScore).toEqual(mockSortScores(WEATHER, [{ id: first.body.result.id, name: "Steam" }])[0]);
    const again = await call<CombineResponse>("/api/combine", { ids, clientDate: "2026-11-07", sort: WEATHER });
    expect(again.body.newForPlayer).toBe(false);
    expect(again.body.sortScore).toBeUndefined();
    const plain = await call<CombineResponse>("/api/combine", { ids: [id("Earth"), id("Water")], clientDate: "2026-11-07" });
    expect(plain.body.newForPlayer).toBe(true);
    expect(plain.body.sortScore).toBeUndefined();
  });
});
