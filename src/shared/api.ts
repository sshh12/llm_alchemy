// Shared HTTP contract between the SPA (src/app) and Netlify Functions (netlify/functions).
// All ids are INT8 values serialized as decimal strings. All POST bodies are JSON and
// must carry the header `x-ia-client: 1` (CSRF guard). Dates are 'YYYY-MM-DD'.

export type ElementId = string;
export type Tier = "easy" | "hard" | "expert";
export type Rarity = "common" | "uncommon" | "rare" | "epic" | "legendary";

/** How an element looks/behaves in the UI. */
export interface ElementDTO {
  id: ElementId;
  /** Display name, already cased (e.g. "Steam", "Isaac Newton"). */
  name: string;
  /** Single emoji used as the instant placeholder while art is missing/pending. */
  emoji: string | null;
  /** Image path when art is ready (e.g. "/img/123/9f2c1a.webp"), else null. */
  img: string | null;
  /** Art state; 'missing' means the client may request generation via POST /api/image. */
  art: "ready" | "missing" | "blocked";
  description: string | null;
  /** Proper noun / specific named entity (gets a special flair). */
  notable: boolean;
  /** Generations from the starters (null if unknown). */
  depth: number | null;
  rarity: Rarity;
  starter: boolean;
}

/** An element in the current player's library. */
export interface LibraryEntry extends ElementDTO {
  discoveredAt: string; // ISO timestamp
  /** The current player was the first person ever to create this element. */
  first: boolean;
}

export interface ChallengeTarget {
  tier: Tier;
  element: ElementDTO;
  /** Minimum number of combinations needed from the starters, if known. */
  steps: number | null;
  completed: boolean;
}

export interface DailyChallengeDTO {
  day: string;
  targets: ChallengeTarget[]; // always [easy, hard, expert]
}

export interface ChallengeHistoryDay {
  day: string;
  completed: Tier[];
  /** Target names for that day, for the history list. */
  names: Record<Tier, string>;
}

export interface Stats {
  /** Active elements known to the world. */
  known: number;
  /** Elements in this player's library. */
  mine: number;
  /** Elements this player discovered first. */
  firsts: number;
  /** Total challenge tiers ever completed by this player. */
  challengesCompleted: number;
  streak: { current: number; best: number };
}

// ---------------------------------------------------------------- POST /api/bootstrap

export interface PowChallenge {
  /** Opaque signed salt issued by the server. */
  salt: string;
  /** Required number of leading zero bits of sha256(`${salt}:${nonce}`). */
  bits: number;
}

export interface PowSolution {
  salt: string;
  nonce: string;
}

export interface LegacyPayload {
  /** Value of localStorage['alchemy:userId'].value from the 2023 app, e.g. 'alchemy:<uuid>'. */
  userId: string | null;
  /** Element ids from localStorage['elements'] of the 2023 app (legacy INT8 ids as strings). */
  elementIds: string[];
  /**
   * This browser's claim token (32 hex chars, localStorage 'ia:legacyClaim'), sent with a userId.
   * The first adoption binds the legacy player to it; only the same token adopts it again.
   */
  claim?: string;
}

export interface BootstrapRequest {
  /** Player's local calendar date (used for daily challenges); server validates ±1 day. */
  clientDate: string;
  pow?: PowSolution;
  legacy?: LegacyPayload;
}

export interface BootstrapResponse {
  player: { id: string; createdAt: string; legacy: boolean };
  library: LibraryEntry[];
  stats: Stats;
  challenge: DailyChallengeDTO | null;
  history: ChallengeHistoryDay[]; // only days with ≥1 completion, newest first
  /** A few elements recently discovered by anyone (for the "fresh from the lab" feed). */
  recent: ElementDTO[];
  /**
   * Present when this request imported legacy progress. `claimed`: the legacy player is already
   * bound to another browser, so this one got a new player with a copy of the elements only.
   */
  legacyImport?: { imported: number; skipped: number; adopted: boolean; claimed?: boolean };
}

// ---------------------------------------------------------------- POST /api/combine

export interface CombineRequest {
  /** 2–4 ingredient ids the player owns (duplicates allowed, e.g. fire+fire). */
  ids: ElementId[];
  clientDate: string;
}

export interface CombineResponse {
  result: ElementDTO;
  /** Added to the player's library by this combination. */
  newForPlayer: boolean;
  /** This player is the first person ever to create the result. */
  firstEver: boolean;
  /** The recipe did not exist before this request. */
  recipeNew: boolean;
  /** Challenge tiers newly completed by this combination (empty if none). */
  completed: Tier[];
  /** Updated library entry when newForPlayer. */
  entry?: LibraryEntry;
}

// ---------------------------------------------------------------- POST /api/image

export interface ImageRequest {
  id: ElementId;
}

export type ImageResponse =
  | { state: "ready"; img: string }
  | { state: "pending"; retryAfterMs: number }
  | { state: "deferred"; retryAfterMs: number } // rate/budget limited; keep the placeholder
  | { state: "blocked" }; // safety system refused; keep the placeholder forever

// ---------------------------------------------------------------- POST /api/player

export type PlayerAction =
  | { action: "reset" } // reset library to the starters (keeps firsts & challenge history)
  | { action: "transfer-code" } // get a code to continue on another device
  | { action: "redeem"; code: string }; // switch this browser to the player in `code`

export type PlayerResponse =
  | { ok: true; action: "reset" }
  | { ok: true; action: "transfer-code"; code: string }
  | { ok: true; action: "redeem" };

// ---------------------------------------------------------------- errors

export type ApiErrorCode =
  | "bad_request"
  | "unauthorized"
  | "pow_required"
  | "forbidden"
  | "not_owned"
  | "not_found"
  | "rate_limited"
  | "budget_exhausted"
  | "fizzled" // the AI could not produce a valid element; nothing was saved
  | "ai_unavailable"
  | "server_error";

export interface ApiError {
  error: ApiErrorCode;
  message: string;
  retryAfterMs?: number;
  pow?: PowChallenge; // with 'pow_required'
}

export const API_HEADER = "x-ia-client";
export const MAX_INGREDIENTS = 4;
export const MIN_INGREDIENTS = 2;
export const MAX_LEGACY_IDS = 20_000;
