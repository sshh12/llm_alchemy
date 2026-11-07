import { describe, expect, it } from "vitest";
import {
  clampPt,
  dist,
  findSpawn,
  keepClear,
  magnetOffset,
  nearestInDirection,
  needsTidy,
  overlapRatio,
  relax,
  rescale,
  tidyLayout,
  trackTarget,
  type Bounds,
} from "./geometry.ts";

const T = 76;
const B: Bounds = { w: 400, h: 600, left: 8, right: 8, top: 8, bottom: 8 };

describe("clampPt", () => {
  it("keeps tile centers inside the padded canvas", () => {
    expect(clampPt({ x: -50, y: 9999 }, B, T)).toEqual({ x: 8 + T / 2, y: 600 - 8 - T / 2 });
    expect(clampPt({ x: 200, y: 300 }, B, T)).toEqual({ x: 200, y: 300 });
  });
  it("centers when the canvas is smaller than a tile", () => {
    expect(clampPt({ x: 0, y: 0 }, { ...B, w: 50, h: 50 }, T)).toEqual({ x: 25, y: 25 });
  });
});

describe("overlapRatio", () => {
  it("is 1 for identical centers and 0 when apart", () => {
    expect(overlapRatio({ x: 0, y: 0 }, { x: 0, y: 0 }, T)).toBe(1);
    expect(overlapRatio({ x: 0, y: 0 }, { x: T, y: 0 }, T)).toBe(0);
    expect(overlapRatio({ x: 0, y: 0 }, { x: T / 2, y: 0 }, T)).toBeCloseTo(0.5);
  });
});

describe("rescale", () => {
  it("maps positions proportionally", () => {
    expect(rescale([{ x: 100, y: 300 }], { w: 400, h: 600 }, { w: 800, h: 300 })).toEqual([{ x: 200, y: 150 }]);
  });
});

describe("relax", () => {
  it("separates heavily overlapping tiles and keeps pinned ones fixed", () => {
    const out = relax([{ x: 200, y: 300 }, { x: 205, y: 302 }], B, T, new Set([0]));
    expect(out[0]).toEqual({ x: 200, y: 300 });
    expect(overlapRatio(out[0]!, out[1]!, T)).toBeLessThanOrEqual(0.25);
  });
  it("leaves lightly overlapping tiles alone", () => {
    const pts = [{ x: 100, y: 100 }, { x: 100 + T * 0.8, y: 100 }];
    expect(relax(pts, B, T)).toEqual(pts);
  });
  it("separates identical centers deterministically", () => {
    const out = relax([{ x: 200, y: 300 }, { x: 200, y: 300 }], B, T);
    expect(dist(out[0]!, out[1]!)).toBeGreaterThan(T * 0.5);
  });
});

describe("findSpawn", () => {
  it("uses the center of an empty canvas", () => {
    expect(findSpawn([], B, T)).toEqual({ x: 200, y: 300 });
  });
  it("never lands within 0.9·T of an existing tile", () => {
    const existing = [{ x: 200, y: 300 }];
    const p = findSpawn(existing, B, T);
    expect(dist(p, existing[0]!)).toBeGreaterThanOrEqual(0.9 * T);
  });
  it("avoids blocked rects (e.g. a half-open shelf)", () => {
    const p = findSpawn([], B, T, undefined, [{ x: 0, y: 250, w: 400, h: 350 }]);
    expect(p.y + T / 2).toBeLessThanOrEqual(250);
  });
  it("still returns an in-bounds point when the canvas is full", () => {
    const crowd = Array.from({ length: 200 }, (_, i) => ({ x: (i % 10) * 40, y: Math.floor(i / 10) * 30 }));
    const p = findSpawn(crowd, B, T);
    expect(p).toEqual(clampPt(p, B, T));
  });
});

describe("keepClear", () => {
  it("moves tiles out from under an obstacle by the smallest step", () => {
    const toolbar = { x: 340, y: 400, w: 60, h: 200 };
    const [p] = keepClear([{ x: 360, y: 500 }], [toolbar], B, T);
    expect(p!.x + T / 2).toBeLessThanOrEqual(toolbar.x);
    expect(p!.y).toBe(500);
  });
  it("leaves clear tiles alone", () => {
    expect(keepClear([{ x: 100, y: 100 }], [{ x: 340, y: 400, w: 60, h: 200 }], B, T)).toEqual([{ x: 100, y: 100 }]);
  });
});

describe("tidyLayout", () => {
  it("packs tiles into non-overlapping rows inside bounds", () => {
    const pts = tidyLayout(7, B, T);
    expect(pts).toHaveLength(7);
    for (const p of pts) expect(p).toEqual(clampPt(p, B, T));
    for (let i = 0; i < pts.length; i++) for (let j = i + 1; j < pts.length; j++) expect(overlapRatio(pts[i]!, pts[j]!, T)).toBe(0);
  });
  it("compresses rows when there are too many tiles for the height", () => {
    const pts = tidyLayout(60, { ...B, h: 300 }, T);
    for (const p of pts) expect(p).toEqual(clampPt(p, { ...B, h: 300 }, T));
  });
});

describe("needsTidy", () => {
  it("flags a heap of overlapping tiles", () => {
    const heap = Array.from({ length: 14 }, (_, i) => ({ x: 200 + i * 2, y: 300 }));
    expect(needsTidy(heap, B, T)).toBe(true);
    expect(needsTidy(tidyLayout(6, B, T), B, T)).toBe(false);
  });
});

describe("trackTarget", () => {
  const cands = [
    { uid: "a", x: 100, y: 100 },
    { uid: "b", x: 100 + T * 0.8, y: 100 },
  ];
  it("locks the nearest candidate inside the capture radius", () => {
    expect(trackTarget({ x: 110, y: 100 }, cands, T, null)?.uid).toBe("a");
    expect(trackTarget({ x: 400, y: 400 }, cands, T, null)).toBeNull();
  });
  it("keeps a locked target until 0.75·T (hysteresis)", () => {
    // Slightly closer to b, but a is still within 0.75·T: stay on a.
    expect(trackTarget({ x: 100 + T * 0.42, y: 100 }, cands, T, "a")?.uid).toBe("a");
    expect(trackTarget({ x: 100 + T * 0.8, y: 100 }, cands, T, "a")?.uid).toBe("b");
  });
});

describe("magnetOffset", () => {
  it("pulls toward the target only inside the capture radius", () => {
    expect(magnetOffset({ x: 0, y: 0 }, { x: T, y: 0 }, T)).toEqual({ x: 0, y: 0 });
    const near = magnetOffset({ x: 0, y: 0 }, { x: T * 0.3, y: 0 }, T);
    expect(near.x).toBeCloseTo(T * 0.3 * 0.35);
  });
});

describe("nearestInDirection", () => {
  it("prefers on-axis neighbours", () => {
    const others = [
      { uid: "right", x: 200, y: 100 },
      { uid: "diag", x: 150, y: 160 },
      { uid: "up", x: 100, y: 20 },
    ];
    expect(nearestInDirection({ x: 100, y: 100 }, others, "right")?.uid).toBe("right");
    expect(nearestInDirection({ x: 100, y: 100 }, others, "up")?.uid).toBe("up");
    expect(nearestInDirection({ x: 100, y: 100 }, others, "left")).toBeNull();
  });
});
