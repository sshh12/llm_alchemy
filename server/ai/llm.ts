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

let client: OpenAI | null = null;
function openai(): OpenAI {
  client ??= new OpenAI({ apiKey: env.openaiKey, timeout: 12_000, maxRetries: 1 });
  return client;
}

/**
 * Ask the model what `ingredientNames` make. Invalid answers (bad name, an ingredient
 * echoed back, a result a subset already makes, truncation, refusal) get ONE corrective
 * retry, then throw Fizzled. Provider failures throw AiUnavailable.
 */
export async function combine(ingredientNames: string[], safetyIdentifier: string, avoid: AvoidResult[] = []): Promise<ElementProposal> {
  const userMessage = buildCombineInput(ingredientNames);
  const input: ResponseInputItem[] = [...COMBINE_FEWSHOT, { role: "user", content: userMessage }];
  let reason = "no answer";
  for (let attempt = 0; attempt < 2; attempt++) {
    let res: OpenAI.Responses.Response;
    try {
      res = await openai().responses.create({
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
      });
    } catch (e) {
      const err = e as { status?: number; code?: string | null; message?: string };
      console.warn("[llm] request failed", err.status ?? "", err.code ?? "", err.message ?? "");
      throw new AiUnavailable("combine request failed", { cause: e });
    }

    const text = res.status === "completed" ? res.output_text : "";
    if (!text) {
      reason = `the answer was ${res.status === "completed" ? "empty" : `incomplete (${res.incomplete_details?.reason ?? res.status})`}`;
      continue;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = null;
    }
    const check = validateProposal(parsed, ingredientNames, avoid);
    if (check.ok) return check.proposal;
    reason = check.reason;
    input.push({ role: "assistant", content: text }, { role: "user", content: buildCombineRetry([reason], userMessage) });
  }
  throw new Fizzled(reason);
}
