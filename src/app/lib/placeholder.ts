// Deterministic procedural placeholder art: a name-hashed gradient blob behind the
// element's emoji, shown instantly while (or instead of) AI art.

export function fnv1a(s: string): number {
  let h = 0x811c9dc5;
  for (const ch of s.toLowerCase()) {
    h ^= ch.codePointAt(0)!;
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h;
}

export interface PlaceholderParams {
  hue: number;
  hue2: number;
  shape: number;
  rotate: number;
}

export function placeholderFor(name: string): PlaceholderParams {
  const h = fnv1a(name);
  const hue = h % 360;
  return {
    hue,
    hue2: (hue + 40 + ((h >>> 9) % 80)) % 360,
    shape: (h >>> 17) % BLOB_PATHS.length,
    rotate: (h >>> 3) % 360,
  };
}

/** Organic blob outlines in a 100×100 box, centered on (50, 50). */
export const BLOB_PATHS = [
  "M50 8c17 0 34 9 39 25s1 33-9 45-29 18-44 12S8 70 7 53 15 21 27 13 40 8 50 8Z",
  "M52 6c15 2 28 12 35 26s6 31-3 43-26 20-41 17-30-12-36-27-3-32 7-44S37 4 52 6Z",
  "M47 9c14-3 31 1 40 13s10 30 4 44-20 26-36 26-31-9-38-23-6-31 2-43 14-14 28-17Z",
  "M50 10c12 0 22 6 30 14s13 18 12 30-9 24-20 31-26 9-38 3-22-18-23-31 4-25 13-34 14-13 26-13Z",
] as const;

/** Fallback glyph when an element has no emoji. */
export const FALLBACK_EMOJI = "✨";
