// Live tile art via OpenAI gpt-image-2.5-flare (see research/image-models.md):
// 816x816 is the smallest accepted size; low quality, transparent webp ≈ $0.0053 and ~8 s.
// Thumbnails are produced downstream by Netlify Image CDN, so no native resize here.
import OpenAI from "openai";
import { env } from "../env.ts";
import { AiUnavailable, Blocked, type GeneratedImage } from "./common.ts";
import { buildImagePrompt, buildImagePromptFromHint, genericImageHint } from "./prompts.ts";

export const IMAGE_MODEL = "gpt-image-2.5-flare-2026-09-08";

let client: OpenAI | null = null;
function openai(): OpenAI {
  // One attempt per prompt within the 45 s DB lease; transient failures are retried by the
  // next /api/image request (up to 3 attempts per element), not by the SDK.
  client ??= new OpenAI({ apiKey: env.openaiKey, timeout: 20_000, maxRetries: 0 });
  return client;
}

const isWebp = (b: Uint8Array) =>
  b.length > 12 && String.fromCharCode(...b.subarray(0, 4)) === "RIFF" && String.fromCharCode(...b.subarray(8, 12)) === "WEBP";

async function render(prompt: string, safetyIdentifier: string): Promise<GeneratedImage> {
  let res: OpenAI.Images.ImagesResponse;
  try {
    res = await openai().images.generate({
      model: IMAGE_MODEL,
      prompt,
      n: 1,
      size: "816x816",
      quality: "low",
      background: "transparent",
      output_format: "webp",
      output_compression: 75,
      moderation: "auto",
      safety_identifier: safetyIdentifier,
    });
  } catch (e) {
    const err = e as { status?: number; code?: string | null; message?: string };
    if (err.code === "moderation_blocked") throw new Blocked();
    console.warn("[image] request failed", err.status ?? "", err.code ?? "", err.message ?? "");
    throw new AiUnavailable("image request failed", { cause: e });
  }
  const b64 = res.data?.[0]?.b64_json;
  const bytes = b64 ? new Uint8Array(Buffer.from(b64, "base64")) : new Uint8Array();
  if (!isWebp(bytes)) throw new AiUnavailable("image response had no webp data");
  return { bytes, ext: "webp", contentType: "image/webp" };
}

/**
 * Paint an element. If the safety system refuses the named subject (some trademarked
 * characters are refused by name), try once more drawing only the visual hint, or, without a
 * hint (legacy rows), a generic everyday-meaning phrase. A second refusal propagates as
 * Blocked, and only then is the element marked blocked.
 */
export async function generate(name: string, hint: string | null, notable: boolean, safetyIdentifier: string): Promise<GeneratedImage> {
  try {
    return await render(buildImagePrompt(name, hint, notable), safetyIdentifier);
  } catch (e) {
    if (!(e instanceof Blocked)) throw e;
    return render(buildImagePromptFromHint(hint ?? genericImageHint(name)), safetyIdentifier);
  }
}
