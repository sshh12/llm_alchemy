import type { Context } from "@netlify/functions";
import type pg from "pg";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { CombineResponse, SortSpec } from "../../src/shared/api.ts";
import { AiUnavailable, Fizzled, type ElementProposal, type ScoreOutcome } from "../ai/index.ts";
import { BUDGETS } from "../ratelimit.ts";
import { encodeSession, type PlayerRow } from "../session.ts";
import { CombineSchema, combineElements, resolveElement, scoreDiscovery } from "./combine.ts";

const m = vi.hoisted(() => ({
  hit: vi.fn(),
  scoreElements: vi.fn(),
  playerForClaims: vi.fn(),
  completeTiers: vi.fn(),
  /** Pool queries (no client passed); queries on an explicit client go to the real q/q1. */
  db: vi.fn(),
}));

vi.mock("../ratelimit.ts", async (orig) => ({
  ...(await orig<typeof import("../ratelimit.ts")>()),
  enforce: async () => {},
  hit: m.hit,
}));
vi.mock("../ai/index.ts", async (orig) => ({ ...(await orig<typeof import("../ai/index.ts")>()), scoreElements: m.scoreElements }));
vi.mock("../session.ts", async (orig) => ({ ...(await orig<typeof import("../session.ts")>()), playerForClaims: m.playerForClaims }));
vi.mock("./challenges.ts", async (orig) => ({ ...(await orig<typeof import("./challenges.ts")>()), completeTiers: m.completeTiers }));
vi.mock("../db.ts", async (orig) => {
  const real = await orig<typeof import("../db.ts")>();
  return {
    ...real,
    q: (text: string, params: unknown[] = [], client?: pg.PoolClient) => (client ? real.q(text, params, client) : m.db(text, params)),
    q1: async (text: string, params: unknown[] = [], client?: pg.PoolClient) =>
      client ? real.q1(text, params, client) : ((await m.db(text, params)) as unknown[])[0],
  };
});

const proposal: ElementProposal = {
  name: "Rain Forest",
  key: "rain forest",
  foldKey: "rain forest",
  emoji: "🌳",
  description: "A wet, green forest.",
  notable: false,
  artHint: null,
};

const row = (over: Record<string, unknown> = {}) => ({
  id: "1083333177628557313",
  name: "Rain Forest",
  emoji: "🌳",
  description: "A wet, green forest.",
  notable: false,
  depth: null,
  steps: null,
  is_starter: false,
  status: "quarantined",
  image_status: "none",
  image_key: null,
  discovered_by: "77",
  ...over,
});

/** A fake client: each handler answers the first query whose SQL matches its pattern. */
function fakeClient(handlers: [RegExp, (params: unknown[]) => unknown[] | Error][]) {
  const seen: string[] = [];
  const client = {
    query: async (text: string, params: unknown[] = []) => {
      seen.push(text);
      const h = handlers.find(([re]) => re.test(text));
      if (!h) throw new Error(`unexpected query: ${text}`);
      const out = h[1](params);
      if (out instanceof Error) throw out;
      return { rows: out };
    },
  };
  return { client: client as unknown as pg.PoolClient, seen };
}

const byKey = /WHERE e\.name_key = \$1/;
const revive = /SET status = 'active', quarantine_reason = NULL/;
const lower = /SET depth = CASE/;

describe("resolveElement and purged names", () => {
  it("reactivates an element quarantined as 'orphaned' and lowers its depth/steps", async () => {
    const { client, seen } = fakeClient([
      [byKey, () => [row()]],
      [revive, (p) => (p[0] === "1083333177628557313" ? [row({ status: "active" })] : [])],
      [lower, () => [{ depth: 3, steps: 4 }]],
    ]);
    const out = await resolveElement(client, proposal, { depth: 3, steps: 4 }, "99");
    expect(out.inserted).toBe(false);
    expect(out.element).toMatchObject({ id: "1083333177628557313", status: "active", depth: 3, steps: 4, discovered_by: "77" });
    expect(seen.some((q) => revive.test(q) && /quarantine_reason = 'orphaned'/.test(q))).toBe(true);
  });

  it("fizzles for any other quarantined name (legacy filter, review purge)", async () => {
    const { client, seen } = fakeClient([
      [byKey, () => [row()]],
      [revive, () => []], // the UPDATE matches only reason 'orphaned'
    ]);
    await expect(resolveElement(client, proposal, { depth: 1, steps: 1 }, "99")).rejects.toBeInstanceOf(Fizzled);
    expect(seen.some((q) => lower.test(q) || /INSERT/.test(q))).toBe(false);
  });

  it("fizzles (instead of failing) before migration 0004 adds quarantine_reason", async () => {
    const { client } = fakeClient([
      [byKey, () => [row()]],
      [revive, () => Object.assign(new Error('column "quarantine_reason" does not exist'), { code: "42703" })],
    ]);
    await expect(resolveElement(client, proposal, { depth: 1, steps: 1 }, "99")).rejects.toBeInstanceOf(Fizzled);
  });

  it("uses an active element as before without touching quarantine columns", async () => {
    const { client, seen } = fakeClient([
      [byKey, () => [row({ status: "active", depth: 2, steps: 2 })]],
      [lower, () => []],
    ]);
    const out = await resolveElement(client, proposal, { depth: 3, steps: 4 }, "99");
    expect(out.element).toMatchObject({ status: "active", depth: 2, steps: 2 });
    expect(seen.some((q) => revive.test(q))).toBe(false);
  });
});

// ---------------------------------------------------------------- custom-sort piggyback

const rankSpec: SortSpec = { kind: "rank", prompt: "spookiest" };
const groupSpec: SortSpec = { kind: "groups", groups: ["Animals", "Weather"] };
const MUD = { id: "1083333177628557399", name: "Mud" };
const outcome = (s: number): ScoreOutcome => ({ engine: "test/rx", scored: new Map([[MUD.id, { s }]]), retry: [], tokens: 1 });
const never = () => new Promise<never>(() => {});
/** A budget hit that answers `ok` after `ms` (fake timers). */
const budgetAfter = (ms: number, ok = true) => () =>
  new Promise((resolve) => setTimeout(() => resolve(ok ? { ok } : { ok, limit: BUDGETS.jev, retryAfterMs: 1_000 }), ms));

describe("scoreDiscovery", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(console, "warn").mockImplementation(() => {});
    m.hit.mockResolvedValue({ ok: true });
    m.scoreElements.mockResolvedValue(outcome(812));
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("returns the element's score, charging only the Jev budget", async () => {
    vi.useFakeTimers(); // a frozen clock: the whole cap is left for Jev
    expect(await scoreDiscovery(groupSpec, MUD)).toEqual({ s: 812 });
    expect(m.scoreElements).toHaveBeenCalledWith(groupSpec, [MUD], { deadlineMs: 800, retries: 0, split: false });
    expect(m.hit).toHaveBeenCalledWith([{ limit: BUDGETS.jev, subject: "all", cost: 2 }]);
    await scoreDiscovery(rankSpec, MUD);
    expect(m.hit).toHaveBeenLastCalledWith([{ limit: BUDGETS.jev, subject: "all", cost: 1 }]);
  });

  it("returns undefined without calling Jev when the budget is exhausted", async () => {
    m.hit.mockResolvedValue({ ok: false, limit: BUDGETS.jev, retryAfterMs: 1_000 });
    expect(await scoreDiscovery(rankSpec, MUD)).toBeUndefined();
    expect(m.hit).toHaveBeenCalledTimes(1);
    expect(m.scoreElements).not.toHaveBeenCalled(); // JEV_DAILY_CAP bounds piggyback spend too
  });

  it("returns undefined when scoring or the counter write throws, and never calls Jev without a counted budget", async () => {
    m.scoreElements.mockRejectedValue(new AiUnavailable("jev: nothing could be scored"));
    expect(await scoreDiscovery(rankSpec, MUD)).toBeUndefined();
    m.scoreElements.mockReset();
    m.scoreElements.mockResolvedValue(outcome(1));
    m.hit.mockRejectedValue(new Error("connection terminated"));
    expect(await scoreDiscovery(rankSpec, MUD)).toBeUndefined();
    m.hit.mockRejectedValue(undefined); // not even an Error
    expect(await scoreDiscovery(rankSpec, MUD)).toBeUndefined();
    expect(m.scoreElements).not.toHaveBeenCalled();
  });

  it("waits for the budget before starting Jev, and gives Jev only the time left in the cap", async () => {
    vi.useFakeTimers();
    m.hit.mockImplementation(budgetAfter(300));
    let result: unknown = "pending";
    void scoreDiscovery(groupSpec, MUD).then((r) => (result = r));
    await vi.advanceTimersByTimeAsync(299);
    expect(m.scoreElements).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(result).toEqual({ s: 812 });
    expect(m.scoreElements).toHaveBeenCalledWith(groupSpec, [MUD], { deadlineMs: 500, retries: 0, split: false });
  });

  it("never starts Jev when the budget answers after the cap", async () => {
    vi.useFakeTimers();
    m.hit.mockImplementation(budgetAfter(900));
    let result: unknown = "pending";
    void scoreDiscovery(rankSpec, MUD).then((r) => (result = r));
    await vi.advanceTimersByTimeAsync(800);
    expect(result).toBeUndefined();
    await vi.advanceTimersByTimeAsync(500); // the budget write lands late, with ok: true
    expect(m.scoreElements).not.toHaveBeenCalled();
  });

  it("returns undefined when the element was sent to retry", async () => {
    m.scoreElements.mockResolvedValue({ ...outcome(1), scored: new Map(), retry: [MUD.id] });
    expect(await scoreDiscovery(rankSpec, MUD)).toBeUndefined();
  });

  it("gives up after 800 ms even if the scorer or the budget write never answers", async () => {
    vi.useFakeTimers();
    for (const stuck of ["score", "hit"] as const) {
      if (stuck === "score") m.scoreElements.mockImplementation(never);
      else {
        m.scoreElements.mockResolvedValue(outcome(5));
        m.hit.mockImplementation(never);
      }
      let result: unknown = "pending";
      void scoreDiscovery(rankSpec, MUD).then((r) => (result = r));
      await vi.advanceTimersByTimeAsync(799);
      expect(result).toBe("pending");
      await vi.advanceTimersByTimeAsync(1);
      expect(result).toBeUndefined();
      if (stuck === "hit") expect(m.scoreElements).not.toHaveBeenCalled();
      m.scoreElements.mockClear();
    }
  });
});

describe("CombineSchema sort", () => {
  const base = { ids: ["1", "2"], clientDate: "2026-11-07" };

  it("accepts a valid spec and cleans it", () => {
    expect(CombineSchema.parse({ ...base, sort: { kind: "rank", prompt: "  spookiest " } }).sort).toEqual(rankSpec);
    expect(CombineSchema.parse(base).sort).toBeUndefined();
  });

  it("drops an invalid spec instead of failing the combine", () => {
    for (const sort of [{ kind: "rank", prompt: "" }, { kind: "groups", groups: ["Other", "Fire"] }, "spooky", 42]) {
      const parsed = CombineSchema.safeParse({ ...base, sort });
      expect(parsed.success).toBe(true);
      expect(parsed.data?.sort).toBeUndefined();
    }
    expect(CombineSchema.safeParse({ ...base, ids: ["1"], sort: rankSpec }).success).toBe(false); // the rest still validates
  });
});

describe("combine with an active custom sort", () => {
  const PLAYER: PlayerRow = {
    id: "77",
    public_id: "pub-77",
    legacy_user_id: null,
    created_at: new Date("2026-11-01T00:00:00Z"),
    session_version: 1,
    legacy_import_count: 0,
  };
  const element = (id: string, name: string) => ({ ...row({ id, name, status: "active", depth: 1, steps: 1 }) });
  let isNew = true;

  const combine = async (body: Record<string, unknown>) => {
    const res = await combineElements(
      new Request("https://alchemy.test/api/combine", {
        method: "POST",
        headers: { "content-type": "application/json", "x-ia-client": "1", cookie: `ia_session=${encodeSession("77", 1)}` },
        body: JSON.stringify({ ids: ["1", "2"], clientDate: "2026-11-07", ...body }),
      }),
      { ip: "203.0.113.7" } as Context,
    );
    expect(res.status).toBe(200);
    return (await res.json()) as CombineResponse;
  };

  beforeAll(() => {
    process.env.SESSION_SECRET = "test-secret-".padEnd(48, "x");
  });

  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(console, "warn").mockImplementation(() => {});
    isNew = true;
    m.playerForClaims.mockResolvedValue(PLAYER);
    m.completeTiers.mockResolvedValue([]);
    m.hit.mockResolvedValue({ ok: true });
    m.scoreElements.mockResolvedValue(outcome(640));
    // A known recipe: Water (1) + Earth (2) → Mud.
    m.db.mockImplementation(async (sql: string) => {
      if (/FROM \S+discoveries d\s+JOIN/.test(sql)) return [element("1", "Water"), element("2", "Earth")];
      if (/WHERE r\.ingredient_ids = \$1::INT8\[\]/.test(sql)) {
        return [{ recipe_id: "500", recipe_status: "active", protected: false, ...element(MUD.id, "Mud") }];
      }
      if (/INSERT INTO \S+discoveries/.test(sql)) return isNew ? [{ discovered_at: new Date("2026-11-07T10:00:00Z") }] : [];
      if (/INSERT INTO \S+player_days/.test(sql)) return [];
      throw new Error(`unexpected query: ${sql}`);
    });
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("scores a new discovery and returns it as sortScore", async () => {
    const res = await combine({ sort: rankSpec });
    expect(res).toMatchObject({ newForPlayer: true, result: { id: MUD.id, name: "Mud" }, sortScore: { s: 640 } });
    expect(m.scoreElements).toHaveBeenCalledWith(rankSpec, [MUD], { deadlineMs: expect.any(Number), retries: 0, split: false });
    const { deadlineMs } = m.scoreElements.mock.calls[0]![2] as { deadlineMs: number };
    expect(deadlineMs).toBeGreaterThan(700); // what is left of the 800 ms cap after the budget write
    expect(deadlineMs).toBeLessThanOrEqual(800);
    expect(m.hit.mock.invocationCallOrder[0]).toBeLessThan(m.scoreElements.mock.invocationCallOrder[0]!);
  });

  it("does not score a result the player already owns, or a combine without a sort", async () => {
    isNew = false;
    expect((await combine({ sort: rankSpec })).sortScore).toBeUndefined();
    isNew = true;
    expect((await combine({})).sortScore).toBeUndefined();
    expect((await combine({ sort: { kind: "rank", prompt: " " } })).sortScore).toBeUndefined();
    expect(m.scoreElements).not.toHaveBeenCalled();
    expect(m.hit).not.toHaveBeenCalled();
  });

  it("still answers the combine when scoring fails or the budget is out", async () => {
    m.scoreElements.mockRejectedValue(new AiUnavailable("down"));
    const failed = await combine({ sort: rankSpec });
    expect(failed).toMatchObject({ newForPlayer: true, entry: { id: MUD.id } });
    expect(failed.sortScore).toBeUndefined();
    m.scoreElements.mockReset();
    m.scoreElements.mockResolvedValue(outcome(640));
    m.hit.mockResolvedValue({ ok: false, limit: BUDGETS.jev, retryAfterMs: 1_000 });
    expect((await combine({ sort: groupSpec })).sortScore).toBeUndefined();
    expect(m.scoreElements).not.toHaveBeenCalled();
  });

  it("answers within the 800 ms cap when scoring hangs", async () => {
    vi.useFakeTimers();
    m.scoreElements.mockImplementation(never);
    let res: CombineResponse | undefined;
    void combine({ sort: rankSpec }).then((r) => (res = r));
    await vi.advanceTimersByTimeAsync(799);
    expect(res).toBeUndefined();
    await vi.advanceTimersByTimeAsync(1);
    expect(res).toMatchObject({ newForPlayer: true });
    expect(res!.sortScore).toBeUndefined();
  });
});
