// Returning players from the 2023 app. The old client stored:
//   localStorage['alchemy:userId'] = '{"value":"alchemy:<uuid>"}'
//   localStorage['elements']       = JSON array of legacy element objects ({ id: "123…", name, … })
// We send both with bootstrap until the server confirms an import, then remember that in
// 'ia:legacyImported'. The legacy keys are NEVER deleted or rewritten.
import { MAX_LEGACY_IDS, type LegacyPayload } from "../../shared/api.ts";
import { readString, writeString } from "./storage.ts";

export const LEGACY_USER_KEY = "alchemy:userId";
export const LEGACY_ELEMENTS_KEY = "elements";
export const LEGACY_IMPORTED_KEY = "ia:legacyImported";
/** Marker stored when legacy elements existed without a user id. */
const ANONYMOUS_MARKER = "anonymous";

export interface LegacyState {
  payload: LegacyPayload;
  /** Value written to 'ia:legacyImported' after a confirmed import. */
  marker: string;
}

type Getter = (key: string) => string | null;

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

/** Legacy progress that still needs importing, or null if there is none / it was imported. */
export function readLegacy(get: Getter = (k) => readString(k)): LegacyState | null {
  const userId = legacyUserId(get);
  const elementIds = legacyElementIds(get);
  if (!userId && elementIds.length === 0) return null;
  const marker = userId ?? ANONYMOUS_MARKER;
  if (get(LEGACY_IMPORTED_KEY) === marker) return null;
  return { payload: { userId, elementIds }, marker };
}

export function markLegacyImported(marker: string): void {
  writeString(LEGACY_IMPORTED_KEY, marker);
}
