// Unit tests for the pure custom-sort helpers: stored preferences, recents, merging server
// responses into a score entry, and the session score mirror.
import { afterEach, describe, expect, it, vi } from "vitest";
import { SORT_RUBRIC, type SortResponse, type SortSpec } from "../../shared/api.ts";
import {
  decodeMirror,
  defaultStoredSort,
  encodeMirror,
  mergeFullResponse,
  mergeOne,
  mergeResponse,
  newEntry,
  pushRecent,
  readStoredSort,
  writeStoredSort,
  type SavedSort,
} from "./customSort.ts";
import { KEYS } from "./storage.ts";

const rank = (prompt: string): SortSpec => ({ kind: "rank", prompt });
const groups = (...g: string[]): SortSpec => ({ kind: "groups", groups: g });
const res = (p: Partial<SortResponse>): SortResponse => ({ engine: `mock/${SORT_RUBRIC}`, ids: [], s: [], retry: [], ...p });

/** A memory Web Storage. */
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

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("readStoredSort", () => {
  it("defaults for missing or foreign data", () => {
    expect(readStoredSort(null)).toEqual(defaultStoredSort());
    expect(readStoredSort("nope")).toEqual(defaultStoredSort());
    expect(readStoredSort([])).toEqual(defaultStoredSort());
    expect(readStoredSort({ v: 2, spec: rank("x") })).toEqual(defaultStoredSort());
    // Node has no window: the default read falls back quietly.
    expect(readStoredSort()).toEqual(defaultStoredSort());
  });
  it("keeps a valid record as is (normalized)", () => {
    const s = {
      v: 1,
      spec: rank("  spookiest "),
      view: { reverse: true, other: false },
      recent: [{ spec: groups("Animals", "Food"), other: false }, { spec: rank("cutest") }],
      prevSort: "az",
      seen: true,
    };
    expect(readStoredSort(s)).toEqual({ ...s, spec: rank("spookiest") });
  });
  it("rejects garbage field by field", () => {
    const got = readStoredSort({
      v: 1,
      spec: { kind: "rank", prompt: "x".repeat(81) },
      view: { reverse: "yes", other: 0 },
      recent: [
        null,
        { spec: { kind: "groups", groups: ["Only one"] } },
        { spec: { kind: "groups", groups: ["A", "Other"] } },
        { spec: { kind: "rank", prompt: 7 } },
        { spec: rank("cutest"), other: true }, // `other` only means something for groups
        { spec: rank("CUTEST") }, // duplicate key
        { spec: groups("A", "B"), other: "no" },
        { spec: { kind: "wat" } },
      ],
      prevSort: "custom",
      seen: "true",
    });
    expect(got).toEqual({
      v: 1,
      spec: null,
      view: { reverse: false, other: true },
      recent: [{ spec: rank("cutest") }, { spec: groups("A", "B") }],
      prevSort: "recent",
      seen: false,
    });
    expect(readStoredSort({ v: 1, spec: { kind: "groups", groups: "A,B" } }).spec).toBeNull();
    expect(readStoredSort({ v: 1, spec: { kind: "groups", groups: ["A", "a"] } }).spec).toBeNull();
    expect(readStoredSort({ v: 1, recent: "x", view: null }).recent).toEqual([]);
  });
  it("caps recents at five", () => {
    const recent = Array.from({ length: 8 }, (_, i) => ({ spec: rank(`p${i}`) }));
    expect(readStoredSort({ v: 1, recent }).recent.map((r) => (r.spec as { prompt: string }).prompt)).toEqual(["p0", "p1", "p2", "p3", "p4"]);
  });
  it("round-trips through localStorage", () => {
    const localStorage = memoryStorage();
    vi.stubGlobal("window", { localStorage, sessionStorage: memoryStorage() });
    const s = { ...defaultStoredSort(), spec: rank("hottest"), prevSort: "rarity" as const, seen: true };
    writeStoredSort(s);
    expect(JSON.parse(localStorage.getItem(KEYS.customSort)!)).toEqual(s);
    expect(readStoredSort()).toEqual(s);
    localStorage.setItem(KEYS.customSort, "{not json");
    expect(readStoredSort()).toEqual(defaultStoredSort());
  });
});

describe("pushRecent", () => {
  it("puts the newest first, dedupes by key (case-insensitive) and caps at five", () => {
    let r: SavedSort[] = [];
    for (const p of ["a", "b", "c", "d", "e", "f"]) r = pushRecent(r, { spec: rank(p) });
    expect(r.map((x) => (x.spec as { prompt: string }).prompt)).toEqual(["f", "e", "d", "c", "b"]);
    r = pushRecent(r, { spec: rank("C") });
    expect(r.map((x) => (x.spec as { prompt: string }).prompt)).toEqual(["C", "f", "e", "d", "b"]);
    r = pushRecent(r, { spec: groups("x", "y"), other: false });
    r = pushRecent(r, { spec: groups("X", "Y"), other: true });
    expect(r[0]).toEqual({ spec: groups("X", "Y"), other: true });
    expect(r.filter((x) => x.spec.kind === "groups")).toHaveLength(1);
  });
});

describe("mergeResponse", () => {
  it("stores rank scores and marks requested-but-unanswered ids unscorable", () => {
    const e = newEntry("rank");
    const { requeue } = mergeResponse(e, res({ ids: ["1", "2"], s: [900, 12.4] }), ["1", "2", "3"]);
    expect(requeue).toEqual([]);
    expect([...e.s]).toEqual([
      ["1", 900],
      ["2", 12],
    ]);
    expect([...e.unscorable]).toEqual(["3"]);
    expect(e.g).toBeNull();
  });
  it("stores groups with their group and fit", () => {
    const e = newEntry("groups");
    mergeResponse(e, res({ ids: ["1"], s: [800], g: [2], n: [450] }), ["1"]);
    expect(e.s.get("1")).toBe(800);
    expect(e.g!.get("1")).toBe(2);
    expect(e.n!.get("1")).toBe(450);
  });
  it("requeues retry ids after 4 s, then 20 s, then fails them", () => {
    const e = newEntry("rank");
    expect(mergeResponse(e, res({ retry: ["7"] }), ["7"]).requeue).toEqual([{ id: "7", delayMs: 4_000 }]);
    expect(mergeResponse(e, res({ retry: ["7"] }), ["7"]).requeue).toEqual([{ id: "7", delayMs: 20_000 }]);
    expect(e.failed.has("7")).toBe(false);
    expect(mergeResponse(e, res({ retry: ["7"] }), ["7"]).requeue).toEqual([]);
    expect(e.failed.has("7")).toBe(true);
    expect(e.unscorable.has("7")).toBe(false);
  });
  it("a later score clears the failure bookkeeping", () => {
    const e = newEntry("rank");
    mergeResponse(e, res({ retry: ["7"] }), ["7"]);
    mergeResponse(e, res({ retry: ["7"] }), ["7"]);
    mergeResponse(e, res({ retry: ["7"] }), ["7"]);
    mergeResponse(e, res({ ids: ["7"], s: [500] }), ["7"]);
    expect(e.failed.has("7")).toBe(false);
    expect(e.attempts.has("7")).toBe(false);
    expect(e.s.get("7")).toBe(500);
  });
  it("treats malformed scores as a miss, never as data", () => {
    const e = newEntry("groups");
    const { requeue } = mergeResponse(
      e,
      res({ ids: ["1", "2", "3", "4"], s: [800, Number.NaN, 700, 600], g: [0, 0, 99, 1], n: [900, 900, 900] }),
      ["1", "2", "3", "4"],
    );
    expect([...e.s.keys()]).toEqual(["1"]);
    expect(requeue.map((r) => r.id)).toEqual(["2", "3", "4"]);
    expect(e.unscorable.size).toBe(0);
  });
  it("clamps out-of-range values", () => {
    const e = newEntry("rank");
    mergeResponse(e, res({ ids: ["1", "2"], s: [-5, 1200] }), []);
    expect([e.s.get("1"), e.s.get("2")]).toEqual([0, 1000]);
  });
  it("mergeOne folds a combine piggyback in and ignores bad ones", () => {
    const e = newEntry("groups");
    e.unscorable.add("9");
    mergeOne(e, "9", { s: 700, g: 1, n: 800 });
    expect(e.g!.get("9")).toBe(1);
    expect(e.unscorable.has("9")).toBe(false);
    mergeOne(e, "10", { s: 700 }); // a groups entry needs g and n
    expect(e.s.has("10")).toBe(false);
  });
  it("a retry or a malformed value for an id that already has a score keeps that score", () => {
    const e = newEntry("groups");
    mergeResponse(e, res({ ids: ["1", "2"], s: [800, 300], g: [1, 0], n: [900, 200] }), ["1", "2"]);
    for (let run = 0; run < 4; run++) {
      // A later whole-library run: "1" comes back in retry, "2" with a broken value.
      const { requeue } = mergeResponse(e, res({ ids: ["2"], s: [Number.NaN], g: [0], n: [200], retry: ["1"] }), ["1", "2"]);
      expect(requeue).toEqual([]);
    }
    expect([e.s.get("1"), e.g!.get("1"), e.n!.get("1")]).toEqual([800, 1, 900]);
    expect([e.s.get("2"), e.g!.get("2"), e.n!.get("2")]).toEqual([300, 0, 200]);
    expect(e.attempts.size).toBe(0);
    expect(e.failed.size).toBe(0);
    expect(e.unscorable.size).toBe(0); // answered, so never "not scorable" either
    // An unscored id still counts its misses.
    expect(mergeResponse(e, res({ retry: ["3"] }), ["3"]).requeue).toEqual([{ id: "3", delayMs: 4_000 }]);
  });
});

describe("complete entries", () => {
  it("only a whole-library response makes an entry complete; it also records truncation", () => {
    const e = newEntry("rank");
    mergeOne(e, "1", { s: 900 });
    mergeResponse(e, res({ ids: ["2"], s: [100] }), ["2"]);
    expect(e.complete).toBe(false);
    mergeFullResponse(e, res({ ids: ["3"], s: [500], truncated: true }), ["1", "2", "3", "4"]);
    expect(e.complete).toBe(true);
    expect(e.truncated).toBe(true);
    expect(e.unscorable.has("4")).toBe(true); // cut by the truncation: never asked for again
    mergeFullResponse(e, res({ ids: ["4"], s: [5] }), ["4"]);
    expect(e.truncated).toBe(false);
  });
});

describe("session mirror", () => {
  const owned = { "1": {}, "2": {}, "3": {} };
  it("round-trips rank and groups entries, owned ids only", () => {
    const r = newEntry("rank");
    mergeResponse(r, res({ ids: ["1", "2", "gone"], s: [900, 100, 500] }), []);
    const m = encodeMirror("p1", "r:spooky", r, owned);
    expect(m).toEqual({ v: 1, r: SORT_RUBRIC, p: "p1", k: "r:spooky", ids: ["1", "2"], s: [900, 100] });
    const back = decodeMirror(JSON.parse(JSON.stringify(m)), "p1", "r:spooky", "rank")!;
    expect([...back.s]).toEqual([
      ["1", 900],
      ["2", 100],
    ]);

    const g = newEntry("groups");
    mergeResponse(g, res({ ids: ["1", "3"], s: [800, 300], g: [1, 0], n: [900, 200] }), []);
    const gm = encodeMirror("p1", "g:a\u0001b", g, owned);
    const gb = decodeMirror(gm, "p1", "g:a\u0001b", "groups")!;
    expect([...gb.g!]).toEqual([
      ["1", 1],
      ["3", 0],
    ]);
    expect([...gb.n!]).toEqual([
      ["1", 900],
      ["3", 200],
    ]);
  });
  it("is rejected for another player, key, rubric or kind, or when malformed", () => {
    const e = newEntry("rank");
    mergeResponse(e, res({ ids: ["1"], s: [900] }), []);
    const m = encodeMirror("p1", "r:spooky", e, owned);
    expect(decodeMirror(m, "p2", "r:spooky", "rank")).toBeNull();
    expect(decodeMirror(m, "p1", "r:cutest", "rank")).toBeNull();
    expect(decodeMirror({ ...m, r: "r0" }, "p1", "r:spooky", "rank")).toBeNull();
    expect(decodeMirror(m, "p1", "r:spooky", "groups")).toBeNull();
    expect(decodeMirror({ ...m, v: 2 }, "p1", "r:spooky", "rank")).toBeNull();
    expect(decodeMirror({ ...m, s: [] }, "p1", "r:spooky", "rank")).toBeNull();
    expect(decodeMirror({ ...m, s: ["x"] }, "p1", "r:spooky", "rank")).toBeNull();
    expect(decodeMirror({ ...m, ids: [1] }, "p1", "r:spooky", "rank")).toBeNull();
    expect(decodeMirror(null, "p1", "r:spooky", "rank")).toBeNull();
    const gm = { v: 1, r: SORT_RUBRIC, p: "p1", k: "g:a\u0001b", ids: ["1"], s: [5], g: [0] };
    expect(decodeMirror(gm, "p1", "g:a\u0001b", "groups")).toBeNull();
    expect(decodeMirror({ ...m, u: "4" }, "p1", "r:spooky", "rank")).toBeNull();
  });
  it("carries the ids the server ruled out and the truncated flag (owned only)", () => {
    const e = newEntry("rank");
    // A truncated whole-library run: "3" and "gone" were cut, "2" was scored.
    mergeFullResponse(e, res({ ids: ["2"], s: [700], truncated: true }), ["2", "3", "gone"]);
    const m = encodeMirror("p1", "r:spooky", e, owned);
    expect(m).toEqual({ v: 1, r: SORT_RUBRIC, p: "p1", k: "r:spooky", ids: ["2"], s: [700], u: ["3"], t: true });
    const back = decodeMirror(JSON.parse(JSON.stringify(m)), "p1", "r:spooky", "rank")!;
    expect([...back.unscorable]).toEqual(["3"]);
    expect(back.truncated).toBe(true);
    expect(back.complete).toBe(true);
  });
  it("decodes a mirror without u/t (nothing ruled out) and skips junk ids in u", () => {
    const base = { v: 1, r: SORT_RUBRIC, p: "p1", k: "r:spooky", ids: ["1"], s: [900] };
    const plain = decodeMirror(base, "p1", "r:spooky", "rank")!;
    expect([plain.unscorable.size, plain.truncated, plain.complete]).toEqual([0, false, true]);
    const junk = decodeMirror({ ...base, u: [7, "4", null, "1"], t: "yes" }, "p1", "r:spooky", "rank")!;
    expect([...junk.unscorable]).toEqual(["4"]); // "1" is scored: a score wins
    expect(junk.truncated).toBe(false);
  });
});
