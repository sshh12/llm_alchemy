// Player lifecycle: creation, legacy adoption + inventory import, library, stats.
import { MAX_LEGACY_IDS } from "../../src/shared/api.ts";
import { q, q1, t, withTx } from "../db.ts";
import { PLAYER_COLS, type PlayerRow } from "../session.ts";
import { ELEMENT_COLS, isElementId, type ElementRow, type LibraryRow } from "./dto.ts";

/** Imports allowed per player (the client imports once; this tolerates a couple of retries). */
export const MAX_LEGACY_IMPORTS = 3;

/** 'alchemy:<uuid>', or a bare <uuid> for the earliest players (the prefix arrived 2023-05-23). */
const LEGACY_USER_RE = /^(?:alchemy:)?[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export function isLegacyUserId(s: unknown): s is string {
  return typeof s === "string" && LEGACY_USER_RE.test(s);
}

/** Create a player and give them the starters, in one statement. */
export async function createPlayer(ipHash: string): Promise<PlayerRow> {
  const row = await q1<PlayerRow>(
    `WITH p AS (
       INSERT INTO ${t("players")} (created_ip_hash, last_seen_at) VALUES ($1, now())
       RETURNING ${PLAYER_COLS}
     ), s AS (
       INSERT INTO ${t("discoveries")} (player_id, element_id, source)
       SELECT p.id, e.id, 'starter' FROM p, ${t("elements")} e WHERE e.is_starter
       ON CONFLICT DO NOTHING
       RETURNING element_id -- CockroachDB requires RETURNING in data-modifying CTEs
     )
     SELECT * FROM p`,
    [ipHash],
  );
  if (!row) throw new Error("player insert returned no row");
  return row;
}

export interface LegacyClaim {
  /** The legacy player, when this request bound it (first claim) or re-presented its claim token. */
  player?: PlayerRow;
  /** True when the legacy player exists but is bound to another browser (or was adopted before claims). */
  claimed: boolean;
}

/**
 * Adopt-once. The 2023 app published every element's creator id, so a legacy user id is not a
 * secret: the first browser to present it binds the player (storing the sha256 of its claim
 * token), and afterwards only a request carrying that same token adopts it again (a retry whose
 * response was lost, or the same browser after its cookie was cleared). Players the earlier code
 * already adopted (it always imported: legacy_imported_at set) are never adopted again. A player
 * only reached via a transfer code (e.g. the owner peeking) stays claimable by its original
 * browser. One atomic statement, so two racing browsers cannot both win.
 */
export async function claimLegacyPlayer(legacyUserId: string, claimHash: string | null): Promise<LegacyClaim> {
  const player = await q1<PlayerRow>(
    `UPDATE ${t("players")}
        SET legacy_claimed_at = COALESCE(legacy_claimed_at, now()),
            legacy_claim_hash = COALESCE(legacy_claim_hash, $2::STRING),
            last_seen_at = now()
      WHERE legacy_user_id = $1
        AND ((legacy_claimed_at IS NULL AND legacy_imported_at IS NULL)
          OR (legacy_claim_hash IS NOT NULL AND legacy_claim_hash = $2::STRING))
      RETURNING ${PLAYER_COLS}`,
    [legacyUserId, claimHash],
  );
  if (player) return { player, claimed: false };
  return { claimed: await legacyPlayerExists(legacyUserId) };
}

/** True when the backfill created a player for this legacy user id. */
export async function legacyPlayerExists(legacyUserId: string): Promise<boolean> {
  return (await q1(`SELECT 1 FROM ${t("players")} WHERE legacy_user_id = $1`, [legacyUserId])) !== undefined;
}

/**
 * Legacy players are backfilled without starter rows; add them on adoption (idempotent). They
 * are dated at the player's creation, not now(), so they never show up as "new".
 */
export async function ensureStarters(playerId: string): Promise<void> {
  await q(
    `INSERT INTO ${t("discoveries")} (player_id, element_id, source, discovered_at)
     SELECT p.id, e.id, 'starter', p.created_at
       FROM ${t("elements")} e, ${t("players")} p
      WHERE e.is_starter AND p.id = $1
     ON CONFLICT DO NOTHING`,
    [playerId],
  );
}

export async function touchPlayer(playerId: string): Promise<void> {
  await q(`UPDATE ${t("players")} SET last_seen_at = now() WHERE id = $1`, [playerId]);
}

export interface LegacyImportResult {
  /** Non-starter elements from the inventory that are now in the library. */
  imported: number;
  /** Inventory ids that could not be restored (unknown, quarantined or malformed). */
  skipped: number;
}

/** The result for an inventory that is not imported: every requested id counts as skipped. */
export function notImported(legacyIds: readonly unknown[]): LegacyImportResult {
  return { imported: 0, skipped: new Set(legacyIds.map(String)).size };
}

/**
 * Import a 2023-app inventory (legacy element ids) into the library. Ids map through
 * legacy_element_map (aliases resolve to their active twin); unknown ids are skipped. At most
 * MAX_LEGACY_IDS ids and MAX_LEGACY_IMPORTS imports per player; the count check and increment
 * are atomic with the insert.
 *
 * Elements a purge quarantined ('review', restorable) or cut off ('orphaned', revived by combine)
 * are imported too, because the client sends its inventory only once: every reader of
 * discoveries filters on active elements, so they stay hidden until they come back. The counts
 * cover active elements only, matching what the player sees. 'legacy-filter' spam never returns
 * and is skipped.
 *
 * Rows are dated when the element was made (for a legacy player, no earlier than the player's
 * own creation), never now(): an old library must not show up as "new". Rows the backfill
 * already wrote keep their (older) date.
 */
export async function importLegacy(playerId: string, legacyIds: readonly unknown[]): Promise<LegacyImportResult> {
  const ids = [...new Set(legacyIds.filter(isElementId))].slice(0, MAX_LEGACY_IDS);
  const requested = new Set(legacyIds.map(String)).size;
  if (ids.length === 0) return notImported(legacyIds);
  return withTx(async (c) => {
    const claimed = await q(
      `UPDATE ${t("players")}
          SET legacy_import_count = legacy_import_count + 1, legacy_imported_at = now()
        WHERE id = $1 AND legacy_import_count < $2
        RETURNING id`,
      [playerId, MAX_LEGACY_IMPORTS],
      c,
    );
    if (claimed.length === 0) return notImported(legacyIds);
    const row = await q1<{ mapped_ids: string; elements: string }>(
      `WITH mapped AS (
         SELECT m.legacy_id, m.element_id, e.is_starter, e.created_at, e.status = 'active' AS active
           FROM ${t("legacy_element_map")} m
           JOIN ${t("elements")} e
             ON e.id = m.element_id AND (e.status = 'active' OR e.quarantine_reason IN ('review', 'orphaned'))
          WHERE m.legacy_id = ANY($2::INT8[])
       ), ins AS (
         INSERT INTO ${t("discoveries")} (player_id, element_id, source, discovered_at)
         SELECT p.id, u.element_id, 'legacy',
                LEAST(now(), CASE WHEN p.legacy_user_id IS NOT NULL THEN GREATEST(p.created_at, u.created_at) ELSE u.created_at END)
           FROM (SELECT DISTINCT element_id, created_at FROM mapped) AS u, ${t("players")} p
          WHERE p.id = $1::INT8
         ON CONFLICT DO NOTHING
         RETURNING element_id
       )
       SELECT (SELECT count(*) FROM mapped WHERE active) AS mapped_ids,
              (SELECT count(DISTINCT element_id) FROM mapped WHERE active AND NOT is_starter) AS elements,
              (SELECT count(*) FROM ins) AS inserted -- reading ins keeps the insert explicit`,
      [playerId, ids],
      c,
    );
    return { imported: Number(row?.elements ?? 0), skipped: requested - Number(row?.mapped_ids ?? 0) };
  });
}

export async function library(playerId: string): Promise<LibraryRow[]> {
  return q<LibraryRow>(
    `SELECT ${ELEMENT_COLS}, e.discovered_by, d.discovered_at
       FROM ${t("discoveries")} d
       JOIN ${t("elements")} e ON e.id = d.element_id
      WHERE d.player_id = $1 AND e.status = 'active'
      ORDER BY d.discovered_at, e.id`,
    [playerId],
  );
}

export async function countFirsts(playerId: string): Promise<number> {
  const row = await q1<{ n: string }>(
    `SELECT count(*) AS n FROM ${t("elements")} WHERE discovered_by = $1 AND status = 'active'`,
    [playerId],
  );
  return Number(row?.n ?? 0);
}

// ---------------------------------------------------------------- shared aggregates

const KNOWN_MEMORY_MS = 5 * 60_000;
const KNOWN_DB_MS = 15 * 60_000;
let knownCache: { value: number; until: number } | null = null;

/**
 * Number of active elements in the world. Counting ~55k rows on every bootstrap would be
 * wasteful, so the count is cached per instance and shared across instances via meta.
 */
export async function knownCount(): Promise<number> {
  if (knownCache && knownCache.until > Date.now()) return knownCache.value;
  const cached = await q1<{ value: unknown; fresh: boolean }>(
    `SELECT value, updated_at > now() - $2::INTERVAL AS fresh FROM ${t("meta")} WHERE key = $1`,
    ["known_count", `${KNOWN_DB_MS / 1000} seconds`],
  );
  let value = cached ? Number(cached.value) : NaN;
  if (!cached?.fresh || !Number.isFinite(value)) {
    const row = await q1<{ n: string }>(`SELECT count(*) AS n FROM ${t("elements")} WHERE status = 'active'`);
    value = Number(row?.n ?? 0);
    await q(
      `UPSERT INTO ${t("meta")} (key, value, updated_at) VALUES ($1, to_jsonb($2::INT8), now())`,
      ["known_count", value],
    );
  }
  knownCache = { value, until: Date.now() + KNOWN_MEMORY_MS };
  return value;
}

const RECENT_LIMIT = 20;
const RECENT_MS = 60_000;
let recentCache: { rows: ElementRow[]; until: number } | null = null;

/** Newest elements discovered by anyone (the "fresh from the lab" feed), cached ~60 s. */
export async function recentElements(): Promise<ElementRow[]> {
  if (recentCache && recentCache.until > Date.now()) return recentCache.rows;
  const rows = await q<ElementRow>(
    `SELECT ${ELEMENT_COLS} FROM ${t("elements")} e
      WHERE e.status = 'active' AND NOT e.is_starter
      ORDER BY e.created_at DESC LIMIT $1`,
    [RECENT_LIMIT],
  );
  recentCache = { rows, until: Date.now() + RECENT_MS };
  return rows;
}
