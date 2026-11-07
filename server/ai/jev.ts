// Live custom-sort scorer: TypeSafe's Jev ("System One") decision model, called with raw fetch.
// No SDK: it retries 429/529 on its own, which could overrun our deadline.
//
// One question per element (rank: a `score` over 5 generic levels) or two (groups: a `choice`
// over the groups plus a last "None of these groups" option, and a companion `noul` "clearly
// belongs in one of these groups?"; the None probability discounts the fit). The element name and
// the player's text travel as JSON data fields inside `instructions`, never as instruction text,
// and the fixed `state` names no element (measured: listing elements in `state` scored worse).
// Any change to a string here moves scores: re-run the sort eval and bump SORT_RUBRIC.
// Questions are packed into requests by a token estimate, POOL requests run in parallel, and a
// request the model finds too long is split. Chunks that still fail come back in `retry`.
//
// Never log the key, the prompt or the group text: lengths and counts only.
import { SORT_RUBRIC, type ElementId, type SortScore, type SortSpec } from "../../src/shared/api.ts";
import { fnv1a } from "../../src/shared/hash.ts";
import { questionsPer } from "../../src/shared/sortSpec.ts";
import { env } from "../env.ts";
import { AiUnavailable } from "./common.ts";

export interface ScoreItem {
  id: ElementId;
  name: string;
}

export interface ScoreOpts {
  /** Wall-clock budget for the whole call, retries included. */
  deadlineMs: number;
  /** Extra attempts per request after a transient failure (429, 529, 5xx, network, timeout). */
  retries: 0 | 1;
  /** Split a request the model rejects as too long (`max_tokens_exceeded`). */
  split: boolean;
}

export interface ScoreOutcome {
  engine: string;
  scored: Map<ElementId, SortScore>;
  /** Not scored this time (provider hiccup, deadline, unusable answer): ask again later. */
  retry: ElementId[];
  /** Input tokens reported by the provider. */
  tokens: number;
}

/** Pinned like COMBINE_MODEL/IMAGE_MODEL, never "jev-latest": a model change must bump SORT_RUBRIC. */
export const SORT_MODEL = "jev-1.14.0";
/** Exported for scripts/eval-sort.ts, which sends the same bodies to the same endpoint. */
export const JEV_URL = "https://api.typesafe.ai/v1/systemone";
/** Groups requests. */
const STATE = "Elements from an alchemy crafting game. Each question is about one element, given by name.";
/**
 * Rank requests only (rubric r2): the player's goal plus "read each name as the real thing". It
 * fixes the association reading of size, weight and age prompts (eval holdout P@10 0.64 → 0.76;
 * "Oldest" went from Earth, Fire, Stone first to Big Bang, Universe, Time). Billed once per request.
 */
const RANK_STATE =
  "A player of an alchemy crafting game is sorting the elements they own by a sort description they typed, best fits first. " +
  "Each question is about one element, given by name. Read each name as the real thing it usually names, and judge that thing.";
/** Situations, low → high (Jev reads bare numbers poorly). Answer `score` is the expected level 0..4. */
export const RANK_LEVELS = [
  "Does not match at all",
  "Matches a little",
  "Matches somewhat",
  "Matches clearly",
  "A perfect, textbook match",
];
const RANK_Q = "How well does this element match the sort description?";
const CHOICE_Q = "Which group does this element belong in?";
const FIT_Q = "Does this element clearly belong in one of these groups?";
/**
 * Groups (r2): a last choice option, never rotated. Its probability discounts the fit, so weak fits
 * sink inside their group and more of them reach Other (eval label errors 30 → 17 of 1,073).
 */
const NONE_ID = "gx";
const NONE_OPTION = "None of these groups";

/** Requests in flight at once. */
const POOL = 8;
/** Per request: at most this many questions and this many estimated tokens (Jev allows 64k). */
const MAX_Q = 400;
const MAX_EST = 40_000;
/** Estimated tokens of a request's envelope (model, state, braces). */
const OVERHEAD = 300;
const PER_CALL_MS = 8_000;
/** A retry is only worth starting with at least this much of the deadline left after its wait. */
const MIN_LEFT_FOR_RETRY = 1_500;
/** Below this much time left a request is not started at all (it could only time out). */
const MIN_CALL_MS = 100;
const MAX_SPLIT_DEPTH = 3;

export const engineId = () => `${SORT_MODEL}/${SORT_RUBRIC}`;

/** Questions for item `it` at index `k` inside its request. */
export function questionsFor(spec: SortSpec, it: ScoreItem, k: number): Record<string, object> {
  if (spec.kind === "rank") {
    return {
      [`r${k}`]: {
        type: "score",
        instructions: { question: RANK_Q, sort_description: spec.prompt, element: it.name },
        criteria: RANK_LEVELS,
      },
    };
  }
  // Jev favors the first option, so rotate the option order per element. The rotation hangs off
  // the id (not the position), so a whole-library run and a one-element rescore ask the same thing.
  const n = spec.groups.length;
  const rot = fnv1a(it.id) % n;
  const criteria: Record<string, string> = Object.fromEntries(
    spec.groups.map((_, j) => (j + rot) % n).map((j) => [`g${j}`, spec.groups[j]!]),
  );
  criteria[NONE_ID] = NONE_OPTION; // always last: non-integer keys keep insertion order
  return {
    [`c${k}`]: { type: "choice", instructions: { question: CHOICE_Q, element: it.name }, criteria },
    [`n${k}`]: { type: "noul", instructions: { question: FIT_Q, groups: spec.groups, element: it.name } },
  };
}

/** The exact body of one request: jevScore sends it, and the sort eval hashes it for its cache. */
export function requestBody(spec: SortSpec, chunk: readonly ScoreItem[]): string {
  const questions: Json = Object.assign({}, ...chunk.map((it, k) => questionsFor(spec, it, k)));
  return JSON.stringify({ model: SORT_MODEL, state: spec.kind === "rank" ? RANK_STATE : STATE, questions });
}

/** Conservative token estimate (measured ~2.9 chars/token for these questions). */
export const est = (q: object) => Math.ceil(JSON.stringify(q).length / 2.5);

/**
 * Greedy packing in input order: OVERHEAD + Σest ≤ MAX_EST and ≤ MAX_Q questions per request.
 * An element's questions never split across requests; a request always holds at least one.
 */
export function packChunks(spec: SortSpec, items: readonly ScoreItem[]): ScoreItem[][] {
  const per = questionsPer(spec);
  const chunks: ScoreItem[][] = [];
  let cur: ScoreItem[] = [];
  let tokens = OVERHEAD;
  for (const it of items) {
    let cost = est(questionsFor(spec, it, cur.length));
    if (cur.length > 0 && (tokens + cost > MAX_EST || (cur.length + 1) * per > MAX_Q)) {
      chunks.push(cur);
      cur = [];
      tokens = OVERHEAD;
      cost = est(questionsFor(spec, it, 0));
    }
    cur.push(it);
    tokens += cost;
  }
  if (cur.length > 0) chunks.push(cur);
  return chunks;
}

type Json = Record<string, unknown>;
const obj = (v: unknown): Json | undefined => (v && typeof v === "object" ? (v as Json) : undefined);
const unit = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v) && v >= 0 && v <= 1;

function rankScore(a: unknown): SortScore | null {
  const score = obj(a)?.score;
  if (typeof score !== "number" || !Number.isFinite(score) || score < 0 || score > RANK_LEVELS.length - 1) return null;
  return { s: Math.round((score / (RANK_LEVELS.length - 1)) * 1000) };
}

/**
 * `g`: the chosen group, or the most likely real group (first on ties) when Jev chose None, which
 * it does for about 45% of elements. `s`: that group's probability, None's mass included.
 * `n`: fit × (1 − P(None)). Every group's and None's probability is required (no `confidence`
 * fallback): without them neither `g` on a None answer nor the discount is defined.
 */
function groupScore(c: unknown, f: unknown, groups: number): SortScore | null {
  const choice = obj(c);
  const id = choice?.choice;
  const probs = obj(choice?.probabilities);
  const fit = obj(f)?.noul;
  if (typeof id !== "string" || !probs || !unit(fit)) return null;
  const ps: number[] = [];
  for (let j = 0; j < groups; j++) {
    const p = probs[`g${j}`];
    if (!unit(p)) return null;
    ps.push(p);
  }
  const pNone = probs[NONE_ID];
  if (!unit(pNone)) return null;
  const m = /^g(0|[1-9]\d*)$/.exec(id);
  let g = m ? Number(m[1]) : -1;
  if (g >= groups) return null;
  if (g < 0) {
    if (id !== NONE_ID) return null;
    g = 0;
    for (let j = 1; j < groups; j++) if (ps[j]! > ps[g]!) g = j;
  }
  return { s: Math.round(1000 * ps[g]!), g, n: Math.round(1000 * fit * (1 - pNone)) };
}

/** Parse one request's answers. A missing or invalid answer sends the element to `retry`. */
export function parseChunk(
  spec: SortSpec,
  chunk: readonly ScoreItem[],
  answers: unknown,
): { scored: Map<ElementId, SortScore>; retry: ElementId[] } {
  const a = obj(answers) ?? {};
  const scored = new Map<ElementId, SortScore>();
  const retry: ElementId[] = [];
  chunk.forEach((it, k) => {
    const sc = spec.kind === "rank" ? rankScore(a[`r${k}`]) : groupScore(a[`c${k}`], a[`n${k}`], spec.groups.length);
    if (sc) scored.set(it.id, sc);
    else retry.push(it.id);
  });
  return { scored, retry };
}

export interface JevDeps {
  fetch: typeof globalThis.fetch;
  now: () => number;
  key: () => string;
  /** Resolves after `ms`, or early when `signal` aborts. */
  sleep: (ms: number, signal: AbortSignal) => Promise<void>;
  random: () => number;
}

const sleep = (ms: number, signal: AbortSignal) =>
  new Promise<void>((resolve) => {
    const timer = setTimeout(done, ms);
    function done() {
      clearTimeout(timer);
      signal.removeEventListener("abort", done);
      resolve();
    }
    signal.addEventListener("abort", done, { once: true });
  });

const DEFAULT_DEPS: JevDeps = {
  fetch: (input, init) => globalThis.fetch(input, init),
  now: Date.now,
  key: () => env.typesafeKey,
  sleep,
  random: Math.random,
};

/** `retry-after` as delta-seconds or an HTTP date, in ms; undefined when absent or unparsable. */
function retryAfterMs(header: string | null, now: number): number | undefined {
  if (!header) return undefined;
  const secs = Number(header);
  if (Number.isFinite(secs) && secs >= 0) return secs * 1000;
  const at = Date.parse(header);
  return Number.isFinite(at) ? Math.max(0, at - now) : undefined;
}

type CallResult =
  | { kind: "ok"; answers: unknown; tokens: number }
  | { kind: "split" }
  | { kind: "transient"; waitMs?: number }
  | { kind: "fatal"; status: number };

interface Job {
  chunk: ScoreItem[];
  depth: number;
}

/**
 * Score `items` against `spec`. Every input id ends up in `scored` or in `retry`. Throws
 * AiUnavailable when the key is missing, on a non-retryable provider error (bad request, auth),
 * or when nothing at all could be scored.
 */
export async function jevScore(
  spec: SortSpec,
  items: readonly ScoreItem[],
  opts: ScoreOpts,
  deps: Partial<JevDeps> = {},
): Promise<ScoreOutcome> {
  const d: JevDeps = { ...DEFAULT_DEPS, ...deps };
  const started = d.now();
  const deadline = started + opts.deadlineMs;
  const unique = [...new Map(items.map((it) => [it.id, it])).values()];
  const scored = new Map<ElementId, SortScore>();
  if (unique.length === 0) return { engine: engineId(), scored, retry: [], tokens: 0 };

  let key: string;
  try {
    key = d.key();
  } catch {
    throw new AiUnavailable("jev: TYPESAFE_API_KEY is not set");
  }

  const fatal = new AbortController();
  let fatalStatus = null as number | null; // set by a worker (the cast keeps TS from narrowing it to null)
  let requests = 0;
  let tokens = 0;
  let retried = 0;

  const call = async (chunk: ScoreItem[], leftMs: number): Promise<CallResult> => {
    requests++;
    let res: Response;
    try {
      res = await d.fetch(JEV_URL, {
        method: "POST",
        headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
        body: requestBody(spec, chunk),
        // AbortSignal.timeout throws on a non-integer delay, which would read as a transient failure.
        signal: AbortSignal.any([AbortSignal.timeout(Math.floor(Math.min(PER_CALL_MS, leftMs))), fatal.signal]),
      });
      if (res.ok) {
        const body = obj(await res.json());
        const used = obj(body?.usage)?.input_tokens;
        return { kind: "ok", answers: body?.answers, tokens: typeof used === "number" && Number.isFinite(used) ? used : 0 };
      }
    } catch {
      return { kind: "transient" }; // network error, timeout, unreadable body (or our own fatal abort)
    }
    // The body is only inspected for the error code; never logged (a 422 may echo the input).
    const text = await res.text().catch(() => "");
    if (res.status === 400 && text.includes("max_tokens_exceeded")) return { kind: "split" };
    if (res.status === 408 || res.status === 429 || res.status >= 500) {
      return { kind: "transient", waitMs: retryAfterMs(res.headers.get("retry-after"), d.now()) };
    }
    return { kind: "fatal", status: res.status };
  };

  const queue: Job[] = packChunks(spec, unique).map((chunk) => ({ chunk, depth: 0 }));

  const run = async (job: Job): Promise<void> => {
    for (let attempt = 0; ; attempt++) {
      const left = deadline - d.now();
      if (fatal.signal.aborted || left < MIN_CALL_MS) return; // never started: its ids go to retry
      const r = await call(job.chunk, left);
      if (fatal.signal.aborted) return;
      if (r.kind === "ok") {
        tokens += r.tokens;
        for (const [id, sc] of parseChunk(spec, job.chunk, r.answers).scored) scored.set(id, sc);
        return;
      }
      if (r.kind === "split") {
        if (opts.split && job.chunk.length > 1 && job.depth < MAX_SPLIT_DEPTH) {
          const half = Math.ceil(job.chunk.length / 2);
          queue.push({ chunk: job.chunk.slice(0, half), depth: job.depth + 1 });
          queue.push({ chunk: job.chunk.slice(half), depth: job.depth + 1 });
        }
        return;
      }
      if (r.kind === "fatal") {
        fatalStatus = r.status;
        fatal.abort();
        console.error("[sort] jev fatal", r.status);
        return;
      }
      const wait = r.waitMs ?? 400 + d.random() * 300;
      if (attempt >= opts.retries || deadline - d.now() - wait < MIN_LEFT_FOR_RETRY) return;
      retried++;
      await d.sleep(wait, fatal.signal);
    }
  };

  // A pool rather than fixed workers: a split pushes new jobs after the queue may have drained.
  await new Promise<void>((resolve) => {
    let active = 0;
    const pump = () => {
      if (fatal.signal.aborted) queue.length = 0;
      while (active < POOL && queue.length > 0) {
        const job = queue.shift()!;
        active++;
        run(job)
          .catch((e: unknown) => console.error("[sort] jev worker failed", (e as Error)?.name))
          .finally(() => {
            active--;
            pump();
          });
      }
      if (active === 0 && queue.length === 0) resolve();
    };
    pump();
  });

  const retry = unique.filter((it) => !scored.has(it.id)).map((it) => it.id);
  console.info("[sort] jev", {
    elements: unique.length,
    requests,
    tokens,
    ms: d.now() - started,
    retried,
    retry: retry.length,
    promptChars: spec.kind === "rank" ? spec.prompt.length : spec.groups.reduce((n, g) => n + g.length, 0),
  });
  if (fatalStatus != null) throw new AiUnavailable(`jev: provider rejected the request (${fatalStatus})`);
  if (scored.size === 0) throw new AiUnavailable("jev: nothing could be scored");
  return { engine: engineId(), scored, retry, tokens };
}
