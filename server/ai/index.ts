// Entry points used by game code; picks the live or mock backend from AI_MODE.
import { env } from "../env.ts";
import type { AvoidResult, ElementProposal, GeneratedImage } from "./common.ts";
import { generate } from "./image.ts";
import { combine } from "./llm.ts";
import { mockCombine, mockImage } from "./mock.ts";

export { AiUnavailable, Blocked, Fizzled } from "./common.ts";
export type { AvoidResult, ElementProposal, GeneratedImage } from "./common.ts";

export async function proposeElement(
  ingredientNames: string[],
  safetyIdentifier: string,
  avoid: AvoidResult[] = [],
): Promise<ElementProposal> {
  return env.aiMode === "mock" ? mockCombine(ingredientNames) : combine(ingredientNames, safetyIdentifier, avoid);
}

/**
 * `hint`: the element's art hint (or description) to disambiguate the subject. `notable`: a proper
 * noun, drawn as the famous thing; everything else is drawn as the everyday thing it names.
 */
export async function paintElement(name: string, hint: string | null, notable: boolean, safetyIdentifier: string): Promise<GeneratedImage> {
  return env.aiMode === "mock" ? mockImage(name) : generate(name, hint, notable, safetyIdentifier);
}
