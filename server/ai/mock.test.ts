import { crc32, inflateSync } from "node:zlib";
import { describe, expect, it, vi } from "vitest";
import { SORT_FIT_THRESHOLD, SORT_MATCH_THRESHOLD, SORT_RUBRIC, type SortSpec } from "../../src/shared/api.ts";
import { mockSortScores, stem } from "../../src/shared/mockSort.ts";
import { checkName, foldKey, nameKey } from "../../src/shared/names.ts";
import { AiUnavailable, Blocked, Fizzled } from "./common.ts";
import type { ScoreOpts } from "./jev.ts";
import { mockCombine, mockImage, mockPng, mockScore } from "./mock.ts";

const STARTERS = ["Earth", "Water", "Air", "Fire", "Time"];
const OPTS: ScoreOpts = { deadlineMs: 20_000, retries: 1, split: true };

describe("mock combine", () => {
  it("is deterministic and order-independent", () => {
    expect(mockCombine(["Fire", "Glowing Golem"])).toEqual(mockCombine(["Glowing Golem", "Fire"]));
    expect(mockCombine(["Fire", "Water"]).name).toBe("Steam");
  });

  it("always produces valid, new names", () => {
    const pool = [...STARTERS];
    for (let i = 0; i < 400; i++) {
      const a = pool[(i * 7) % pool.length]!;
      const b = pool[(i * 13 + 3) % pool.length]!;
      const ingredients = i % 3 === 0 ? [a, b, pool[i % pool.length]!] : [a, b];
      const p = mockCombine(ingredients);
      expect(checkName(p.name).ok, p.name).toBe(true);
      expect(p.key).toBe(nameKey(p.name));
      expect(ingredients.map((n) => foldKey(nameKey(n)))).not.toContain(p.foldKey);
      expect(p.emoji).toBeTruthy();
      expect(p.description).toBeTruthy();
      if (!pool.includes(p.name)) pool.push(p.name);
    }
    expect(pool.length).toBeGreaterThan(50);
  });

  it("exposes a fizzle hook for e2e", () => {
    expect(() => mockCombine(["Mock Fizzle", "Fire"])).toThrow(Fizzled);
  });
});

describe("mock image", () => {
  it("is a valid RGBA PNG with correct CRCs", () => {
    const png = Buffer.from(mockPng("Steam"));
    expect(png.subarray(0, 8)).toEqual(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
    let offset = 8;
    const types: string[] = [];
    let idat = Buffer.alloc(0);
    let width = 0;
    while (offset < png.length) {
      const len = png.readUInt32BE(offset);
      const type = png.toString("ascii", offset + 4, offset + 8);
      const data = png.subarray(offset + 8, offset + 8 + len);
      expect(png.readUInt32BE(offset + 8 + len)).toBe(crc32(png.subarray(offset + 4, offset + 8 + len)));
      if (type === "IHDR") {
        width = data.readUInt32BE(0);
        expect(data[9]).toBe(6); // RGBA
      }
      if (type === "IDAT") idat = Buffer.concat([idat, data]);
      types.push(type);
      offset += 12 + len;
    }
    expect(types).toEqual(["IHDR", "IDAT", "IEND"]);
    const raw = inflateSync(idat);
    expect(raw.length).toBe(width * (1 + width * 4));
    // Corners are transparent, the center is opaque.
    expect(raw[1 + 3]).toBe(0);
    const mid = (width >> 1) * (1 + width * 4) + 1 + (width >> 1) * 4;
    expect(raw[mid + 3]).toBe(255);
    expect(png.length).toBeLessThan(10_000);
  });

  it("colors by name and supports the blocked hook", () => {
    expect(Buffer.from(mockPng("Steam")).equals(Buffer.from(mockPng("Steam")))).toBe(true);
    expect(Buffer.from(mockPng("Steam")).equals(Buffer.from(mockPng("Lava")))).toBe(false);
    expect(mockImage("Steam")).toMatchObject({ ext: "png", contentType: "image/png" });
    expect(() => mockImage("Mock Blocked")).toThrow(Blocked);
  });
});

describe("mock sort", () => {
  // The e2e seed's world (scripts/seed-e2e.ts), with ids as the DB would hand them out.
  const NAMES = [...STARTERS, "Steam", "Mud", "Lava", "Cloud", "Storm", "Rain", "Lightning", "Sword", "Rocket", "Mars", "Galaxy", "Apple"];
  const ITEMS = NAMES.map((name, i) => ({ id: String(1_083_333_177_628_557_313n + BigInt(i) * 7n), name }));
  const weather: SortSpec = { kind: "rank", prompt: "weather" };
  const ws: SortSpec = { kind: "groups", groups: ["Weather", "Space"] };
  const byName = (spec: SortSpec) => new Map(mockSortScores(spec, ITEMS).map((sc, i) => [ITEMS[i]!.name, sc]));

  it("stems spec and name words", () => {
    expect(["spookiest", "hottest", "biggest", "oldest", "animals", "gas"].map(stem)).toEqual(["spooky", "hot", "big", "old", "animal", "gas"]);
  });

  it("is deterministic and order-independent", () => {
    for (const spec of [weather, ws]) {
      const a = mockSortScores(spec, ITEMS);
      const reversed = mockSortScores(spec, [...ITEMS].reverse()).reverse();
      expect(reversed).toEqual(a);
      expect(mockSortScores(spec, [ITEMS[3]!])[0]).toEqual(a[3]);
    }
    // Case and spacing never change the key, so the scores agree too.
    expect(mockSortScores({ kind: "rank", prompt: "Weather" }, ITEMS)).toEqual(mockSortScores(weather, ITEMS));
  });

  it("returns integers in 0..1000 and group indexes in range", () => {
    for (const spec of [weather, ws, { kind: "rank", prompt: "spookiest" } as SortSpec]) {
      for (const sc of mockSortScores(spec, ITEMS)) {
        for (const v of [sc.s, sc.n ?? 0]) expect(Number.isInteger(v) && v >= 0 && v <= 1000, JSON.stringify(sc)).toBe(true);
        if (spec.kind === "groups") expect(sc.g).toBeGreaterThanOrEqual(0);
        if (spec.kind === "groups") expect(sc.g).toBeLessThan(spec.groups.length);
        else expect(sc.g).toBeUndefined();
      }
    }
  });

  it('ranks Storm, Rain, Cloud and Lightning above Sword and the starters for "weather"', () => {
    const s = byName(weather);
    const low = Math.min(...["Storm", "Rain", "Cloud", "Lightning"].map((n) => s.get(n)!.s));
    for (const n of ["Sword", ...STARTERS]) expect(s.get(n)!.s, n).toBeLessThan(low);
    expect(low).toBeGreaterThanOrEqual(SORT_MATCH_THRESHOLD);
  });

  it("groups into the first matching group, and weak fits fall below the fit threshold", () => {
    const g = byName(ws);
    expect(g.get("Rocket")).toMatchObject({ g: 1, n: 900 });
    expect(g.get("Mars")).toMatchObject({ g: 1, n: 900 }); // lexicon words are stemmed like name words
    expect(g.get("Storm")).toMatchObject({ g: 0, n: 900 });
    expect(g.get("Earth")!.n).toBeLessThan(SORT_FIT_THRESHOLD);
    expect(g.get("Sword")!.n).toBeLessThan(SORT_FIT_THRESHOLD);
  });

  it("mockScore reports the mock engine and every id once", async () => {
    const out = await mockScore(weather, ITEMS, OPTS);
    expect(out).toMatchObject({ engine: `mock/${SORT_RUBRIC}`, retry: [], tokens: 0 });
    expect([...out.scored.keys()]).toEqual(ITEMS.map((it) => it.id));
    expect(out.scored.get(ITEMS[0]!.id)).toEqual(mockSortScores(weather, ITEMS)[0]);
  });

  it("exposes unavailable, partial and slow hooks for e2e", async () => {
    await expect(mockScore({ kind: "rank", prompt: "Mock Unavailable" }, ITEMS, OPTS)).rejects.toBeInstanceOf(AiUnavailable);
    await expect(mockScore({ kind: "groups", groups: ["Fire", "mock unavailable"] }, ITEMS, OPTS)).rejects.toBeInstanceOf(AiUnavailable);

    const partial = await mockScore({ kind: "rank", prompt: "mock partial" }, ITEMS, OPTS);
    expect(partial.retry).toEqual(ITEMS.filter((_, i) => i % 3 === 2).map((it) => it.id));
    expect(partial.scored.size + partial.retry.length).toBe(ITEMS.length);

    vi.useFakeTimers();
    try {
      let done = false;
      const slow = mockScore({ kind: "rank", prompt: "mock slow" }, ITEMS, OPTS).then(() => (done = true));
      await vi.advanceTimersByTimeAsync(2_400);
      expect(done).toBe(false);
      await vi.advanceTimersByTimeAsync(200);
      await slow;
      expect(done).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });
});
