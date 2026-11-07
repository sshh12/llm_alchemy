// HTTP plumbing shared by every Netlify Function: JSON responses, typed API errors,
// size-capped body parsing with zod, CSRF checks, client IP extraction, and the
// top-level error wrapper that keeps internals (stacks, SQL) out of responses.
import type { Context } from "@netlify/functions";
import type { z } from "zod";
import { API_HEADER, type ApiError as ApiErrorBody, type ApiErrorCode, type PowChallenge } from "../src/shared/api.ts";
import { sign } from "./crypto.ts";

/**
 * Body caps. Bootstrap carries a legacy inventory (up to 20k ids) and a sort up to
 * SORT_IDS_MAX ids (1,000 × ~22 B plus the spec); everything else is tiny.
 */
export const BODY_LIMIT_BOOTSTRAP = 1_048_576;
export const BODY_LIMIT_SORT = 32_768;
export const BODY_LIMIT_DEFAULT = 8_192;

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: ApiErrorCode,
    message: string,
    readonly extra: { retryAfterMs?: number; pow?: PowChallenge } = {},
  ) {
    super(message);
    this.name = "ApiError";
  }
}

export const errors = {
  badRequest: (message = "Invalid request.") => new ApiError(400, "bad_request", message),
  tooLarge: () => new ApiError(413, "bad_request", "Request body is too large."),
  unauthorized: (message = "No valid session. Reload the page.") => new ApiError(401, "unauthorized", message),
  powRequired: (pow: PowChallenge, message = "Solve the proof-of-work challenge to start playing.") =>
    new ApiError(401, "pow_required", message, { pow }),
  forbidden: (message = "Not allowed.") => new ApiError(403, "forbidden", message),
  notOwned: () => new ApiError(403, "not_owned", "You can only combine elements in your library."),
  notFound: (message = "Not found.") => new ApiError(404, "not_found", message),
  rateLimited: (retryAfterMs: number) =>
    new ApiError(429, "rate_limited", "Easy there, alchemist. Try again in a moment.", { retryAfterMs }),
  budgetExhausted: (retryAfterMs?: number) =>
    new ApiError(503, "budget_exhausted", "The lab is out of fresh ideas for today. Known recipes still work.", {
      retryAfterMs,
    }),
  /** BUDGETS.jev ran out: only custom sorting stops (the combine copy would be wrong here). */
  sortBudget: (retryAfterMs?: number) =>
    new ApiError(503, "budget_exhausted", "Custom sorting is resting until tomorrow. Your other sorts still work.", {
      retryAfterMs,
    }),
  fizzled: () => new ApiError(422, "fizzled", "That mix fizzled. Try again."),
  aiUnavailable: () => new ApiError(503, "ai_unavailable", "The alchemist is unavailable right now. Try again soon."),
  serverError: () => new ApiError(500, "server_error", "Something went wrong. Please try again."),
};

const BASE_HEADERS = {
  "content-type": "application/json; charset=utf-8",
  "cache-control": "no-store",
  "x-content-type-options": "nosniff",
};

/** Bodies above this are streamed: buffered function responses are capped at 6 MB, streamed ones at 20 MB. */
const STREAM_THRESHOLD = 4_000_000;
const STREAM_CHUNK = 65_536;

export function json(body: unknown, init: { status?: number; headers?: HeadersInit } = {}): Response {
  const headers = new Headers(BASE_HEADERS);
  new Headers(init.headers).forEach((v, k) => headers.append(k, v));
  const text = JSON.stringify(body);
  if (text.length <= STREAM_THRESHOLD) return new Response(text, { status: init.status ?? 200, headers });
  const bytes = new TextEncoder().encode(text);
  let offset = 0;
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      controller.enqueue(bytes.subarray(offset, offset + STREAM_CHUNK));
      offset += STREAM_CHUNK;
      if (offset >= bytes.length) controller.close();
    },
  });
  return new Response(stream, { status: init.status ?? 200, headers });
}

export function errorResponse(e: ApiError): Response {
  const body: ApiErrorBody = { error: e.code, message: e.message, ...e.extra };
  const headers: Record<string, string> = {};
  if (e.extra.retryAfterMs != null) headers["retry-after"] = String(Math.max(1, Math.ceil(e.extra.retryAfterMs / 1000)));
  return json(body, { status: e.status, headers });
}

/** Origin matches the requested host (by URL, or the Host header in case a proxy rewrote the URL). */
function sameOrigin(origin: string, req: Request): boolean {
  let host: string;
  try {
    host = new URL(origin).host;
  } catch {
    return false; // includes the opaque "null" origin
  }
  return host === new URL(req.url).host || host === req.headers.get("host");
}

/**
 * Reject cross-site and non-app requests. The custom header alone forces a CORS
 * preflight (which we never answer), and Origin / Sec-Fetch-Site catch the rest.
 */
export function checkCsrf(req: Request): void {
  if (req.method !== "POST") throw new ApiError(405, "bad_request", "Use POST.");
  if (req.headers.get(API_HEADER) !== "1") throw errors.forbidden("Missing client header.");
  const type = req.headers.get("content-type") ?? "";
  if (!/^application\/json(\s*;|$)/i.test(type)) throw new ApiError(415, "bad_request", "Content-Type must be application/json.");
  const origin = req.headers.get("origin");
  if (origin != null && !sameOrigin(origin, req)) throw errors.forbidden("Cross-origin request.");
  const site = req.headers.get("sec-fetch-site");
  if (site != null && site !== "same-origin" && site !== "none") throw errors.forbidden("Cross-site request.");
}

/** Read at most `maxBytes` of the body (never trusting Content-Length alone), then validate. */
export async function readJson<S extends z.ZodType>(req: Request, schema: S, maxBytes: number): Promise<z.infer<S>> {
  const declared = Number(req.headers.get("content-length") ?? "0");
  if (declared > maxBytes) throw errors.tooLarge();
  const chunks: Uint8Array[] = [];
  let total = 0;
  if (req.body) {
    const reader = req.body.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel().catch(() => {});
        throw errors.tooLarge();
      }
      chunks.push(value);
    }
  }
  let data: unknown;
  try {
    data = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw errors.badRequest("Body must be valid JSON.");
  }
  const parsed = schema.safeParse(data);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    const where = issue?.path.length ? `${issue.path.join(".")}: ` : "";
    throw errors.badRequest(`Invalid request: ${where}${issue?.message ?? "bad input"}`);
  }
  return parsed.data;
}

/** Client IP as seen by Netlify's edge. */
export function clientIp(req: Request, context: Pick<Context, "ip"> | undefined): string {
  return context?.ip || req.headers.get("x-nf-client-connection-ip") || "0.0.0.0";
}

/**
 * Collapse an IPv6 address to its /64 network (one subscriber usually owns a whole /64,
 * so per-address limits would be trivially rotated). IPv4 and unparsable input pass through.
 */
export function ipNetwork(ip: string): string {
  const addr = ip.trim().toLowerCase().replace(/^\[|\]$/g, "").replace(/%.*$/, "");
  if (!addr.includes(":")) return addr;
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(addr);
  if (mapped) return mapped[1]!;
  const [head = "", tail] = addr.split("::");
  const left = head ? head.split(":") : [];
  const right = tail ? tail.split(":") : [];
  const groups = tail === undefined ? left : [...left, ...Array(Math.max(0, 8 - left.length - right.length)).fill("0"), ...right];
  return `${groups
    .slice(0, 4)
    .map((g) => (g || "0").replace(/^0+(?=.)/, ""))
    .join(":")}::/64`;
}

/** Keyed hash of the client network: usable as a rate-limit subject without storing raw IPs. */
export function ipHash(ip: string): string {
  return sign("ip", ipNetwork(ip), 16);
}

export type Handler = (req: Request, context: Context) => Promise<Response>;

/** Top-level wrapper: ApiErrors become their JSON shape; anything else is logged and becomes a generic 500. */
export function route(name: string, fn: Handler): Handler {
  return async (req, context) => {
    try {
      return await fn(req, context);
    } catch (e) {
      if (e instanceof ApiError) return errorResponse(e);
      console.error(`[${name}] unhandled error`, e);
      return errorResponse(errors.serverError());
    }
  };
}
