// Live combine via OpenAI gpt-6-luna (Responses API, strict JSON schema, no reasoning).
// ~1.5 s p50 and ~$0.0001 per call (the long system prompt + few-shot turns are ~99% cached).
import OpenAI from "openai";
import type { ResponseInputItem } from "openai/resources/responses/responses";
import { env } from "../env.ts";
import { AiUnavailable, Fizzled, validateProposal, type AvoidResult, type ElementProposal } from "./common.ts";
import { COMBINE_FEWSHOT, COMBINE_SCHEMA, COMBINE_SYSTEM_PROMPT, buildCombineInput, buildCombineRetry } from "./prompts.ts";

export const COMBINE_MODEL = "gpt-6-luna";
/** Normal answers are ~75 tokens (incl. the private reasoning fields). */
const MAX_OUTPUT_TOKENS = 180;

// Time bounds. The client gives up on /api/combine at 15 s (src/app/lib/api.ts), and an answer
// stored after that never reaches it (a lost world-first celebration), so combine() as a whole
// stays under DEADLINE_MS and fails fast with AiUnavailable (503 ai_unavailable: "try again
// soon", which is right when the model was only slow) instead of retrying past it.
/** One model call (p50 ~1.5 s). The SDK does not retry on its own (maxRetries 0). */
export const CALL_TIMEOUT_MS = 6_000;
/** Total time combine() may take, the calls' timeouts included. */
export const DEADLINE_MS = 11_000;
/** A failed call (network, 408/409/429/5xx) is retried once, only if it failed this early. */
export const RETRY_FAILED_BEFORE_MS = 5_000;
/** An invalid answer gets its corrective retry only if it arrived this early. */
export const CORRECT_BEFORE_MS = 7_000;
/** Never start a call with less time than this left. */
const MIN_CALL_MS = 1_000;

let client: OpenAI | null = null;
function openai(): OpenAI {
  client ??= new OpenAI({ apiKey: env.openaiKey, timeout: CALL_TIMEOUT_MS, maxRetries: 0 });
  return client;
}

/** The errors the SDK itself would retry: connection problems and timeouts, 408, 409, 429, 5xx. */
function transient(e: unknown): boolean {
  const status = (e as { status?: number }).status;
  return status === undefined || status === 408 || status === 409 || status === 429 || status >= 500;
}

/**
 * Ask the model what `ingredientNames` make. Invalid answers (bad name, an ingredient
 * echoed back, a result a subset already makes, truncation, refusal) get ONE corrective
 * retry, then throw Fizzled. Provider failures, and running out of time for a retry (see the
 * time bounds above), throw AiUnavailable.
 */
export async function combine(ingredientNames: string[], safetyIdentifier: string, avoid: AvoidResult[] = []): Promise<ElementProposal> {
  const started = Date.now();
  const elapsed = () => Date.now() - started;
  const userMessage = buildCombineInput(ingredientNames);
  const input: ResponseInputItem[] = [...COMBINE_FEWSHOT, { role: "user", content: userMessage }];
  let reason = "no answer";
  let retriedFailure = false;
  for (let attempt = 0; attempt < 2; ) {
    const timeout = Math.min(CALL_TIMEOUT_MS, DEADLINE_MS - elapsed());
    if (timeout < MIN_CALL_MS) throw new AiUnavailable("combine ran out of time");
    let res: OpenAI.Responses.Response;
    try {
      res = await openai().responses.create(
        {
          model: COMBINE_MODEL,
          instructions: COMBINE_SYSTEM_PROMPT,
          input,
          text: {
            format: { type: "json_schema", name: "alchemy_element", schema: COMBINE_SCHEMA, strict: true },
            verbosity: "low",
          },
          reasoning: { effort: "none" },
          temperature: 0,
          max_output_tokens: MAX_OUTPUT_TOKENS,
          store: false,
          safety_identifier: safetyIdentifier,
        },
        { timeout },
      );
    } catch (e) {
      const err = e as { status?: number; code?: string | null; message?: string };
      console.warn("[llm] request failed", err.status ?? "", err.code ?? "", err.message ?? "", `${elapsed()}ms`);
      if (!retriedFailure && transient(e) && elapsed() < RETRY_FAILED_BEFORE_MS) {
        retriedFailure = true; // the same attempt again: a provider hiccup is not a bad answer
        continue;
      }
      throw new AiUnavailable("combine request failed", { cause: e });
    }

    const text = res.status === "completed" ? res.output_text : "";
    if (!text) {
      reason = `the answer was ${res.status === "completed" ? "empty" : `incomplete (${res.incomplete_details?.reason ?? res.status})`}`;
    } else {
      let parsed: unknown;
      try {
        parsed = JSON.parse(text);
      } catch {
        parsed = null;
      }
      const check = validateProposal(parsed, ingredientNames, avoid);
      if (check.ok) return check.proposal;
      reason = check.reason;
    }
    attempt++;
    if (attempt < 2 && elapsed() >= CORRECT_BEFORE_MS) {
      console.warn("[llm] no time for a corrective retry", `${elapsed()}ms`);
      throw new AiUnavailable("combine ran out of time for a corrective retry");
    }
    // An empty or cut-off answer is asked again as-is; an invalid one gets feedback.
    if (text) input.push({ role: "assistant", content: text }, { role: "user", content: buildCombineRetry([reason], userMessage) });
  }
  throw new Fizzled(reason);
}
