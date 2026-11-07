// Returning players from the 2023 app. The old client stored:
//   localStorage['alchemy:userId'] = '{"value":"alchemy:<uuid>"}'
//   localStorage['elements']       = JSON array of legacy element objects ({ id: "123…", name, … })
// We send both with bootstrap until the server confirms an import, then remember that in
// 'ia:legacyImported'. The legacy keys are NEVER deleted or rewritten.
//
// Adopt-once: legacy user ids were public (the 2023 API returned every element's creator), so
// the first browser to present one binds that player to its claim token ('ia:legacyClaim', 32
// random hex chars, sent as payload.claim). The token is stored BEFORE the request goes out:
// if the response is lost after the server bound the player, the retry carries the same token
// and adopts it again instead of locking the real owner out on their own device.
import { MAX_LEGACY_IDS, type LegacyPayload } from "../../shared/api.ts";
import { readString, writeString } from "./storage.ts";

export const LEGACY_USER_KEY = "alchemy:userId";
export const LEGACY_ELEMENTS_KEY = "elements";
export const LEGACY_IMPORTED_KEY = "ia:legacyImported";
export const LEGACY_CLAIM_KEY = "ia:legacyClaim";
/** Marker stored when legacy elements existed without a user id. */
const ANONYMOUS_MARKER = "anonymous";

export interface LegacyState {
  payload: LegacyPayload;
  /** Value written to 'ia:legacyImported' after a confirmed import. */
  marker: string;
}

type Getter = (key: string) => string | null;
type Setter = (key: string, value: string) => void;

const CLAIM_RE = /^[0-9a-f]{32}$/;

function newClaim(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

/** This browser's claim token: the stored one, or a fresh one written before it is used. */
function claimToken(get: Getter, set: Setter): string {
  const stored = get(LEGACY_CLAIM_KEY);
  if (stored && CLAIM_RE.test(stored)) return stored;
  const claim = newClaim();
  set(LEGACY_CLAIM_KEY, claim);
  return claim;
}

function parse(raw: string | null): unknown {
  if (raw == null) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function legacyUserId(get: Getter): string | null {
  const v = parse(get(LEGACY_USER_KEY));
  const value = v && typeof v === "object" ? (v as { value?: unknown }).value : null;
  // The server validates the exact shape; we only reject obvious garbage.
  return typeof value === "string" && value.length > 0 && value.length <= 128 ? value : null;
}

function legacyElementIds(get: Getter): string[] {
  const list = parse(get(LEGACY_ELEMENTS_KEY));
  if (!Array.isArray(list)) return [];
  const ids = new Set<string>();
  for (const item of list) {
    let id: unknown = item && typeof item === "object" ? (item as { id?: unknown }).id : item;
    if (typeof id === "number" && Number.isSafeInteger(id) && id >= 0) id = String(id);
    if (typeof id === "string" && /^\d{1,20}$/.test(id)) ids.add(id.replace(/^0+(?=\d)/, ""));
    if (ids.size >= MAX_LEGACY_IDS) break;
  }
  return [...ids];
}

/**
 * Legacy progress that still needs importing, or null if there is none / it was imported.
 * With a legacy user id it also gets (or creates and stores) this browser's claim token.
 */
export function readLegacy(get: Getter = (k) => readString(k), set: Setter = (k, v) => writeString(k, v)): LegacyState | null {
  const userId = legacyUserId(get);
  const elementIds = legacyElementIds(get);
  if (!userId && elementIds.length === 0) return null;
  const marker = userId ?? ANONYMOUS_MARKER;
  if (get(LEGACY_IMPORTED_KEY) === marker) return null;
  if (!userId) return { payload: { userId, elementIds }, marker };
  return { payload: { userId, elementIds, claim: claimToken(get, set) }, marker };
}

export function markLegacyImported(marker: string): void {
  writeString(LEGACY_IMPORTED_KEY, marker);
}
