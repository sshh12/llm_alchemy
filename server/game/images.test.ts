import type { Context } from "@netlify/functions";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { ImageResponse } from "../../src/shared/api.ts";
import { BUDGETS, LIMITS, type Hit, type Limit } from "../ratelimit.ts";
import { BACKLOG_HINT_MAX_MS, FRESH_MS, deferReason, requestImage } from "./images.ts";

const m = vi.hoisted(() => ({
  db: vi.fn(),
  hit: vi.fn(),
  bumpStat: vi.fn(),
  getChallenge: vi.fn(),
  paintElement: vi.fn(),
  putArt: vi.fn(),
}));

vi.mock("../db.ts", async (orig) => ({
  ...(await orig<typeof import("../db.ts")>()),
  q: (text: string, params: unknown[] = []) => m.db(text, params),
  q1: async (text: string, params: unknown[] = []) => ((await m.db(text, params)) as unknown[])[0],
}));
vi.mock("../ratelimit.ts", async (orig) => ({ ...(await orig<typeof import("../ratelimit.ts")>()), hit: m.hit, bumpStat: m.bumpStat }));
vi.mock("../session.ts", async (orig) => ({
  ...(await orig<typeof import("../session.ts")>()),
  requirePlayer: async () => ({ id: "77", public_id: "pub-77", legacy_user_id: null, created_at: new Date(), session_version: 1, legacy_import_count: 0 }),
}));
vi.mock("../ai/index.ts", async (orig) => ({ ...(await orig<typeof import("../ai/index.ts")>()), paintElement: m.paintElement }));
vi.mock("../blobs.ts", async (orig) => ({ ...(await orig<typeof import("../blobs.ts")>()), putArt: m.putArt }));
vi.mock("./challenges.ts", async (orig) => ({ ...(await orig<typeof import("./challenges.ts")>()), getChallenge: m.getChallenge }));

const ELEMENT = "1083333177628557313";
let discoveredAt: Date | null;
let outcomes: unknown[][];

function row() {
  return {
    id: ELEMENT,
    name: "Rain Forest",
    description: "A wet, green forest.",
    art_hint: null,
    notable: false,
    status: "active",
    image_status: "none",
    image_key: null,
    image_attempts: 0,
    leased: false,
    discovered_at: discoveredAt,
  };
}

async function ask(): Promise<ImageResponse> {
  const res = await requestImage(
    new Request("https://alchemy.test/api/image", {
      method: "POST",
      headers: { "content-type": "application/json", "x-ia-client": "1" },
      body: JSON.stringify({ id: ELEMENT }),
    }),
    { ip: "203.0.113.7" } as Context,
  );
  expect(res.status).toBe(200);
  return (await res.json()) as ImageResponse;
}

const hitLimits = () => (m.hit.mock.calls[0]![0] as Hit[]).map((h) => h.limit);
const names = (limits: Limit[]) => limits.map((l) => l.name);

beforeAll(() => {
  process.env.SESSION_SECRET = "test-secret-".padEnd(48, "x");
});

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(console, "warn").mockImplementation(() => {});
  discoveredAt = new Date(Date.now() - 60_000);
  outcomes = [];
  m.hit.mockResolvedValue({ ok: true });
  m.bumpStat.mockResolvedValue(undefined);
  m.getChallenge.mockResolvedValue(null);
  m.paintElement.mockResolvedValue({ bytes: new Uint8Array([1]), ext: "webp", contentType: "image/webp" });
  m.putArt.mockResolvedValue(undefined);
  m.db.mockImplementation(async (sql: string, params: unknown[]) => {
    if (/SELECT e\.id, e\.name/.test(sql)) return [row()];
    if (/SET image_status = 'pending'/.test(sql)) return [{ image_attempts: 1 }];
    if (/image_attempts = image_attempts - 1/.test(sql)) return [];
    if (/SET image_status = \$2, image_key/.test(sql)) {
      outcomes.push([sql, params]);
      return [];
    }
    throw new Error(`unexpected query: ${sql}`);
  });
});

describe("POST /api/image lanes", () => {
  it("paints a just-discovered element from the fresh lane and stamps image_ready_at", async () => {
    expect(await ask()).toMatchObject({ state: "ready", img: expect.stringContaining(`/img/${ELEMENT}/`) });
    const limits = hitLimits();
    expect(names(limits)).toEqual(["image.player.hour", "image.player.day", "image.ip.hour", "image.ip.day", "budget.image", "budget.image.month"]);
    expect(limits.slice(4).every((l) => typeof l.allowance === "function")).toBe(true);
    expect(m.bumpStat).toHaveBeenCalledWith("art:fresh:started");
    expect(outcomes).toHaveLength(1);
    expect(outcomes[0]![0]).toMatch(/image_ready_at = CASE WHEN \$2 = 'ready' THEN now\(\)/);
    expect(m.getChallenge).not.toHaveBeenCalled(); // a fresh discovery needs no challenge lookup
  });

  it("charges the per-player backlog cap for older library tiles", async () => {
    discoveredAt = new Date(Date.now() - FRESH_MS - 1_000);
    await ask();
    expect(names(hitLimits())).toContain(LIMITS.imageBacklogPlayerDay.name);
    expect(m.bumpStat).toHaveBeenCalledWith("art:backlog:started");
  });

  it("treats today's challenge targets as fresh, owned or not", async () => {
    discoveredAt = null;
    m.getChallenge.mockResolvedValue({ day: "2026-11-23", easy_id: ELEMENT, hard_id: "2", expert_id: "3" });
    expect(await ask()).toMatchObject({ state: "ready" });
    expect(names(hitLimits())).not.toContain(LIMITS.imageBacklogPlayerDay.name);
    expect(m.bumpStat).toHaveBeenCalledWith("art:fresh:started");
  });

  it("refuses other players' elements", async () => {
    discoveredAt = null;
    await expect(ask()).rejects.toMatchObject({ status: 403, code: "forbidden" });
    expect(m.hit).not.toHaveBeenCalled();
  });

  it("defers over-pace art with the lane and reason, and gives the lease back", async () => {
    discoveredAt = new Date(Date.now() - 2 * FRESH_MS);
    m.hit.mockResolvedValue({ ok: false, limit: BUDGETS.image, retryAfterMs: 120_000, paced: true });
    expect(await ask()).toEqual({ state: "deferred", retryAfterMs: 120_000, limited: true, lane: "backlog", reason: "pace" });
    expect(m.db.mock.calls.some(([sql]) => /image_attempts = image_attempts - 1/.test(sql as string))).toBe(true);
    expect(m.bumpStat).toHaveBeenCalledWith("art:backlog:deferred_pace");
    expect(m.paintElement).not.toHaveBeenCalled();
  });

  it("caps a backlog denial's retry hint at 15 minutes, not a fresh one's", async () => {
    const endOfDay = 9 * 3_600_000;
    m.hit.mockResolvedValue({ ok: false, limit: LIMITS.imageBacklogPlayerDay, retryAfterMs: endOfDay });
    discoveredAt = new Date(Date.now() - 2 * FRESH_MS);
    expect(await ask()).toEqual({ state: "deferred", retryAfterMs: BACKLOG_HINT_MAX_MS, limited: true, lane: "backlog", reason: "player" });
    discoveredAt = new Date(Date.now() - 60_000);
    expect(await ask()).toMatchObject({ retryAfterMs: endOfDay, lane: "fresh" });
  });

  it("marks a retryable failed generation, so the client does not take the retry for a poll", async () => {
    m.paintElement.mockRejectedValue(new Error("provider 500"));
    expect(await ask()).toEqual({ state: "pending", retryAfterMs: 5_000, failed: true });
    expect(outcomes[0]![1]).toEqual([ELEMENT, "failed", null]);
  });

  it("still stores the art when migration 0008 is missing", async () => {
    m.db.mockImplementation(async (sql: string) => {
      if (/SELECT e\.id, e\.name/.test(sql)) return [row()];
      if (/SET image_status = 'pending'/.test(sql)) return [{ image_attempts: 1 }];
      if (/image_ready_at/.test(sql)) throw Object.assign(new Error('column "image_ready_at" does not exist'), { code: "42703" });
      if (/SET image_status = \$2, image_key/.test(sql)) {
        outcomes.push([sql]);
        return [];
      }
      throw new Error(`unexpected query: ${sql}`);
    });
    expect(await ask()).toMatchObject({ state: "ready" });
    expect(outcomes).toHaveLength(1);
  });
});

describe("deferReason", () => {
  it("names the limit family", () => {
    const deny = (limit: Limit, paced?: true) => ({ ok: false as const, limit, retryAfterMs: 1, ...(paced ? { paced } : {}) });
    expect(deferReason(deny(BUDGETS.image, true))).toBe("pace");
    expect(deferReason(deny(BUDGETS.imageMonth))).toBe("budget");
    expect(deferReason(deny(LIMITS.imagePlayerHour))).toBe("player");
    expect(deferReason(deny(LIMITS.imageBacklogPlayerDay))).toBe("player");
    expect(deferReason(deny(LIMITS.imageIpDay))).toBe("ip");
  });
});
