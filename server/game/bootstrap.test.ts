import type { Context } from "@netlify/functions";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { PlayerRow } from "../session.ts";

const m = vi.hoisted(() => ({
  sessionPlayer: vi.fn(),
  enforce: vi.fn(),
  verifyPow: vi.fn(),
  claimLegacyPlayer: vi.fn(),
  createPlayer: vi.fn(),
  importLegacy: vi.fn(),
  legacyPlayerExists: vi.fn(),
  calls: [] as string[],
}));

vi.mock("../session.ts", async (orig) => ({ ...(await orig<typeof import("../session.ts")>()), sessionPlayer: m.sessionPlayer }));
vi.mock("../ratelimit.ts", async (orig) => ({ ...(await orig<typeof import("../ratelimit.ts")>()), enforce: m.enforce }));
vi.mock("../pow.ts", async (orig) => ({
  ...(await orig<typeof import("../pow.ts")>()),
  checkPowSolution: () => "ok",
  verifyPow: m.verifyPow,
}));
vi.mock("./challenges.ts", () => ({
  resolveDay: () => "2026-11-07",
  dailyChallenge: async () => null,
  challengeStats: async () => ({ completed: 0, streak: { current: 0, best: 0 }, history: [] }),
}));
vi.mock("./players.ts", async (orig) => ({
  ...(await orig<typeof import("./players.ts")>()),
  claimLegacyPlayer: m.claimLegacyPlayer,
  createPlayer: m.createPlayer,
  importLegacy: m.importLegacy,
  legacyPlayerExists: m.legacyPlayerExists,
  ensureStarters: async () => {},
  library: async () => [],
  countFirsts: async () => 0,
  knownCount: async () => 100,
  recentElements: async () => [],
  touchPlayer: async () => {},
}));

const { bootstrap } = await import("./bootstrap.ts");

const LEGACY_ID = "alchemy:00000000-0000-4000-8000-0000000000aa";
const row = (id: string, legacyUserId: string | null = null): PlayerRow => ({
  id,
  public_id: `pub-${id}`,
  legacy_user_id: legacyUserId,
  created_at: new Date("2026-11-01T00:00:00Z"),
  session_version: 1,
  legacy_import_count: 0,
});
const legacyRow = row("10", LEGACY_ID);
const freshRow = row("20");

const call = (body: Record<string, unknown>, headers: Record<string, string> = {}) =>
  bootstrap(
    new Request("https://alchemy.test/api/bootstrap", {
      method: "POST",
      headers: { "content-type": "application/json", "x-ia-client": "1", ...headers },
      body: JSON.stringify({ clientDate: "2026-11-07", pow: { salt: "s", nonce: "n" }, ...body }),
    }),
    { ip: "203.0.113.7" } as Context,
  );
const legacyImportOf = async (res: Response) => ((await res.json()) as { legacyImport?: unknown }).legacyImport;

beforeAll(() => {
  process.env.SESSION_SECRET = "test-secret-".padEnd(48, "x");
});

beforeEach(() => {
  vi.clearAllMocks();
  m.calls.length = 0;
  m.sessionPlayer.mockResolvedValue(null);
  m.enforce.mockImplementation(async (hits: { limit: { name: string } }[]) => {
    m.calls.push(`enforce:${hits.map((h) => h.limit.name).join(",")}`);
  });
  m.verifyPow.mockImplementation(async () => {
    m.calls.push("verifyPow");
    return "ok";
  });
  m.createPlayer.mockResolvedValue(freshRow);
  m.importLegacy.mockResolvedValue({ imported: 2, skipped: 0 });
  m.legacyPlayerExists.mockResolvedValue(false);
});

describe("legacy import gate", () => {
  it("writes nothing for a fresh player without a legacy user id", async () => {
    const res = await call({ legacy: { userId: null, elementIds: ["1", "2", "2", "3"] } });
    expect(m.createPlayer).toHaveBeenCalled();
    expect(m.importLegacy).not.toHaveBeenCalled();
    // Still settled, so the client stops resending its inventory.
    expect(await legacyImportOf(res)).toEqual({ imported: 0, skipped: 3, adopted: false, claimed: false });
  });

  it("writes nothing for a malformed or unknown legacy user id", async () => {
    await call({ legacy: { userId: "alchemy:not-a-uuid", elementIds: ["1"] } });
    m.claimLegacyPlayer.mockResolvedValue({ claimed: false });
    const res = await call({ legacy: { userId: LEGACY_ID, elementIds: ["1"] } });
    expect(m.importLegacy).not.toHaveBeenCalled();
    expect(m.legacyPlayerExists).not.toHaveBeenCalled(); // the claim already found out
    expect(await legacyImportOf(res)).toMatchObject({ imported: 0, skipped: 1 });
  });

  it("imports into an adopted legacy player", async () => {
    m.claimLegacyPlayer.mockResolvedValue({ player: legacyRow, claimed: false });
    const res = await call({ legacy: { userId: LEGACY_ID, elementIds: ["1", "2"] } });
    expect(m.importLegacy).toHaveBeenCalledWith("10", ["1", "2"]);
    expect(await legacyImportOf(res)).toEqual({ imported: 2, skipped: 0, adopted: true, claimed: false });
  });

  it("copies the inventory when the legacy player is bound to another browser", async () => {
    m.claimLegacyPlayer.mockResolvedValue({ claimed: true });
    const res = await call({ legacy: { userId: LEGACY_ID, elementIds: ["1", "2"] } });
    expect(m.importLegacy).toHaveBeenCalledWith("20", ["1", "2"]);
    expect(await legacyImportOf(res)).toEqual({ imported: 2, skipped: 0, adopted: false, claimed: true });
  });

  it("checks that the legacy player exists for a session player", async () => {
    m.sessionPlayer.mockResolvedValue(legacyRow);
    await call({ legacy: { userId: LEGACY_ID, elementIds: ["1"] } });
    expect(m.legacyPlayerExists).not.toHaveBeenCalled();
    expect(m.importLegacy).toHaveBeenCalledTimes(1);

    m.sessionPlayer.mockResolvedValue(freshRow);
    await call({ legacy: { userId: LEGACY_ID, elementIds: ["1"] } });
    expect(m.importLegacy).toHaveBeenCalledTimes(1);
    m.legacyPlayerExists.mockResolvedValue(true);
    await call({ legacy: { userId: LEGACY_ID, elementIds: ["1"] } });
    expect(m.importLegacy).toHaveBeenCalledTimes(2);
  });
});

describe("player creation", () => {
  it("charges the player budget only after the per-IP limits and the PoW salt pass", async () => {
    await call({});
    expect(m.calls).toEqual(["enforce:bootstrap.ip", "enforce:create.ip,create.ip.day", "verifyPow", "enforce:budget.players"]);
  });

  it("never charges the player budget for a replayed salt", async () => {
    m.verifyPow.mockResolvedValue("replayed");
    await expect(call({})).rejects.toMatchObject({ status: 401, code: "pow_required" });
    expect(m.calls.some((c) => c.includes("budget."))).toBe(false);
    expect(m.createPlayer).not.toHaveBeenCalled();
  });
});

describe("first-touch acquisition", () => {
  const acq = { ref: "www.google.com", path: "/how-to-play", src: "hn", med: null, cmp: null };

  it("stores it on the player this bootstrap creates", async () => {
    const res = await call({ acq });
    expect(res.status).toBe(200);
    expect(m.createPlayer).toHaveBeenCalledWith(expect.any(String), { acq, uaClass: "unknown" });
  });

  it("drops a malformed or oversized value instead of failing the bootstrap", async () => {
    for (const bad of [{ ref: 1, path: "/" }, { ref: "x", path: "/".repeat(500) }, "nope", null]) {
      const res = await call({ acq: bad });
      expect(res.status).toBe(200);
      expect(m.createPlayer).toHaveBeenLastCalledWith(expect.any(String), { acq: undefined, uaClass: "unknown" });
    }
  });

  it("stores the creating browser's coarse platform, never the raw User-Agent", async () => {
    await call({}, { "user-agent": "Mozilla/5.0 (X11; CrOS x86_64 14541.0.0) AppleWebKit/537.36 Chrome/120.0 Safari/537.36" });
    expect(m.createPlayer).toHaveBeenLastCalledWith(expect.any(String), { acq: undefined, uaClass: "chromeos" });
    await call({}, { "user-agent": "Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)" });
    expect(m.createPlayer).toHaveBeenLastCalledWith(expect.any(String), { acq: undefined, uaClass: "bot" });
  });

  it("is ignored for an existing player", async () => {
    m.sessionPlayer.mockResolvedValue(freshRow);
    const res = await call({ acq });
    expect(res.status).toBe(200);
    expect(m.createPlayer).not.toHaveBeenCalled();
  });
});
