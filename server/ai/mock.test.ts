import { crc32, inflateSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import { checkName, foldKey, nameKey } from "../../src/shared/names.ts";
import { Blocked, Fizzled } from "./common.ts";
import { mockCombine, mockImage, mockPng } from "./mock.ts";

const STARTERS = ["Earth", "Water", "Air", "Fire", "Time"];

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
