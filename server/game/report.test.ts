import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { encodeSession } from "../session.ts";

const m = vi.hoisted(() => ({
  db: vi.fn(),
  enforce: vi.fn(),
  isTodayTarget: vi.fn(),
  playerForClaims: vi.fn(),
}));

vi.mock("../db.ts", async (orig) => ({
  ...(await orig<typeof import("../db.ts")>()),
  t: (name: string) => `test.${name}`,
  q1: async (text: string, params: unknown[] = []) => ((await m.db(text, params)) as unknown[])[0],
}));
vi.mock("../ratelimit.ts", async (orig) => ({ ...(await orig<typeof import("../ratelimit.ts")>()), enforce: m.enforce }));
vi.mock("../session.ts", async (orig) => ({ ...(await orig<typeof import("../session.ts")>()), playerForClaims: m.playerForClaims }));
vi.mock("./challenges.ts", async (orig) => ({ ...(await orig<typeof import("./challenges.ts")>()), isTodayTarget: m.isTodayTarget }));

const { reportElement } = await import("./report.ts");

const ELEMENT = "1083333177628557313";
const PLAYER = { id: "77", public_id: "pub-77", legacy_user_id: null, created_at: new Date(), session_version: 1, legacy_import_count: 0 };

beforeAll(() => {
  process.env.SESSION_SECRET = "test-secret-".padEnd(48, "x");
});

beforeEach(() => {
  vi.clearAllMocks();
  m.enforce.mockResolvedValue(undefined);
  m.isTodayTarget.mockResolvedValue(false);
  m.playerForClaims.mockResolvedValue(PLAYER);
  m.db.mockResolvedValue([{ allowed: true, inserted: 1 }]);
});

const send = (body: unknown, opts: { cookie?: boolean } = {}) =>
  reportElement(
    new Request("https://alchemy.test/api/report", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-ia-client": "1",
        ...(opts.cookie === false ? {} : { cookie: `ia_session=${encodeSession("77", 1)}` }),
      },
      body: JSON.stringify(body),
    }),
  );

describe("POST /api/report", () => {
  it("stores the report and answers ok", async () => {
    const res = await send({ id: ELEMENT, reason: "inappropriate" });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    const [sql, params] = m.db.mock.calls[0]!;
    expect(String(sql)).toContain("INSERT INTO test.element_reports");
    expect(String(sql)).toContain("ON CONFLICT (player_id, element_id) DO NOTHING");
    expect(params).toEqual(["77", ELEMENT, false, "inappropriate"]);
    expect(m.enforce).toHaveBeenCalledWith([{ limit: expect.objectContaining({ name: "report.player", limit: 20 }), subject: "77" }]);
  });

  it("lets anyone report today's challenge targets", async () => {
    m.isTodayTarget.mockResolvedValue(true);
    await send({ id: ELEMENT });
    expect(m.db.mock.calls[0]![1]).toEqual(["77", ELEMENT, true, null]);
  });

  it("drops an unknown reason instead of refusing the report", async () => {
    const res = await send({ id: ELEMENT, reason: "spam" });
    expect(res.status).toBe(200);
    expect((m.db.mock.calls[0]![1] as unknown[])[3]).toBeNull();
  });

  it("refuses elements the player doesn't have", async () => {
    m.db.mockResolvedValue([{ allowed: false, inserted: 0 }]);
    await expect(send({ id: ELEMENT })).rejects.toMatchObject({ status: 403, code: "forbidden" });
  });

  it("needs a session and a valid id", async () => {
    await expect(send({ id: ELEMENT }, { cookie: false })).rejects.toMatchObject({ status: 401 });
    m.playerForClaims.mockResolvedValue(null); // revoked session
    await expect(send({ id: ELEMENT })).rejects.toMatchObject({ status: 401 });
    await expect(send({ id: "../etc" })).rejects.toMatchObject({ status: 400 });
    await expect(send({})).rejects.toMatchObject({ status: 400 });
    expect(m.db).not.toHaveBeenCalled();
  });

  it("is rate limited before anything is written", async () => {
    m.enforce.mockRejectedValue(Object.assign(new Error("limited"), { status: 429 }));
    await expect(send({ id: ELEMENT })).rejects.toMatchObject({ status: 429 });
    expect(m.db).not.toHaveBeenCalled();
  });
});
