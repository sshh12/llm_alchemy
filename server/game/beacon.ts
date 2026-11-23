// POST /api/beacon: a page load that ended before the game was playable (src/app/state/game.ts
// reportAbandon). First-party, so it counts visitors Google Analytics never sees (gtag loads
// after the window load event, and ad blockers drop it). It only adds 1 to a daily aggregate,
// stat "boot_abandon:<phase>:<band>:<ua class>": no identifier, no raw User-Agent, no IP. A page
// that comes back (visible again) after its abandon takes it back with the same phase and ms
// (`resumed`): stat "boot_resumed:<phase>:<band>:<ua class>". Being aggregate, the stats can't be
// matched up per page, so the pairs make the net: pages lost before ready = abandon - resumed.
//
// navigator.sendBeacon can't set the API header or send application/json without a CORS
// preflight, so this endpoint takes a text/plain JSON body and checks same-origin itself.
import type { Context } from "@netlify/functions";
import { z } from "zod";
import { BOOT_PHASES, latencyBand } from "../../src/shared/api.ts";
import { ApiError, clientIp, errors, ipHash, readJson } from "../http.ts";
import { LIMITS, bumpStat, enforce } from "../ratelimit.ts";
import { classifyUserAgent } from "../ua.ts";

/** `{"phase":"bootstrap2","ms":123456,"resumed":true}` is ~50 bytes. */
export const BODY_LIMIT_BEACON = 512;

export const BeaconSchema = z.object({
  phase: z.enum(BOOT_PHASES),
  ms: z.number().finite().nonnegative(),
  resumed: z.boolean().optional().catch(undefined),
});

/**
 * Same-origin by Sec-Fetch-Site (Chromium, Firefox, Safari 16.4+), else by an Origin header
 * naming this host (browsers send Origin on every POST). A request with neither is refused.
 */
export function beaconSameOrigin(req: Request): boolean {
  const site = req.headers.get("sec-fetch-site");
  if (site != null) return site === "same-origin";
  const origin = req.headers.get("origin");
  if (!origin) return false;
  let host: string;
  try {
    host = new URL(origin).host;
  } catch {
    return false; // includes the opaque "null" origin
  }
  return host === new URL(req.url).host || host === req.headers.get("host");
}

export async function bootBeacon(req: Request, context: Context): Promise<Response> {
  if (req.method !== "POST") throw new ApiError(405, "bad_request", "Use POST.");
  if (!beaconSameOrigin(req)) throw errors.forbidden("Cross-origin request.");
  // What sendBeacon sends for a string body.
  if (!/^text\/plain(\s*;|$)/i.test(req.headers.get("content-type") ?? "")) {
    throw new ApiError(415, "bad_request", "Content-Type must be text/plain.");
  }
  const body = await readJson(req, BeaconSchema, BODY_LIMIT_BEACON);
  await enforce([{ limit: LIMITS.beaconIp, subject: ipHash(clientIp(req, context)) }]);
  const family = body.resumed === true ? "boot_resumed" : "boot_abandon";
  await bumpStat(`${family}:${body.phase}:${latencyBand(body.ms)}:${classifyUserAgent(req.headers.get("user-agent"))}`);
  return new Response(null, { status: 204, headers: { "cache-control": "no-store" } });
}
