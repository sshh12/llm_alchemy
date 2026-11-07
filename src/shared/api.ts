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
  /** Active custom sort: the server scores the result if it is new for the player (best-effort). */
  sort?: SortSpec;
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
  /**
   * Present when the request carried `sort`, the result is new for the player, and scoring
   * finished in time. Clients must work without it (they fall back to POST /api/sort {ids}).
   */
  sortScore?: SortScore;
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

// ---------------------------------------------------------------- POST /api/sort

/**
 * A player-defined library order ("Sort by anything"). The text is plain data: the server
 * passes it to the scoring model as a JSON field, never as instructions.
 */
export type SortSpec =
  | { kind: "rank"; prompt: string } // "spookiest", "things in a kitchen"
  | { kind: "groups"; groups: string[] }; // display order; "Other" is implicit and never sent

export interface SortRequest {
  spec: SortSpec;
  /** Score only these owned elements (new discoveries, retries). Omit to score the whole library. */
  ids?: ElementId[];
}

export interface SortResponse {
  /** Model + rubric, e.g. "jev-1.14.0/r2" or "mock/r2". Informational (logs, e2e). */
  engine: string;
  /** Scored ids; `s`, `g` and `n` are parallel arrays. */
  ids: ElementId[];
  /**
   * 0..1000. rank: match strength. groups: probability of the chosen group, out of the groups
   * plus "None of these groups".
   */
  s: number[];
  /**
   * groups only: index into spec.groups of the chosen group; when the model picks "None of these
   * groups", the most likely real group (never Other).
   */
  g?: number[];
  /**
   * groups only: 0..1000 fit = "clearly belongs in one of the groups" × (1 − P(None of these
   * groups)). Below SORT_FIT_THRESHOLD the element goes to Other while the player keeps Other on.
   */
  n?: number[];
  /** Owned and active but not scored this time (provider hiccup, deadline): retry with `ids`. */
  retry: ElementId[];
  /** Whole-library runs only: the library exceeded SORT_MAX_ELEMENTS; the oldest were not scored. */
  truncated?: boolean;
}

/** One element's score (piggybacked on POST /api/combine). */
export interface SortScore {
  s: number;
  g?: number;
  n?: number;
}

// Requested ids that appear in neither `ids` nor `retry` are not owned/active: never retry them.
/**
 * Bump when question wording/levels or the score parse change (invalidates client score mirrors).
 * r2: rank requests carry a goal `state`; groups add a "None of these groups" option that
 * discounts the fit.
 */
export const SORT_RUBRIC = "r2";
export const SORT_PROMPT_MAX_CHARS = 80;
export const SORT_GROUPS_MIN = 2;
export const SORT_GROUPS_MAX = 8;
export const SORT_GROUP_MAX_CHARS = 32;
/** Max ids in one incremental SortRequest. */
export const SORT_IDS_MAX = 1_000;
/** Max elements one whole-library run scores (a legacy import alone can be MAX_LEGACY_IDS). */
export const SORT_MAX_ELEMENTS = 25_000;
/** rank: scores at or above this are in the "Matches" bucket (≈ level 2.4 of 0..4). */
export const SORT_MATCH_THRESHOLD = 600;
/** groups: fit (`n`) below this → Other. */
export const SORT_FIT_THRESHOLD = 500;

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
