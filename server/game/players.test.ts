import { beforeEach, describe, expect, it, vi } from "vitest";

const m = vi.hoisted(() => ({ db: vi.fn() }));
vi.mock("../db.ts", async (orig) => ({
  ...(await orig<typeof import("../db.ts")>()),
  t: (name: string) => `test.${name}`,
  q: (text: string, params: unknown[] = []) => m.db(text, params),
  q1: async (text: string, params: unknown[] = []) => ((await m.db(text, params)) as unknown[])[0],
}));

const { activitySql, countActivity, createPlayer, recentElements, touchPlayer } = await import("./players.ts");

const undefinedColumn = () => Object.assign(new Error('column "first_at" does not exist'), { code: "42703" });
const sqls = () => m.db.mock.calls.map((c) => String(c[0]));

beforeEach(() => {
  m.db.mockReset();
  m.db.mockResolvedValue([]);
});

describe("player_days timing", () => {
  it("starts a day with first_at = last_at = now() and one session", () => {
    const sql = activitySql("loads", true);
    expect(sql).toMatch(/\(player_id, day, loads, first_at, last_at, sessions, entry\)\s+VALUES \(\$1, \$2::DATE, 1, now\(\), now\(\), 1, \$3::STRING\)/);
  });

  it("counts sessions, active time and the first entry on later events, in the same statement", () => {
    const sql = activitySql("combines", true);
    expect(sql).toContain("combines = pd.combines + 1");
    expect(sql).toContain("sessions = pd.sessions + CASE WHEN now() - pd.last_at > INTERVAL '30 minutes' THEN 1 ELSE 0 END");
    expect(sql).toMatch(/active_secs = pd\.active_secs \+ CASE\s+WHEN now\(\) - pd\.last_at BETWEEN INTERVAL '0 seconds' AND INTERVAL '5 minutes'/);
    expect(sql).toContain("last_at = greatest(pd.last_at, now())");
    expect(sql).toContain("entry = COALESCE(pd.entry, excluded.entry)");
    // first_at is only ever set on insert: a row begun before 0009 stays untimed.
    expect(sql.split("ON CONFLICT")[1]).not.toContain("first_at");
  });

  it("passes the entry (bootstrap) or null (combine)", async () => {
    await countActivity("7", "loads", "2026-11-30", "search");
    await countActivity("7", "combines", "2026-11-30");
    expect(m.db.mock.calls.map((c) => c[1])).toEqual([
      ["7", "2026-11-30", "search"],
      ["7", "2026-11-30", null],
    ]);
  });

  it("still counts the event, untimed, before migration 0009", async () => {
    m.db.mockRejectedValueOnce(undefinedColumn());
    await countActivity("7", "loads", "2026-11-30", "direct");
    expect(sqls()).toHaveLength(2);
    expect(sqls()[1]).not.toContain("first_at");
    expect(m.db.mock.calls[1]![1]).toEqual(["7", "2026-11-30"]);
  });

  it("never throws", async () => {
    m.db.mockRejectedValue(new Error("connection reset"));
    await expect(countActivity("7", "combines", "2026-11-30")).resolves.toBeUndefined();
  });
});

describe("touchPlayer", () => {
  it("stamps standalone_at only for installed-app loads, in the last_seen_at update", async () => {
    await touchPlayer("7", "2026-11-30");
    expect(sqls().find((s) => s.includes("last_seen_at"))).not.toContain("standalone_at");
    m.db.mockClear();
    await touchPlayer("7", "2026-11-30", { standalone: true, entry: "standalone" });
    const seen = sqls().find((s) => s.includes("last_seen_at"))!;
    expect(seen).toContain("standalone_at = COALESCE(standalone_at, now())");
    expect(m.db.mock.calls.find((c) => String(c[0]).includes("player_days"))![1]).toEqual(["7", "2026-11-30", "standalone"]);
  });

  it("keeps the load when standalone_at is missing", async () => {
    m.db.mockImplementation(async (sql: string) => {
      if (sql.includes("standalone_at")) throw Object.assign(new Error('column "standalone_at" does not exist'), { code: "42703" });
      return [];
    });
    await touchPlayer("7", "2026-11-30", { standalone: true });
    expect(sqls().filter((s) => s.includes("last_seen_at"))).toHaveLength(2);
  });

  it("a resumed-tab refresh moves last_seen_at but writes no player_days row", async () => {
    await touchPlayer("7", "2026-11-30", { refresh: true });
    expect(sqls().some((s) => s.includes("last_seen_at"))).toBe(true);
    expect(sqls().some((s) => s.includes("player_days"))).toBe(false);
  });
});

describe("createPlayer", () => {
  const row = { id: "9", public_id: "p", legacy_user_id: null, created_at: new Date(), session_version: 1, legacy_import_count: 0 };

  it("stores the client hints", async () => {
    m.db.mockResolvedValue([row]);
    await createPlayer("ip", { uaClass: "mac", hint: { touch: true, wide: false } });
    const [sql, params] = m.db.mock.calls[0]!;
    expect(String(sql)).toContain("acq_ua_class, acq_touch, acq_wide, acq_prior_local)");
    expect((params as unknown[]).slice(6)).toEqual(["mac", true, false, null]);
  });

  it("creates the player without them before migration 0009", async () => {
    m.db.mockRejectedValueOnce(undefinedColumn()).mockResolvedValueOnce([row]);
    expect(await createPlayer("ip", { hint: { touch: true } })).toBe(row);
    expect(sqls()[1]).not.toContain("acq_touch");
    expect((m.db.mock.calls[1]![1] as unknown[]).length).toBe(7);
  });

  it("does not hide other failures", async () => {
    m.db.mockRejectedValueOnce(new Error("boom"));
    await expect(createPlayer("ip")).rejects.toThrow("boom");
  });
});

describe("fresh feed", () => {
  it("lists only elements whose art is ready, newest first", async () => {
    await recentElements();
    expect(sqls()[0]).toContain("e.image_status = 'ready'");
    expect(sqls()[0]).toContain("ORDER BY e.created_at DESC LIMIT $1");
  });
});
