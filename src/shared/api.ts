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

/**
 * First-touch acquisition (localStorage 'ia:acq', written by the page head on the visit's first
 * page). Stored only when this bootstrap creates the player; ignored otherwise.
 */
export interface Acquisition {
  /** External referrer host ("" = direct). */
  ref: string;
  /** Landing path, no query string. */
  path: string;
  src?: string | null;
  med?: string | null;
  cmp?: string | null;
}

/** Field caps for Acquisition: the client truncates to these, the server drops anything longer. */
export const ACQ_MAX = { ref: 253, path: 200, utm: 100 } as const;

/**
 * How this page load was reached, from document.referrer at page load (never the URL itself):
 * a known search engine, no referrer, an installed app, or anything else.
 */
export const BOOT_ENTRIES = ["search", "direct", "standalone", "other"] as const;
export type BootEntry = (typeof BOOT_ENTRIES)[number];

/**
 * Coarse client hints for first-party analytics (docs/ARCHITECTURE.md "Analytics"). Every field
 * is optional and the server drops a malformed one, never a 400. Stored: touch / wide / prior on
 * the player this bootstrap creates (players.acq_*), standalone as players.standalone_at, entry
 * on the day's player_days row.
 */
export interface BootstrapHint {
  /** navigator.maxTouchPoints > 1 (tells an iPad from a Mac, which share a User-Agent). */
  touch?: boolean;
  /** Running as an installed app (display-mode: standalone). */
  standalone?: boolean;
  /** The right panel (today's challenge card) is on screen. */
  wide?: boolean;
  /** v2 game state (canvas, recipe cache, ...) was already in localStorage before this load. */
  prior?: boolean;
  /** navigator.storage.persisted(), when the browser answered quickly. */
  persisted?: boolean;
  entry?: BootEntry;
}

export interface BootstrapRequest {
  /** Player's local calendar date (used for daily challenges); server validates ±1 day. */
  clientDate: string;
  pow?: PowSolution;
  legacy?: LegacyPayload;
  acq?: Acquisition;
  hint?: BootstrapHint;
  /**
   * A resumed tab fetching the new day (game.ts refreshIfNewDay), not a page load: the server
   * counts no load for it (player_days), so a tab merely shown again is not a return day.
   */
  refresh?: boolean;
}

/**
 * Tomorrow's easy challenge target (the player's local day + 1), as a teaser: its art when it is
 * ready and the length of its name without spaces. Never its name or id.
 */
export interface TomorrowTeaser {
  img: string | null;
  letters: number;
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
  /** Absent when tomorrow has no challenge row (or from servers before the teaser). */
  tomorrow?: TomorrowTeaser;
}

/**
 * Where a page load was when it ended before the game was playable (POST /api/beacon), or where
 * a failed boot failed (GA load_failed `phase`). bootstrap1: the first POST; pow: solving the
 * proof-of-work; bootstrap2: the POST carrying the solution; render: applying the response;
 * wait: the pause before the one automatic retry; error: on the error screen.
 */
export const BOOT_PHASES = ["bootstrap1", "pow", "bootstrap2", "render", "wait", "error"] as const;
export type BootPhase = (typeof BOOT_PHASES)[number];

/**
 * POST /api/beacon body, sent with navigator.sendBeacon as text/plain (a beacon can't set the
 * API header). `ms`: time since navigation start. `resumed`: the page came back (visible again)
 * after sending this abandon, before it was playable or not: it takes that abandon back, with
 * the same phase and ms, so abandons minus resumes counts the pages that really ended pre-ready.
 */
export interface BootBeacon {
  phase: BootPhase;
  ms: number;
  resumed?: boolean;
}

/**
 * Time bands shared by GA app_ready `boot_band` and the server stats boot_abandon:<phase>:<band>
 * and pow:latency:<band>, so the GA and first-party boot funnels line up band for band.
 */
export const LATENCY_BANDS = ["<2s", "2-4s", "4-8s", "8-15s", "15-30s", "30s+"] as const;
export type LatencyBand = (typeof LATENCY_BANDS)[number];

export function latencyBand(ms: number): LatencyBand {
  if (!(ms >= 0) || ms < 2_000) return "<2s"; // includes small clock skew below zero
  if (ms < 4_000) return "2-4s";
  if (ms < 8_000) return "4-8s";
  if (ms < 15_000) return "8-15s";
  if (ms < 30_000) return "15-30s";
  return "30s+";
}

// ---------------------------------------------------------------- POST /api/report

export const REPORT_REASONS = ["inappropriate", "wrong", "other"] as const;
export type ReportReason = (typeof REPORT_REASONS)[number];

/** Flag an element the player owns (or a target of today's challenge) for review. */
export interface ReportRequest {
  id: ElementId;
  reason?: ReportReason;
}

export interface ReportResponse {
  ok: true;
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

/**
 * Which art budget lane a request was served from (server/game/images.ts). fresh: discovered by
 * this player in the last 20 minutes, or a challenge target that is "today" somewhere.
 */
export type ArtLane = "fresh" | "backlog";

/**
 * Why art was deferred. pace: the paced image budget is ahead of pace for this lane; budget: an
 * image budget is spent for its window; player / ip: a per-player or per-IP art limit; gave_up:
 * generation failed too often, check back much later.
 */
export type ArtDeferReason = "pace" | "budget" | "player" | "ip" | "gave_up";

export type ImageResponse =
  | { state: "ready"; img: string }
  // `failed`: the last generation failed and can be retried, so the next request starts a new
  // one (it is not a poll of someone else's lease; the client counts it against its session cap).
  | { state: "pending"; retryAfterMs: number; failed?: true }
  // Not now; keep the placeholder (the emoji) and ask again later (src/app/lib/images.ts).
  // `limited`: a rate limit or image budget said no (every reason but gave_up). `lane` and
  // `reason` are optional so older servers and clients keep working.
  | { state: "deferred"; retryAfterMs: number; limited?: true; lane?: ArtLane; reason?: ArtDeferReason }
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
  /** With 'rate_limited' / 'budget_exhausted': the rule that said no (e.g. "llm.player"). */
  limit?: string;
}

export const API_HEADER = "x-ia-client";
export const MAX_INGREDIENTS = 4;
export const MIN_INGREDIENTS = 2;
export const MAX_LEGACY_IDS = 20_000;
