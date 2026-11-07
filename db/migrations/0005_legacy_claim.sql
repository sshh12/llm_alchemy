-- Adopt-once for legacy players (server/game/players.ts claimLegacyPlayer; docs/ARCHITECTURE.md
-- "Sessions & identity"). The 2023 app published every element's creator id, so a legacy user id
-- alone is not a secret: the first browser to present it binds the player, and only that browser
-- (holding the claim token whose sha256 is legacy_claim_hash) can adopt it again.
--   legacy_claimed_at   when the legacy player was bound to a browser (NULL = still unclaimed)
--   legacy_claim_hash   sha256 hex of the binding browser's claim token (NULL = no re-adoption)
ALTER TABLE {{schema}}.players ADD COLUMN IF NOT EXISTS legacy_claimed_at TIMESTAMPTZ NULL;
ALTER TABLE {{schema}}.players ADD COLUMN IF NOT EXISTS legacy_claim_hash STRING NULL;

-- Legacy players that were already adopted through the legacy flow by the earlier code (it
-- always imported) are bound, without a claim hash: their sessions keep working, nobody can
-- adopt them again. Players only reached via a transfer code stay claimable by their original
-- browser, so the real early player still gets their firsts back.
UPDATE {{schema}}.players SET legacy_claimed_at = legacy_imported_at
 WHERE legacy_user_id IS NOT NULL AND legacy_claimed_at IS NULL AND legacy_imported_at IS NOT NULL;
