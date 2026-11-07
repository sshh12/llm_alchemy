// Anonymous sessions: a signed cookie naming the player and their session_version.
// Bumping players.session_version revokes every cookie and transfer code for that player.
import { q1, t, type Queryable } from "./db.ts";
import { env } from "./env.ts";
import { sign, verifySignature } from "./crypto.ts";
import { errors } from "./http.ts";

export const SESSION_COOKIE = "ia_session";
/** 400 days (the browser maximum); refreshed on every bootstrap. */
export const SESSION_MAX_AGE_S = 34_560_000;
const CLOCK_SKEW_MS = 5 * 60_000;
const TRANSFER_SIG_BYTES = 16;

export interface SessionClaims {
  /** Player id (INT8 as decimal string). */
  p: string;
  /** players.session_version at issue time. */
  v: number;
  /** Issued at (ms since epoch). */
  t: number;
}

const ID_RE = /^[1-9]\d{0,18}$/;

function validClaims(c: unknown): c is SessionClaims {
  const o = c as Partial<SessionClaims> | null;
  return (
    typeof o === "object" &&
    o !== null &&
    typeof o.p === "string" &&
    ID_RE.test(o.p) &&
    Number.isInteger(o.v) &&
    Number.isInteger(o.t)
  );
}

export function encodeSession(playerId: string, version: number, now = Date.now()): string {
  const payload = Buffer.from(JSON.stringify({ p: playerId, v: version, t: now } satisfies SessionClaims)).toString(
    "base64url",
  );
  return `${payload}.${sign("session", payload)}`;
}

export function decodeSession(value: string, now = Date.now()): SessionClaims | null {
  if (value.length > 512) return null;
  const dot = value.indexOf(".");
  if (dot <= 0) return null;
  const payload = value.slice(0, dot);
  if (!verifySignature("session", payload, value.slice(dot + 1))) return null;
  let claims: unknown;
  try {
    claims = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
  } catch {
    return null;
  }
  if (!validClaims(claims)) return null;
  if (claims.t > now + CLOCK_SKEW_MS || now - claims.t > SESSION_MAX_AGE_S * 1000) return null;
  return claims;
}

export function readCookie(req: Request, name: string): string | null {
  const header = req.headers.get("cookie");
  if (!header) return null;
  for (const part of header.split(";")) {
    const eq = part.indexOf("=");
    if (eq > 0 && part.slice(0, eq).trim() === name) return part.slice(eq + 1).trim();
  }
  return null;
}

/** `Set-Cookie` value. `Secure` is dropped only for plain-http local dev (WebKit rejects it there). */
export function sessionCookie(req: Request, value: string): string {
  const insecure = !env.isProduction && new URL(req.url).protocol === "http:";
  return [
    `${SESSION_COOKIE}=${value}`,
    "HttpOnly",
    ...(insecure ? [] : ["Secure"]),
    "SameSite=Lax",
    "Path=/",
    `Max-Age=${SESSION_MAX_AGE_S}`,
  ].join("; ");
}

export interface PlayerRow {
  id: string;
  public_id: string;
  legacy_user_id: string | null;
  created_at: Date;
  session_version: number;
  legacy_import_count: number;
}

export const PLAYER_COLS = "id, public_id, legacy_user_id, created_at, session_version, legacy_import_count";

export async function loadPlayer(id: string, client?: Queryable): Promise<PlayerRow | undefined> {
  return q1<PlayerRow>(`SELECT ${PLAYER_COLS} FROM ${t("players")} WHERE id = $1`, [id], client);
}

/** Verified (signature + age) claims of the session cookie, without a DB lookup. */
export function sessionClaims(req: Request): SessionClaims | null {
  const raw = readCookie(req, SESSION_COOKIE);
  return raw ? decodeSession(raw) : null;
}

/** The player behind signed claims, unless the session was revoked (session_version bumped). */
export async function playerForClaims(claims: SessionClaims): Promise<PlayerRow | null> {
  const player = await loadPlayer(claims.p);
  return player && player.session_version === claims.v ? player : null;
}

/** The player named by a valid, unrevoked session cookie, or null. */
export async function sessionPlayer(req: Request): Promise<PlayerRow | null> {
  const claims = sessionClaims(req);
  return claims ? playerForClaims(claims) : null;
}

export async function requirePlayer(req: Request): Promise<PlayerRow> {
  const player = await sessionPlayer(req);
  if (!player) throw errors.unauthorized();
  return player;
}

// ---------------------------------------------------------------- transfer codes

/** Compact signed `{p, v}`: `<playerId>.<version>.<sig>` (~45 chars, URL-safe). */
export function encodeTransferCode(playerId: string, version: number): string {
  const body = `${playerId}.${version}`;
  return `${body}.${sign("transfer", body, TRANSFER_SIG_BYTES)}`;
}

export function decodeTransferCode(code: string): { p: string; v: number } | null {
  const m = /^([1-9]\d{0,18})\.(\d{1,9})\.([A-Za-z0-9_-]{22})$/.exec(code.trim());
  if (!m) return null;
  const [, p, v, sig] = m as unknown as [string, string, string, string];
  if (!verifySignature("transfer", `${p}.${v}`, sig, TRANSFER_SIG_BYTES)) return null;
  return { p, v: Number(v) };
}
