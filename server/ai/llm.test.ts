import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { AiUnavailable, Fizzled } from "./common.ts";
import { CALL_TIMEOUT_MS, CORRECT_BEFORE_MS, DEADLINE_MS, RETRY_FAILED_BEFORE_MS, combine } from "./llm.ts";

// The OpenAI client behind combine(): every call goes to m.create(body, options).
const m = vi.hoisted(() => ({ create: vi.fn(), clientOptions: [] as unknown[] }));
vi.mock("openai", () => ({
  default: class {
    responses = { create: m.create };
    constructor(opts: unknown) {
      m.clientOptions.push(opts);
    }
  },
}));

const answer = (o: Record<string, unknown>) => ({ status: "completed", output_text: JSON.stringify(o) });
const STEAM = answer({ name: "Steam", emoji: "♨️", description: "Hot water vapor.", notable: false, icon: "a puff of steam" });
const ECHO = answer({ name: "Fire", emoji: "🔥", description: "Flames.", notable: false, icon: "a flame" });
/** A call that takes `ms` of (fake) time, then answers or throws. */
const after = (ms: number, outcome: unknown) => async () => {
  vi.setSystemTime(Date.now() + ms);
  if (outcome instanceof Error) throw outcome;
  return outcome;
};
const httpError = (status?: number) => Object.assign(new Error(status ? `HTTP ${status}` : "Connection error."), { status });

beforeAll(() => {
  process.env.OPENAI_API_KEY = "test-key";
});

beforeEach(() => {
  vi.useFakeTimers();
  m.create.mockReset();
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("combine time bounds", () => {
  it("keeps the worst case under the client's 15 s timeout", () => {
    expect(DEADLINE_MS).toBeLessThan(15_000);
    expect(RETRY_FAILED_BEFORE_MS).toBeLessThan(CORRECT_BEFORE_MS);
  });

  it("answers in one call, with SDK retries off and a per-call timeout", async () => {
    m.create.mockImplementation(after(1_500, STEAM));
    await expect(combine(["Fire", "Water"], "sid")).resolves.toMatchObject({ name: "Steam" });
    expect(m.create).toHaveBeenCalledTimes(1);
    expect(m.create.mock.calls[0]![1]).toEqual({ timeout: CALL_TIMEOUT_MS });
    expect(m.clientOptions.at(-1)).toMatchObject({ timeout: CALL_TIMEOUT_MS, maxRetries: 0 });
  });

  it("retries a fast provider failure once, with what is left of the deadline", async () => {
    m.create.mockImplementationOnce(after(4_000, httpError(500))).mockImplementationOnce(after(1_000, STEAM));
    await expect(combine(["Fire", "Water"], "sid")).resolves.toMatchObject({ name: "Steam" });
    expect(m.create).toHaveBeenCalledTimes(2);
    expect(m.create.mock.calls[1]![1]).toEqual({ timeout: CALL_TIMEOUT_MS }); // 7 s were left
  });

  it("fails fast when a failure comes too late to retry, or is not transient", async () => {
    m.create.mockImplementation(after(CALL_TIMEOUT_MS, httpError())); // a timeout
    await expect(combine(["Fire", "Water"], "sid")).rejects.toBeInstanceOf(AiUnavailable);
    expect(m.create).toHaveBeenCalledTimes(1);
    m.create.mockReset();
    m.create.mockImplementation(after(200, httpError(400)));
    await expect(combine(["Fire", "Water"], "sid")).rejects.toBeInstanceOf(AiUnavailable);
    expect(m.create).toHaveBeenCalledTimes(1);
  });

  it("retries a failure only once", async () => {
    m.create.mockImplementation(after(500, httpError(503)));
    await expect(combine(["Fire", "Water"], "sid")).rejects.toBeInstanceOf(AiUnavailable);
    expect(m.create).toHaveBeenCalledTimes(2);
  });

  it("gives an invalid answer one corrective retry, then fizzles", async () => {
    m.create.mockImplementation(after(1_500, ECHO));
    const e = await combine(["Fire", "Water"], "sid").catch((x: unknown) => x);
    expect(e).toBeInstanceOf(Fizzled);
    expect(m.create).toHaveBeenCalledTimes(2);
    const retryInput = (m.create.mock.calls[1]![0] as { input: { role: string }[] }).input;
    expect(retryInput.at(-2)).toMatchObject({ role: "assistant" });
  });

  it("skips the corrective retry when the invalid answer came late", async () => {
    m.create.mockImplementation(after(CORRECT_BEFORE_MS, ECHO));
    await expect(combine(["Fire", "Water"], "sid")).rejects.toBeInstanceOf(AiUnavailable);
    expect(m.create).toHaveBeenCalledTimes(1);
  });

  it("never lets the second call run past the deadline", async () => {
    // Failure at 4.9 s → retry → invalid answer at 5.9 s → correction with the 5.1 s left.
    m.create
      .mockImplementationOnce(after(4_900, httpError(502)))
      .mockImplementationOnce(after(1_000, ECHO))
      .mockImplementationOnce(after(5_100, ECHO));
    await expect(combine(["Fire", "Water"], "sid")).rejects.toBeInstanceOf(Fizzled);
    expect(m.create.mock.calls.map((c) => c[1])).toEqual([{ timeout: 6_000 }, { timeout: 6_000 }, { timeout: 5_100 }]);
    m.create.mockReset();
    // A slow first answer at 6.5 s still gets its correction, capped at the 4.5 s left.
    m.create.mockImplementationOnce(after(6_500, ECHO)).mockImplementationOnce(after(1_000, STEAM));
    await expect(combine(["Fire", "Water"], "sid")).resolves.toMatchObject({ name: "Steam" });
    expect(m.create.mock.calls[1]![1]).toEqual({ timeout: DEADLINE_MS - 6_500 });
  });
});
