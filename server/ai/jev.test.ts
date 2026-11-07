import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SORT_RUBRIC, type SortSpec } from "../../src/shared/api.ts";
import { AiUnavailable } from "./common.ts";
import {
  RANK_LEVELS,
  SORT_MODEL,
  engineId,
  est,
  jevScore,
  packChunks,
  parseChunk,
  questionsFor,
  requestBody,
  type JevDeps,
  type ScoreItem,
  type ScoreOpts,
} from "./jev.ts";

type Q = { type: string; instructions: { element: string }; criteria?: Record<string, string> | string[] };

const KEY = "sk-test-SECRET-KEY";
const PROMPT = "zqx-secret-prompt";
const rank: SortSpec = { kind: "rank", prompt: PROMPT };
const groups: SortSpec = { kind: "groups", groups: ["Animals", "Food & drink", "zqx-secret-group"] };
const FULL: ScoreOpts = { deadlineMs: 20_000, retries: 1, split: true };
const STATE = "Elements from an alchemy crafting game. Each question is about one element, given by name.";
const RANK_STATE =
  "A player of an alchemy crafting game is sorting the elements they own by a sort description they typed, best fits first. " +
  "Each question is about one element, given by name. Read each name as the real thing it usually names, and judge that thing.";

/** n items with realistic 19-digit ids and names padded to the 32-character maximum. */
const items = (n: number, pad = 32): ScoreItem[] =>
  Array.from({ length: n }, (_, i) => ({ id: String(1_083_333_177_628_557_313n + BigInt(i)), name: `E${i}`.padEnd(pad, "x") }));

const reply = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  new Response(typeof body === "string" ? body : JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });

/** A well-formed answer for every question in the request. */
function answer(questions: Record<string, Q>, tokens = 100) {
  const answers: Record<string, unknown> = {};
  for (const [k, q] of Object.entries(questions)) {
    if (q.type === "score") answers[k] = { type: "score", score: 3, confidence: 0.8 };
    if (q.type === "choice") {
      const keys = Object.keys(q.criteria as Record<string, string>);
      answers[k] = { type: "choice", choice: keys[0], confidence: 0.6, probabilities: Object.fromEntries(keys.map((c, i) => [c, i === 0 ? 0.7 : 0.1])) };
    }
    if (q.type === "noul") answers[k] = { type: "noul", noul: 0.9 };
  }
  return { model: SORT_MODEL, answers, usage: { input_tokens: tokens, output_tokens: 1 } };
}

const bodyOf = (init?: RequestInit) => JSON.parse(String(init?.body)) as { model: string; state: string; questions: Record<string, Q> };
/** Name of the first element in a request (identifies its chunk). */
const firstName = (init?: RequestInit) => Object.values(bodyOf(init).questions)[0]!.instructions.element;

function deps(fetch: (url: string, init?: RequestInit) => Promise<Response>, over: Partial<JevDeps> = {}) {
  const f = vi.fn(fetch);
  const sleep = vi.fn(async (_ms: number, _signal: AbortSignal) => {});
  return {
    fetch: f,
    sleep,
    d: { fetch: f as unknown as typeof globalThis.fetch, key: () => KEY, sleep, random: () => 0, ...over } satisfies Partial<JevDeps>,
  };
}

const ok = async (_url: string, init?: RequestInit) => reply(200, answer(bodyOf(init).questions));

let logs: ReturnType<typeof vi.spyOn>[] = [];
beforeEach(() => {
  logs = (["info", "warn", "error", "log"] as const).map((m) => vi.spyOn(console, m).mockImplementation(() => {}));
});
afterEach(() => vi.restoreAllMocks());

describe("questions", () => {
  it("asks one score question per element in rank mode", () => {
    expect(questionsFor({ kind: "rank", prompt: "spookiest" }, { id: "5", name: "Ghost" }, 3)).toEqual({
      r3: {
        type: "score",
        instructions: { question: "How well does this element match the sort description?", sort_description: "spookiest", element: "Ghost" },
        criteria: ["Does not match at all", "Matches a little", "Matches somewhat", "Matches clearly", "A perfect, textbook match"],
      },
    });
  });

  it("asks a choice plus a companion noul per element in groups mode", () => {
    const spec: SortSpec = { kind: "groups", groups: ["Animals", "Food", "Weather"] };
    const q = questionsFor(spec, { id: "5", name: "Ghost" }, 7) as Record<string, { criteria?: Record<string, string> }>;
    expect(Object.keys(q)).toEqual(["c7", "n7"]);
    expect(q.c7).toMatchObject({ type: "choice", instructions: { question: "Which group does this element belong in?", element: "Ghost" } });
    expect(q.n7).toEqual({
      type: "noul",
      instructions: { question: "Does this element clearly belong in one of these groups?", groups: ["Animals", "Food", "Weather"], element: "Ghost" },
    });
    // Ids stay stable (g{index into spec.groups}); only the order rotates. "None of these groups"
    // is always the last option and never rotates.
    const criteria = q.c7!.criteria!;
    expect(Object.fromEntries(Object.entries(criteria).sort())).toEqual({ g0: "Animals", g1: "Food", g2: "Weather", gx: "None of these groups" });
    expect(Object.keys(criteria).at(-1)).toBe("gx");
    const order = Object.keys(criteria).filter((k) => k !== "gx").map((k) => Number(k.slice(1)));
    expect(order.map((j, i) => (j - order[0]! - i + 9) % 3)).toEqual([0, 0, 0]);
  });

  it("keeps None of these groups last for every rotation", () => {
    const spec: SortSpec = { kind: "groups", groups: ["A", "B", "C", "D", "E"] };
    const firsts = new Set<string>();
    for (const it of items(60)) {
      const keys = Object.keys((questionsFor(spec, it, 0).c0 as { criteria: object }).criteria);
      expect(keys).toHaveLength(6);
      expect(keys.at(-1)).toBe("gx");
      firsts.add(keys[0]!);
    }
    expect(firsts.size).toBeGreaterThan(1); // the real groups still rotate
  });

  it("rotates options by element id, identically on every call", () => {
    const spec: SortSpec = { kind: "groups", groups: ["A", "B", "C", "D"] };
    const first = (id: string, k: number) => Object.keys((questionsFor(spec, { id, name: "X" }, k)[`c${k}`] as { criteria: object }).criteria)[0];
    const ids = items(40).map((it) => it.id);
    for (const id of ids) expect(first(id, 0)).toBe(first(id, 17));
    expect(new Set(ids.map((id) => first(id, 0))).size).toBeGreaterThan(1);
  });
});

describe("requestBody", () => {
  it("sends the rank goal state with rank questions and the plain state with groups", () => {
    const chunk = items(3);
    const r = JSON.parse(requestBody(rank, chunk)) as { model: string; state: string; questions: Record<string, unknown> };
    expect(r).toEqual({
      model: SORT_MODEL,
      state: RANK_STATE,
      questions: Object.assign({}, ...chunk.map((it, k) => questionsFor(rank, it, k))),
    });
    const g = JSON.parse(requestBody(groups, chunk)) as { state: string; questions: Record<string, unknown> };
    expect(g.state).toBe(STATE);
    expect(Object.keys(g.questions)).toEqual(["c0", "n0", "c1", "n1", "c2", "n2"]);
  });
});

describe("packChunks", () => {
  const sizeOf = (spec: SortSpec, chunk: ScoreItem[]) => 300 + chunk.reduce((n, it, k) => n + est(questionsFor(spec, it, k)), 0);

  it("keeps every request under 40k estimated tokens and 400 questions, in input order", () => {
    const longGroups: SortSpec = { kind: "groups", groups: Array.from({ length: 8 }, (_, i) => `Group ${i}`.padEnd(32, "y")) };
    for (const spec of [rank, longGroups]) {
      const all = items(5_000);
      const chunks = packChunks(spec, all);
      expect(chunks.length).toBeGreaterThan(5);
      expect(chunks.flat()).toEqual(all);
      for (const c of chunks) {
        expect(sizeOf(spec, c)).toBeLessThanOrEqual(40_000);
        expect(c.length * (spec.kind === "groups" ? 2 : 1)).toBeLessThanOrEqual(400);
      }
    }
  });

  it("never splits an element's choice and noul across requests", () => {
    for (const c of packChunks(groups, items(1_000, 4))) {
      expect(c.length).toBe(200); // 400 questions binds before the token estimate for short names
      const keys = Object.keys(Object.assign({}, ...c.map((it, k) => questionsFor(groups, it, k))));
      expect(keys.length).toBe(2 * c.length);
      c.forEach((_, k) => expect(keys).toEqual(expect.arrayContaining([`c${k}`, `n${k}`])));
    }
  });
});

describe("parseChunk", () => {
  const chunk = items(6);
  const ids = chunk.map((it) => it.id);

  it("normalizes rank scores by the 4 level steps and rejects bad answers", () => {
    const out = parseChunk(rank, chunk, {
      r0: { score: 0 },
      r1: { score: 4 },
      r2: { score: 2.98 },
      r3: { score: 4.01 },
      r4: { score: "3" },
      // r5 missing
    });
    expect(RANK_LEVELS).toHaveLength(5);
    expect([...out.scored]).toEqual([
      [ids[0], { s: 0 }],
      [ids[1], { s: 1000 }],
      [ids[2], { s: 745 }],
    ]);
    expect(out.retry).toEqual(ids.slice(3));
  });

  it("uses the chosen group's probability and discounts the fit by P(None of these groups)", () => {
    const all = items(4);
    const out = parseChunk(groups, all, {
      c0: { choice: "g2", confidence: 0.5, probabilities: { g0: 0.1, g1: 0.1, g2: 0.7, gx: 0.1 } },
      n0: { noul: 0.25 },
      c1: { choice: "g1", confidence: 0.9, probabilities: { g0: 0, g1: 1, g2: 0, gx: 0 } },
      n1: { noul: 1 },
      // Jev chose None (about 45% of elements): keep the most likely real group.
      c2: { choice: "gx", confidence: 0.4, probabilities: { g0: 0.2, g1: 0.3, g2: 0.1, gx: 0.4 } },
      n2: { noul: 0.8 },
      // ...the first one on ties.
      c3: { choice: "gx", confidence: 0.5, probabilities: { g0: 0.1, g1: 0.2, g2: 0.2, gx: 0.5 } },
      n3: { noul: 0.6 },
    });
    expect([...out.scored]).toEqual([
      [all[0]!.id, { s: 700, g: 2, n: 225 }], // 1000 x 0.25 x (1 - 0.1)
      [all[1]!.id, { s: 1000, g: 1, n: 1000 }],
      [all[2]!.id, { s: 300, g: 1, n: 480 }], // 1000 x 0.8 x (1 - 0.4)
      [all[3]!.id, { s: 200, g: 1, n: 300 }],
    ]);
    expect(out.retry).toEqual([]);
  });

  it("requires every group's and None's probability and a valid fit (no confidence fallback)", () => {
    const probs = { g0: 0.6, g1: 0.2, g2: 0.1, gx: 0.1 };
    const out = parseChunk(groups, chunk, {
      c0: { choice: "g3", confidence: 0.9, probabilities: { ...probs, g3: 0.5 } }, // only 3 groups
      n0: { noul: 0.9 },
      c1: { choice: "x0", confidence: 0.9, probabilities: probs },
      n1: { noul: 0.9 },
      c2: { choice: "g0", confidence: 0.9, probabilities: probs },
      n2: { noul: 1.2 },
      c3: { choice: "g0", confidence: 0.9 }, // confidence alone is not enough any more
      n3: { noul: 0.5 },
      c4: { choice: "g0", confidence: 0.6, probabilities: { g0: 0.6, g1: 0.2, g2: 0.2 } }, // no gx
      n4: { noul: 0.5 },
      c5: { choice: "g0", confidence: 0.6, probabilities: { g0: 0.6, g1: 1.5, g2: 0.1, gx: 0.1 } }, // g1 out of range
      n5: { noul: 0.5 },
    });
    expect([...out.scored]).toEqual([]);
    expect(out.retry).toEqual(ids);
    expect(parseChunk(groups, chunk, null).retry).toEqual(ids);
    // A complete probability table parses.
    const one = parseChunk(groups, chunk.slice(0, 1), { c0: { choice: "g0", probabilities: probs }, n0: { noul: 0.5 } });
    expect(one.scored.get(ids[0]!)).toEqual({ s: 600, g: 0, n: 450 });
  });
});

describe("jevScore", () => {
  it("fans a large library out over parallel requests and scores everything", async () => {
    const t = deps(ok);
    const all = items(1_000);
    const out = await jevScore(rank, all, FULL, t.d);
    expect(out.engine).toBe(engineId());
    expect(engineId()).toBe(`jev-1.14.0/${SORT_RUBRIC}`);
    expect(out.scored.size).toBe(1_000);
    expect(out.retry).toEqual([]);
    expect(out.scored.get(all[999]!.id)).toEqual({ s: 750 });
    const calls = t.fetch.mock.calls;
    expect(calls.length).toBe(packChunks(rank, all).length);
    expect(out.tokens).toBe(100 * calls.length);
    const [url, init] = calls[0]!;
    expect(url).toBe("https://api.typesafe.ai/v1/systemone");
    expect(init?.method).toBe("POST");
    expect(init?.headers).toEqual({ authorization: `Bearer ${KEY}`, "content-type": "application/json" });
    expect(bodyOf(init)).toMatchObject({ model: "jev-1.14.0", state: RANK_STATE });
    const chunks = packChunks(rank, all);
    expect(calls.map(([, i]) => String(i?.body)).sort()).toEqual(chunks.map((c) => requestBody(rank, c)).sort());
  });

  it("keeps the per-call timeout an integer when the time left is fractional", async () => {
    // AbortSignal.timeout throws on a non-integer delay. After its first read this clock leaves
    // 4,999.5 ms (under PER_CALL_MS), so without the Math.floor every call would fail.
    const base = Date.now();
    let reads = 0;
    const t = deps(ok, { now: () => base + (reads++ === 0 ? 0 : 15_000.5) });
    const all = items(1_000);
    const out = await jevScore(rank, all, FULL, t.d);
    expect(t.fetch).toHaveBeenCalledTimes(packChunks(rank, all).length);
    expect(t.sleep).not.toHaveBeenCalled();
    expect(out.retry).toEqual([]);
    expect(out.scored.size).toBe(1_000);
  });

  it("retries a 529 once and then succeeds", async () => {
    let n = 0;
    const t = deps(async (url, init) => (n++ === 0 ? reply(529, { error: "overloaded" }) : ok(url, init)));
    const out = await jevScore(groups, items(10), FULL, t.d);
    expect(t.fetch).toHaveBeenCalledTimes(2);
    expect(t.sleep).toHaveBeenCalledTimes(1);
    expect(t.sleep.mock.calls[0]![0]).toBe(400); // 400 ms + random(0..300), random() = 0
    expect(out.scored.size).toBe(10);
    expect(out.scored.get(items(10)[0]!.id)).toMatchObject({ s: 700, n: 810 }); // fit 0.9 x (1 - P(None) 0.1)
  });

  it("honors retry-after when it fits the deadline", async () => {
    let n = 0;
    const t = deps(async (url, init) => (n++ === 0 ? reply(429, { error: "rate_limited" }, { "retry-after": "2" }) : ok(url, init)));
    const out = await jevScore(rank, items(3), FULL, t.d);
    expect(t.sleep.mock.calls[0]![0]).toBe(2_000);
    expect(out.retry).toEqual([]);
  });

  it("sends a chunk to retry when its retry-after does not fit the deadline", async () => {
    const all = items(1_000);
    const t = deps(async (url, init) =>
      firstName(init) === all[0]!.name ? reply(429, { error: "rate_limited" }, { "retry-after": "30" }) : ok(url, init),
    );
    const out = await jevScore(rank, all, FULL, t.d);
    const chunks = packChunks(rank, all);
    expect(t.fetch).toHaveBeenCalledTimes(chunks.length); // no second attempt
    expect(t.sleep).not.toHaveBeenCalled();
    expect(out.retry).toEqual(chunks[0]!.map((it) => it.id));
    expect(out.scored.size).toBe(1_000 - chunks[0]!.length);
  });

  it("does not retry with retries: 0", async () => {
    const all = items(1_000);
    const t = deps(async (url, init) => (firstName(init) === all[0]!.name ? reply(503, "") : ok(url, init)));
    const out = await jevScore(rank, all, { ...FULL, retries: 0 }, t.d);
    expect(t.fetch).toHaveBeenCalledTimes(packChunks(rank, all).length);
    expect(out.retry.length).toBeGreaterThan(0);
  });

  it("splits a request the model finds too long, down to depth 3", async () => {
    const tooLong = () => reply(400, { error: "max_tokens_exceeded", message: "Request is longer than the context length." });
    const fits = deps(async (url, init) => (Object.keys(bodyOf(init).questions).length > 50 ? tooLong() : ok(url, init)));
    const all = items(300);
    expect(packChunks(rank, all)).toHaveLength(1);
    const out = await jevScore(rank, all, FULL, fits.d);
    expect(out.scored.size).toBe(300);
    expect(fits.fetch).toHaveBeenCalledTimes(1 + 2 + 4 + 8); // 300 → 150 → 75 → 38: all fit
    expect(fits.sleep).not.toHaveBeenCalled(); // a split is not a retry

    const never = deps(async () => tooLong());
    await expect(jevScore(rank, all, FULL, never.d)).rejects.toBeInstanceOf(AiUnavailable);
    expect(never.fetch).toHaveBeenCalledTimes(15); // no 4th level

    const noSplit = deps(async () => tooLong());
    await expect(jevScore(rank, all, { ...FULL, split: false }, noSplit.d)).rejects.toBeInstanceOf(AiUnavailable);
    expect(noSplit.fetch).toHaveBeenCalledTimes(1);
  });

  it("treats a 401 as fatal and aborts the requests in flight", async () => {
    const all = items(1_000);
    const signals: AbortSignal[] = [];
    const t = deps(async (_url, init) => {
      if (firstName(init) === all[0]!.name) {
        await new Promise((r) => setTimeout(r, 5));
        return reply(401, { error: "unauthorized" });
      }
      const signal = init!.signal!;
      signals.push(signal);
      return new Promise<Response>((_, reject) => signal.addEventListener("abort", () => reject(signal.reason)));
    });
    await expect(jevScore(rank, all, FULL, t.d)).rejects.toBeInstanceOf(AiUnavailable);
    expect(signals.length).toBe(packChunks(rank, all).length - 1);
    expect(signals.every((s) => s.aborted)).toBe(true);
    expect(t.sleep).not.toHaveBeenCalled();
    expect(console.error).toHaveBeenCalledWith("[sort] jev fatal", 401);
  });

  it("treats other client errors (422) as fatal without retrying", async () => {
    const t = deps(async () => reply(422, { detail: [{ msg: "bad question", input: PROMPT }] }));
    await expect(jevScore(rank, items(5), FULL, t.d)).rejects.toBeInstanceOf(AiUnavailable);
    expect(t.fetch).toHaveBeenCalledTimes(1);
  });

  it("throws when every chunk fails, after one retry each", async () => {
    const t = deps(async () => {
      throw new TypeError("fetch failed");
    });
    await expect(jevScore(groups, items(10), FULL, t.d)).rejects.toBeInstanceOf(AiUnavailable);
    expect(t.fetch).toHaveBeenCalledTimes(2);
  });

  it("returns unusable answers as retry while keeping the rest", async () => {
    const all = items(4);
    const t = deps(async (_url, init) => {
      const res = answer(bodyOf(init).questions);
      delete res.answers.r1;
      res.answers.r2 = { score: 9 };
      return reply(200, res);
    });
    const out = await jevScore(rank, all, FULL, t.d);
    expect(out.retry).toEqual([all[1]!.id, all[2]!.id]);
    expect([...out.scored.keys()]).toEqual([all[0]!.id, all[3]!.id]);
  });

  it("never starts a chunk after the deadline: its ids come back in retry", async () => {
    const all = items(4_000);
    const chunks = packChunks(rank, all);
    expect(chunks.length).toBeGreaterThan(8);
    let clock = 0;
    const t = deps(
      async (url, init) => {
        const res = await ok(url, init);
        clock = 25_000; // the first wave lands after the 20 s deadline
        return res;
      },
      { now: () => clock },
    );
    const out = await jevScore(rank, all, FULL, t.d);
    expect(t.fetch).toHaveBeenCalledTimes(8); // POOL
    expect(out.retry).toEqual(chunks.slice(8).flat().map((it) => it.id));
    expect(out.scored.size).toBe(chunks.slice(0, 8).flat().length);
  });

  it("turns a missing key into AiUnavailable without calling the API", async () => {
    const t = deps(ok, {
      key: () => {
        throw new Error("Missing required env var TYPESAFE_API_KEY");
      },
    });
    await expect(jevScore(rank, items(3), FULL, t.d)).rejects.toBeInstanceOf(AiUnavailable);
    expect(t.fetch).not.toHaveBeenCalled();
  });

  it("does nothing for an empty list", async () => {
    const t = deps(ok);
    expect(await jevScore(rank, [], FULL, t.d)).toMatchObject({ scored: new Map(), retry: [], tokens: 0 });
    expect(t.fetch).not.toHaveBeenCalled();
  });

  it("never logs the key, the prompt or the group text", async () => {
    await jevScore(rank, items(20), FULL, deps(ok).d);
    await jevScore(groups, items(20), FULL, deps(ok).d);
    await jevScore(rank, items(20), FULL, deps(async () => reply(422, { input: PROMPT })).d).catch(() => {});
    await jevScore(groups, items(20), FULL, deps(async () => reply(500, { input: groups.groups })).d).catch(() => {});
    const logged = logs.flatMap((spy) => spy.mock.calls).map((args) => JSON.stringify(args));
    expect(logged.length).toBeGreaterThan(0);
    for (const line of logged) {
      expect(line).not.toContain("zqx");
      expect(line).not.toContain(KEY);
    }
    expect(console.info).toHaveBeenCalledWith(
      "[sort] jev",
      expect.objectContaining({ elements: 20, requests: 1, tokens: 100, retry: 0, promptChars: PROMPT.length }),
    );
  });
});
