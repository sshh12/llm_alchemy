// Deterministic offline AI used when AI_MODE=mock (local dev, e2e). No network, no cost.
// The same ingredients always produce the same element, and every answer passes the same
// validation as live output.
//
// Test hooks (mock only): an ingredient named "Mock Fizzle" makes the combine fizzle, and an
// element named "Mock Blocked" gets its art blocked, so e2e suites can exercise those paths.
// Custom sorts (scores from src/shared/mockSort.ts) have three, matched case-insensitively in the
// rank prompt or in any one group: "mock unavailable" throws AiUnavailable (503 ai_unavailable),
// "mock slow" answers after 2.5 s, and "mock partial" sends every third element to `retry`.
import { crc32, deflateSync } from "node:zlib";
import { SORT_RUBRIC, type SortSpec } from "../../src/shared/api.ts";
import { fnv1a } from "../../src/shared/hash.ts";
import { mockSortScores } from "../../src/shared/mockSort.ts";
import { nameKey } from "../../src/shared/names.ts";
import {
  AiUnavailable,
  Blocked,
  Fizzled,
  validateProposal,
  type ElementProposal,
  type GeneratedImage,
} from "./common.ts";
import type { ScoreItem, ScoreOpts, ScoreOutcome } from "./jev.ts";

/** Classic results for the starters so local play feels familiar. Keys: sorted name keys joined by "+". */
const CLASSICS: Record<string, [string, string, string]> = {
  "air+earth": ["Dust", "💨", "Fine dry particles carried on the wind."],
  "air+fire": ["Energy", "⚡", "Raw power crackling through the air."],
  "air+water": ["Mist", "🌫️", "A soft veil of tiny water droplets."],
  "earth+fire": ["Lava", "🌋", "Molten rock glowing red-hot."],
  "earth+water": ["Mud", "🟤", "Wet, squelchy earth."],
  "fire+water": ["Steam", "♨️", "Hot water vapor rising in clouds."],
  "air+air": ["Wind", "🌬️", "Air on the move."],
  "earth+earth": ["Mountain", "⛰️", "A towering mass of rock and soil."],
  "fire+fire": ["Inferno", "🔥", "A roaring, unstoppable blaze."],
  "water+water": ["Lake", "🏞️", "A calm body of fresh water."],
  "time+time": ["Eternity", "♾️", "Time without beginning or end."],
  "earth+time": ["Fossil", "🦴", "Ancient life preserved in stone."],
  "fire+time": ["Ash", "🩶", "What remains after the flames are gone."],
  "time+water": ["Ice", "🧊", "Water frozen still."],
  "air+time": ["Weather", "🌦️", "The ever-changing mood of the sky."],
};

const ADJECTIVES = [
  "Glowing", "Ancient", "Molten", "Frozen", "Hidden", "Crystal", "Thunder", "Silent", "Golden", "Shadow",
  "Wild", "Floating", "Clockwork", "Lunar", "Solar", "Misty", "Iron", "Velvet", "Electric", "Spiral",
  "Wandering", "Emerald", "Copper", "Burning", "Gentle", "Stormy", "Hollow", "Radiant", "Sunken", "Living",
];
const NOUNS = [
  "Golem", "Garden", "Comet", "Lantern", "Forge", "Spirit", "Island", "Engine", "Beacon", "Serpent",
  "Orchard", "Tower", "Meteor", "Prism", "Reef", "Dragon", "Canyon", "Potion", "Harbor", "Phoenix",
  "Glacier", "Volcano", "Compass", "Nebula", "Wolf", "Cathedral", "Geyser", "Owl", "Labyrinth", "Tide",
];
const EMOJIS = ["✨", "🔮", "🌀", "🪨", "🌋", "🌊", "🌪️", "🌙", "☄️", "🌿", "🧪", "🐉", "🗝️", "🏔️", "🦉", "⚙️"];

export function mockCombine(ingredientNames: string[]): ElementProposal {
  const sorted = [...ingredientNames].sort((a, b) => (nameKey(a) < nameKey(b) ? -1 : 1));
  const keys = sorted.map(nameKey);
  if (keys.includes("mock fizzle")) throw new Fizzled("mock fizzle hook");
  const classic = CLASSICS[keys.join("+")];
  if (classic) {
    const [name, emoji, description] = classic;
    const check = validateProposal({ name, emoji, description, notable: false }, ingredientNames);
    if (check.ok) return check.proposal;
  }
  const seed = keys.join("+");
  for (let salt = 0; ; salt++) {
    const h = fnv1a(`${seed}#${salt}`);
    const name = `${ADJECTIVES[h % ADJECTIVES.length]} ${NOUNS[(h >>> 8) % NOUNS.length]}`;
    const emoji = EMOJIS[(h >>> 16) % EMOJIS.length];
    const description = `Born from ${sorted.join(" and ")}.`;
    const check = validateProposal({ name, emoji, description, notable: false }, ingredientNames);
    if (check.ok) return check.proposal;
  }
}

// ---------------------------------------------------------------- PNG art

const PNG_SIZE = 128;

function pngChunk(type: string, data: Buffer): Buffer {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(data.length, 0);
  head.write(type, 4, "ascii");
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), data])), 0);
  return Buffer.concat([head, data, crc]);
}

function hslToRgb(h: number, s: number, l: number): [number, number, number] {
  const k = (n: number) => (n + h / 30) % 12;
  const a = s * Math.min(l, 1 - l);
  const f = (n: number) => l - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)));
  return [Math.round(f(0) * 255), Math.round(f(8) * 255), Math.round(f(4) * 255)];
}

/** A soft-edged colored disc with a dark outline on a transparent background, hue from the name. */
export function mockPng(name: string): Uint8Array {
  const hue = fnv1a(nameKey(name)) % 360;
  const fill = hslToRgb(hue, 0.65, 0.58);
  const rim = hslToRgb(hue, 0.6, 0.28);
  const c = (PNG_SIZE - 1) / 2;
  const radius = PNG_SIZE * 0.4;
  const rowBytes = 1 + PNG_SIZE * 4;
  const raw = Buffer.alloc(rowBytes * PNG_SIZE); // filter byte 0 (None) per row
  for (let y = 0; y < PNG_SIZE; y++) {
    for (let x = 0; x < PNG_SIZE; x++) {
      const d = Math.hypot(x - c, y - c);
      const alpha = Math.max(0, Math.min(1, radius - d + 0.5)); // 1px anti-aliased edge
      if (alpha === 0) continue;
      const [r, g, b] = d > radius - 4 ? rim : fill;
      const o = y * rowBytes + 1 + x * 4;
      raw[o] = r;
      raw[o + 1] = g;
      raw[o + 2] = b;
      raw[o + 3] = Math.round(alpha * 255);
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(PNG_SIZE, 0);
  ihdr.writeUInt32BE(PNG_SIZE, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // color type RGBA
  const png = Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk("IHDR", ihdr),
    pngChunk("IDAT", deflateSync(raw)),
    pngChunk("IEND", Buffer.alloc(0)),
  ]);
  return new Uint8Array(png);
}

export function mockImage(name: string): GeneratedImage {
  if (nameKey(name) === "mock blocked") throw new Blocked();
  return { bytes: mockPng(name), ext: "png", contentType: "image/png" };
}

// ---------------------------------------------------------------- custom sort

export const MOCK_SORT_ENGINE = `mock/${SORT_RUBRIC}`;
const MOCK_SLOW_MS = 2_500;

/**
 * Offline stand-in for jevScore. It ignores the deadline on purpose ("mock slow" must be slow);
 * callers that need a hard cap (the combine piggyback) enforce it themselves.
 */
export async function mockScore(spec: SortSpec, items: readonly ScoreItem[], _opts: ScoreOpts): Promise<ScoreOutcome> {
  // "|" so a hook phrase must sit inside one group, not straddle two.
  const text = (spec.kind === "rank" ? spec.prompt : spec.groups.join("|")).toLowerCase();
  if (text.includes("mock unavailable")) throw new AiUnavailable("mock unavailable hook");
  if (text.includes("mock slow")) await new Promise((r) => setTimeout(r, MOCK_SLOW_MS));
  const partial = text.includes("mock partial");
  const scores = mockSortScores(spec, items);
  const outcome: ScoreOutcome = { engine: MOCK_SORT_ENGINE, scored: new Map(), retry: [], tokens: 0 };
  items.forEach((it, i) => {
    if (partial && i % 3 === 2) outcome.retry.push(it.id);
    else outcome.scored.set(it.id, scores[i]!);
  });
  return outcome;
}
