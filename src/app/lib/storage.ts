// Defensive Web Storage access. Storage can throw (Safari private mode, disabled cookies,
// quota) or hold garbage written by older builds, so every call is wrapped and typed reads
// fall back to a default.

type Area = "local" | "session";

function area(which: Area): Storage | null {
  try {
    return which === "local" ? window.localStorage : window.sessionStorage;
  } catch {
    return null;
  }
}

export function readString(key: string, which: Area = "local"): string | null {
  try {
    return area(which)?.getItem(key) ?? null;
  } catch {
    return null;
  }
}

export function writeString(key: string, value: string, which: Area = "local"): void {
  try {
    area(which)?.setItem(key, value);
  } catch {
    // Quota or privacy mode: persistence is best-effort.
  }
}

export function removeKey(key: string, which: Area = "local"): void {
  try {
    area(which)?.removeItem(key);
  } catch {
    // ignore
  }
}

/** Parse JSON stored under `key`; returns `fallback` when missing or unparsable. */
export function readJSON<T>(key: string, fallback: T, which: Area = "local"): T {
  const raw = readString(key, which);
  if (raw == null) return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

export function writeJSON(key: string, value: unknown, which: Area = "local"): void {
  try {
    writeString(key, JSON.stringify(value), which);
  } catch {
    // JSON.stringify can throw on cycles; never let persistence crash the game.
  }
}

/** Storage keys owned by the v2 client (legacy keys live in legacy.ts and are never written). */
export const KEYS = {
  canvas: "ia:canvas",
  pins: "ia:pins",
  settings: "ia:settings",
  recipes: "ia:recipes",
  onboarded: "ia:onboarded",
  merged: "ia:hasMerged",
  undo: "ia:undo",
  libraryView: "ia:libraryView",
  /** Custom library sort preferences: spec, view toggles, recents (~1 KB; never scores). */
  customSort: "ia:customSort",
  /** sessionStorage: the active custom sort's scores, tagged with player id, spec key and rubric. */
  customSortScores: "ia:customSortScores",
} as const;
