import type { Context } from "@netlify/functions";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const m = vi.hoisted(() => ({ enforce: vi.fn(), bumpStat: vi.fn() }));
vi.mock("../ratelimit.ts", async (orig) => ({
  ...(await orig<typeof import("../ratelimit.ts")>()),
  enforce: m.enforce,
  bumpStat: m.bumpStat,
}));

const { bootBeacon } = await import("./beacon.ts");

const CHROMEOS = "Mozilla/5.0 (X11; CrOS x86_64 14541.0.0) AppleWebKit/537.36 Chrome/120.0 Safari/537.36";

beforeAll(() => {
  process.env.SESSION_SECRET = "test-secret-".padEnd(48, "x");
});

beforeEach(() => {
  vi.clearAllMocks();
  m.enforce.mockResolvedValue(undefined);
  m.bumpStat.mockResolvedValue(undefined);
});

/** `headers` override the defaults a same-origin sendBeacon carries; "" removes one. */
function send(body: unknown, headers: Record<string, string> = {}) {
  const all: Record<string, string> = { "content-type": "text/plain;charset=UTF-8", "sec-fetch-site": "same-origin", "user-agent": CHROMEOS, ...headers };
  for (const k of Object.keys(all)) if (all[k] === "") delete all[k];
  return bootBeacon(
    new Request("https://alchemy.test/api/beacon", { method: "POST", headers: all, body: typeof body === "string" ? body : JSON.stringify(body) }),
    { ip: "203.0.113.7" } as Context,
  );
}

describe("POST /api/beacon", () => {
  it("counts the abandon by phase, time band and platform, and answers 204", async () => {
    const res = await send({ phase: "pow", ms: 9_200 });
    expect(res.status).toBe(204);
    expect(await res.text()).toBe("");
    expect(m.bumpStat).toHaveBeenCalledWith("boot_abandon:pow:8-15s:chromeos");
    expect(m.enforce).toHaveBeenCalledWith([{ limit: expect.objectContaining({ name: "beacon.ip", limit: 120 }), subject: expect.any(String) }]);
    // The rate-limit subject is the keyed network hash, never the address itself.
    expect(m.enforce.mock.calls[0]![0][0].subject).not.toContain("203.0.113");
  });

  it("counts a take-back (the page came back) under boot_resumed with the abandon's phase and band", async () => {
    const res = await send({ phase: "pow", ms: 9_200, resumed: true });
    expect(res.status).toBe(204);
    expect(m.bumpStat).toHaveBeenCalledWith("boot_resumed:pow:8-15s:chromeos");
    // A malformed flag is dropped: still a plain abandon, never a 400.
    await send({ phase: "pow", ms: 9_200, resumed: "yes" });
    expect(m.bumpStat).toHaveBeenLastCalledWith("boot_abandon:pow:8-15s:chromeos");
  });

  it("bands every duration", async () => {
    for (const [ms, band] of [
      [0, "<2s"],
      [3_000, "2-4s"],
      [5_000, "4-8s"],
      [20_000, "15-30s"],
      [400_000, "30s+"],
    ] as const) {
      await send({ phase: "bootstrap1", ms });
      expect(m.bumpStat).toHaveBeenLastCalledWith(`boot_abandon:bootstrap1:${band}:chromeos`);
    }
  });

  it("accepts a matching Origin when Sec-Fetch-Site is missing", async () => {
    const res = await send({ phase: "error", ms: 1 }, { "sec-fetch-site": "", origin: "https://alchemy.test" });
    expect(res.status).toBe(204);
  });

  it("refuses cross-site and unlabeled requests", async () => {
    const refused: Record<string, string>[] = [
      { "sec-fetch-site": "cross-site" },
      { "sec-fetch-site": "same-site" },
      { "sec-fetch-site": "none" },
      { "sec-fetch-site": "", origin: "https://evil.example" },
      { "sec-fetch-site": "", origin: "null" },
      { "sec-fetch-site": "" },
    ];
    for (const headers of refused) {
      await expect(send({ phase: "pow", ms: 1 }, headers)).rejects.toMatchObject({ status: 403 });
    }
    expect(m.bumpStat).not.toHaveBeenCalled();
  });

  it("refuses unknown phases, bad bodies, other content types and oversized bodies", async () => {
    await expect(send({ phase: "html", ms: 1 })).rejects.toMatchObject({ status: 400 });
    await expect(send({ phase: "pow", ms: -1 })).rejects.toMatchObject({ status: 400 });
    await expect(send({ phase: "pow" })).rejects.toMatchObject({ status: 400 });
    await expect(send("not json")).rejects.toMatchObject({ status: 400 });
    await expect(send({ phase: "pow", ms: 1 }, { "content-type": "application/x-www-form-urlencoded" })).rejects.toMatchObject({ status: 415 });
    await expect(send({ phase: "pow", ms: 1, pad: "x".repeat(1_000) })).rejects.toMatchObject({ status: 413 });
    expect(m.enforce).not.toHaveBeenCalled();
    expect(m.bumpStat).not.toHaveBeenCalled();
  });

  it("counts nothing once the IP is over its limit", async () => {
    m.enforce.mockRejectedValue(Object.assign(new Error("limited"), { status: 429 }));
    await expect(send({ phase: "pow", ms: 1 })).rejects.toMatchObject({ status: 429 });
    expect(m.bumpStat).not.toHaveBeenCalled();
  });
});

