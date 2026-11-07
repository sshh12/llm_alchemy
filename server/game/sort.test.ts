import type { Context } from "@netlify/functions";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { SORT_MAX_ELEMENTS, type SortResponse, type SortScore, type SortSpec } from "../../src/shared/api.ts";
import type { ScoreItem, ScoreOpts, ScoreOutcome } from "../ai/index.ts";
import type { PlayerRow } from "../session.ts";

const m = vi.hoisted(() => ({
  playerForClaims: vi.fn(),
  enforce: vi.fn(),
  hit: vi.fn(),
  scoreElements: vi.fn(),
  q: vi.fn(),
  calls: [] as string[],
}));

vi.mock("../session.ts", async (orig) => ({ ...(await orig<typeof import("../session.ts")>()), playerForClaims: m.playerForClaims }));
vi.mock("../ratelimit.ts", async (orig) => ({ ...(await orig<typeof import("../ratelimit.ts")>()), enforce: m.enforce, hit: m.hit }));
vi.mock("../ai/index.ts", async (orig) => ({ ...(await orig<typeof import("../ai/index.ts")>()), scoreElements: m.scoreElements }));
vi.mock("../db.ts", async (orig) => ({ ...(await orig<typeof import("../db.ts")>()), t: (name: string) => `test.${name}`, q: m.q }));

const { sortLibrary } = await import("./sort.ts");
const { encodeSession } = await import("../session.ts");
const { AiUnavailable, sortEngineId } = await import("../ai/index.ts");
const { errors } = await import("../http.ts");
const { BUDGETS, LIMITS } = await import("../ratelimit.ts");

const PLAYER: PlayerRow = {
  id: "42",
  public_id: "pub-42",
  legacy_user_id: null,
  created_at: new Date("2026-11-01T00:00:00Z"),
  session_version: 1,
  legacy_import_count: 0,
};
const rank: SortSpec = { kind: "rank", prompt: "spookiest" };
const groups: SortSpec = { kind: "groups", groups: ["Animals", "Food", "Weather"] };
const id = (i: number) => String(1_083_333_177_628_557_313n + BigInt(i));
const rows = (n: number) => Array.from({ length: n }, (_, i) => ({ id: id(i), name: `Element ${i}` }));

function request(body: unknown, { cookie = true, raw }: { cookie?: boolean; raw?: string } = {}) {
  const headers: Record<string, string> = { "content-type": "application/json", "x-ia-client": "1" };
  if (cookie) headers.cookie = `ia_session=${encodeSession("42", 1)}`;
  return sortLibrary(
    new Request("https://alchemy.test/api/sort", { method: "POST", headers, body: raw ?? JSON.stringify(body) }),
    { ip: "203.0.113.7" } as Context,
  );
}
const ok = async (body: unknown) => (await (await request(body)).json()) as SortResponse;
const scoredAs = (fn: (it: ScoreItem, i: number) => SortScore | null) =>
  m.scoreElements.mockImplementation(async (_spec: SortSpec, items: ScoreItem[]): Promise<ScoreOutcome> => {
    const out: ScoreOutcome = { engine: "test/rx", scored: new Map(), retry: [], tokens: 0 };
    items.forEach((it, i) => {
      const sc = fn(it, i);
      if (sc) out.scored.set(it.id, sc);
      else out.retry.push(it.id);
    });
    return out;
  });

beforeAll(() => {
  process.env.SESSION_SECRET = "test-secret-".padEnd(48, "x");
});

beforeEach(() => {
  vi.clearAllMocks();
  m.calls.length = 0;
  m.playerForClaims.mockResolvedValue(PLAYER);
  m.enforce.mockImplementation(async (hits: { limit: { name: string } }[]) => {
    m.calls.push(`enforce:${hits.map((h) => h.limit.name).join(",")}`);
  });
  m.hit.mockImplementation(async (hits: { limit: { name: string } }[]) => {
    m.calls.push(`hit:${hits.map((h) => h.limit.name).join(",")}`);
    return { ok: true };
  });
  m.q.mockImplementation(async (sql: string) => {
    m.calls.push("q");
    return /ANY\(\$2::INT8\[\]\)/.test(sql) ? rows(2) : rows(3);
  });
  scoredAs((_, i) => ({ s: 100 * (i + 1) }));
});

describe("POST /api/sort input", () => {
  it("needs a valid, unrevoked session", async () => {
    await expect(request({ spec: rank }, { cookie: false })).rejects.toMatchObject({ status: 401, code: "unauthorized" });
    m.playerForClaims.mockResolvedValue(null);
    await expect(request({ spec: rank })).rejects.toMatchObject({ status: 401, code: "unauthorized" });
    expect(m.q).not.toHaveBeenCalled(); // a revoked session never reads the library
    expect(m.hit).not.toHaveBeenCalled();
    expect(m.scoreElements).not.toHaveBeenCalled();
  });

  it.each([
    ["an empty prompt", { spec: { kind: "rank", prompt: "" } }],
    ["a whitespace-only prompt", { spec: { kind: "rank", prompt: " ​\t " } }],
    ["an 81-character prompt", { spec: { kind: "rank", prompt: "x".repeat(81) } }],
    ["a duplicate group", { spec: { kind: "groups", groups: ["Fire", " fire "] } }],
    ['a group named "Other"', { spec: { kind: "groups", groups: ["Fire", "OTHER"] } }],
    ["a single group", { spec: { kind: "groups", groups: ["Fire"] } }],
    ["9 groups", { spec: { kind: "groups", groups: Array.from({ length: 9 }, (_, i) => `G${i}`) } }],
    ["a blank group", { spec: { kind: "groups", groups: ["Fire", "Water", " "] } }],
    ["an unknown kind", { spec: { kind: "tiers", prompt: "x" } }],
    ["1,001 ids", { spec: rank, ids: Array.from({ length: 1_001 }, (_, i) => String(i + 1)) }],
    ["an empty id list", { spec: rank, ids: [] }],
    ["a bad id", { spec: rank, ids: ["12", "012"] }],
    ["a numeric id", { spec: rank, ids: [12] }],
  ])("rejects %s with 400", async (_label, body) => {
    await expect(request(body)).rejects.toMatchObject({ status: 400, code: "bad_request" });
    expect(m.q).not.toHaveBeenCalled();
    expect(m.hit).not.toHaveBeenCalled();
  });

  it("rejects bodies over 32 KB with 413", async () => {
    const ids = Array.from({ length: 1_000 }, (_, i) => id(i));
    const raw = JSON.stringify({ spec: rank, ids, pad: "x".repeat(32_768) });
    await expect(request(null, { raw })).rejects.toMatchObject({ status: 413 });
    // The largest legal request (1,000 19-digit ids plus a long spec) still fits.
    const big = { spec: { kind: "groups", groups: Array.from({ length: 8 }, (_, i) => `${i}`.padEnd(32, "g")) }, ids };
    expect(JSON.stringify(big).length).toBeLessThan(32_768);
    await expect(request(big)).resolves.toBeInstanceOf(Response);
  });

  it("accepts the limits exactly and cleans the text it scores", async () => {
    // 80 characters once the control character becomes a space and the edges are trimmed.
    await ok({ spec: { kind: "rank", prompt: `  ${"x".repeat(78)}\u0000y ` } });
    expect(m.scoreElements.mock.calls[0]![0]).toEqual({ kind: "rank", prompt: `${"x".repeat(78)} y` });
    await ok({ spec: { kind: "groups", groups: Array.from({ length: 8 }, (_, i) => `Group​ ${i}`) } });
    expect((m.scoreElements.mock.calls[1]![0] as { groups: string[] }).groups[0]).toBe("Group 0");
  });
});

describe("POST /api/sort scoring", () => {
  it("charges request limits first, then items + the Jev budget with cost = loaded × questions", async () => {
    scoredAs(() => ({ s: 500, g: 0, n: 900 }));
    // The request limits and the session answer a macrotask later, and record themselves only
    // when they settle: the library read must not start before both have.
    m.enforce.mockImplementation(async (hits: { limit: { name: string } }[]) => {
      await new Promise((r) => setTimeout(r, 5));
      m.calls.push(`enforce:${hits.map((h) => h.limit.name).join(",")}`);
    });
    m.playerForClaims.mockImplementation(async () => {
      await new Promise((r) => setTimeout(r, 1));
      m.calls.push(m.enforce.mock.calls.length ? "player" : "player before the limits started");
      return PLAYER;
    });
    const res = await ok({ spec: groups, ids: [id(0), id(1), id(0), id(99)] });
    expect(m.calls).toEqual([
      "player", // concurrent with the request limits, not behind them
      "enforce:sort.player,sort.player.hour,sort.ip.hour",
      "q",
      "hit:sort.items.player.hour,sort.items.player.day,sort.items.ip.hour,sort.items.ip.day,budget.jev",
    ]);
    expect(m.enforce).toHaveBeenCalledTimes(1);
    const hits = m.hit.mock.calls[0]![0] as { limit: { name: string }; subject: string; cost: number }[];
    expect(hits.every((h) => h.cost === 4)).toBe(true); // 2 owned elements × 2 questions (groups)
    expect(hits.at(-1)).toEqual({ limit: BUDGETS.jev, subject: "all", cost: 4 });
    expect(hits.slice(0, 2).map((h) => h.subject)).toEqual(["42", "42"]);
    expect(hits[2]!.subject).toBe(hits[3]!.subject);
    expect(hits[2]!.subject).not.toBe("203.0.113.7"); // a keyed hash, never the raw IP
    expect(hits.map((h) => h.limit)).toEqual([
      LIMITS.sortItemsPlayerHour,
      LIMITS.sortItemsPlayerDay,
      LIMITS.sortItemsIpHour,
      LIMITS.sortItemsIpDay,
      BUDGETS.jev,
    ]);
    // Unowned/inactive ids (id 99) are dropped silently: in neither ids nor retry.
    expect(res.ids).toEqual([id(0), id(1)]);
    expect(res.retry).toEqual([]);
  });

  it("loads only the player's owned, active elements through t()", async () => {
    await ok({ spec: rank, ids: [id(5), id(5), id(6)] });
    await ok({ spec: rank });
    const [[byIds, p1], [whole, p2]] = m.q.mock.calls as unknown as [[string, unknown[]], [string, unknown[]]];
    for (const sql of [byIds, whole]) {
      expect(sql).toContain("FROM test.discoveries d");
      expect(sql).toContain("JOIN test.elements e");
      expect(sql).toContain("e.status = 'active'");
      expect(sql).toContain("d.player_id = $1");
      expect(sql).not.toMatch(/alchemy\./);
    }
    expect(p1).toEqual(["42", [id(5), id(6)]]); // the session's player, deduped ids, as strings
    expect(whole).toMatch(/ORDER BY d\.discovered_at DESC, e\.id\s+LIMIT \$2/);
    expect(p2).toEqual(["42", SORT_MAX_ELEMENTS + 1]);
  });

  it("charges nothing and calls no model for an empty library", async () => {
    m.q.mockResolvedValue([]);
    const res = await ok({ spec: rank });
    expect(res).toEqual({ engine: sortEngineId(), ids: [], s: [], retry: [] });
    expect(m.hit).not.toHaveBeenCalled();
    expect(m.scoreElements).not.toHaveBeenCalled();
  });

  it("scores with the full-run options and returns aligned arrays", async () => {
    m.q.mockResolvedValue(rows(5));
    scoredAs((_, i) => (i === 2 ? null : { s: 900 - i, g: i % 3, n: 400 + i }));
    const res = await ok({ spec: groups });
    expect(m.scoreElements).toHaveBeenCalledWith(groups, rows(5), { deadlineMs: 20_000, retries: 1, split: true } satisfies ScoreOpts);
    expect(res).toEqual({
      engine: "test/rx",
      ids: [id(0), id(1), id(3), id(4)],
      s: [900, 899, 897, 896],
      g: [0, 1, 0, 1],
      n: [400, 401, 403, 404],
      retry: [id(2)],
    });
  });

  it("omits g and n for rank, and sends out-of-range or incomplete scores to retry", async () => {
    m.q.mockResolvedValue(rows(4));
    scoredAs((_, i) => [{ s: 1000.4 }, { s: Number.NaN }, { s: -3 }, { s: 500 }][i]!);
    const res = await ok({ spec: rank });
    expect(res).toEqual({ engine: "test/rx", ids: [id(0), id(2), id(3)], s: [1000, 0, 500], retry: [id(1)] });

    scoredAs(() => ({ s: 700 })); // a groups score without g/n is unusable
    const g = await ok({ spec: groups });
    expect(g).toMatchObject({ ids: [], s: [], g: [], n: [], retry: rows(4).map((r) => r.id) });
  });

  it("caps a whole-library run at SORT_MAX_ELEMENTS and says so", async () => {
    m.q.mockResolvedValue(rows(SORT_MAX_ELEMENTS + 1));
    scoredAs(() => ({ s: 1 }));
    const res = await ok({ spec: rank });
    expect(res.truncated).toBe(true);
    expect(res.ids).toHaveLength(SORT_MAX_ELEMENTS);
    expect(res.ids).not.toContain(id(SORT_MAX_ELEMENTS)); // the oldest is cut
    expect((m.hit.mock.calls[0]![0] as { cost: number }[])[0]!.cost).toBe(SORT_MAX_ELEMENTS);

    m.q.mockResolvedValue(rows(SORT_MAX_ELEMENTS));
    expect((await ok({ spec: rank })).truncated).toBeUndefined();
  });
});

describe("POST /api/sort failures", () => {
  it.each([
    ["the per-minute request limit", errors.rateLimited(60_000), { status: 429, code: "rate_limited", extra: { retryAfterMs: 60_000 } }],
    ["a budget", errors.budgetExhausted(3_600_000), { status: 503, code: "budget_exhausted", extra: { retryAfterMs: 3_600_000 } }],
  ])("stops before reading the library, charging items or scoring when %s rejects", async (_label, err, expected) => {
    m.enforce.mockRejectedValue(err);
    for (const body of [{ spec: rank }, { spec: groups, ids: [id(0), id(1)] }]) {
      await expect(request(body)).rejects.toMatchObject(expected);
    }
    expect(m.enforce).toHaveBeenCalledTimes(2);
    expect(m.q).not.toHaveBeenCalled(); // no whole-library scan for a rejected request
    expect(m.hit).not.toHaveBeenCalled();
    expect(m.scoreElements).not.toHaveBeenCalled();
  });

  it("answers 503 with the sort copy when the Jev budget is exhausted", async () => {
    m.hit.mockResolvedValue({ ok: false, limit: BUDGETS.jev, retryAfterMs: 3_600_000 });
    await expect(request({ spec: rank })).rejects.toMatchObject({
      status: 503,
      code: "budget_exhausted",
      message: "Custom sorting is resting until tomorrow. Your other sorts still work.",
      extra: { retryAfterMs: 3_600_000 },
    });
    expect(m.scoreElements).not.toHaveBeenCalled();
  });

  it("answers 429 when an item limit is hit", async () => {
    m.hit.mockResolvedValue({ ok: false, limit: LIMITS.sortItemsPlayerHour, retryAfterMs: 60_000 });
    await expect(request({ spec: rank })).rejects.toMatchObject({ status: 429, code: "rate_limited", extra: { retryAfterMs: 60_000 } });
    expect(m.scoreElements).not.toHaveBeenCalled();
  });

  it("maps AiUnavailable to 503 ai_unavailable and rethrows anything else", async () => {
    m.scoreElements.mockRejectedValue(new AiUnavailable("jev: provider rejected the request (401)"));
    await expect(request({ spec: rank })).rejects.toMatchObject({ status: 503, code: "ai_unavailable" });
    m.scoreElements.mockRejectedValue(new Error("boom"));
    await expect(request({ spec: rank })).rejects.toThrow("boom");
  });
});
