// Tiny stable hashes shared by the server (mock AI, Jev option rotation) and the client.

/** FNV-1a over UTF-16 code units: tiny, stable, good enough for picking words and tie-breaks. */
export function fnv1a(s: string, seed = 0x811c9dc5): number {
  let h = seed >>> 0;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h;
}
