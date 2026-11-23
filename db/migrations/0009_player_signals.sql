-- Wave-2 player signals and element reports (docs/ARCHITECTURE.md "Analytics" and "API").
-- Idempotent. Apply BEFORE deploying the code that writes these columns: every writer falls back
-- to its pre-0009 statement on undefined_column, so a late migration loses signals, never loads,
-- players or combines. Nothing here stores an identifier beyond the existing player id.

-- Client hints sent with bootstrap (BootstrapHint), stored once when the player is created.
-- NULL on players created before this migration, or when the client didn't say.
--   acq_touch        navigator.maxTouchPoints > 1: with acq_ua_class = 'mac' it marks an iPad
--                    (iPadOS reports a Mac User-Agent). acq_ua_class itself is unchanged.
--   acq_wide         the right panel (today's challenge card) was on screen (min-width 1280px)
--   acq_prior_local  v2 game state (canvas, recipe cache, ...) was already in this browser's
--                    localStorage: a "new" player here lost its cookie, it isn't a new visitor
--   standalone_at    first bootstrap from the installed app (display-mode: standalone)
ALTER TABLE {{schema}}.players ADD COLUMN IF NOT EXISTS acq_touch BOOL NULL;
ALTER TABLE {{schema}}.players ADD COLUMN IF NOT EXISTS acq_wide BOOL NULL;
ALTER TABLE {{schema}}.players ADD COLUMN IF NOT EXISTS acq_prior_local BOOL NULL;
ALTER TABLE {{schema}}.players ADD COLUMN IF NOT EXISTS standalone_at TIMESTAMPTZ NULL;

-- Timing of each player day, written by the same upsert that counts loads and combines
-- (server/game/players.ts countActivity). NULL first_at = a row begun before this migration:
-- analyses skip its timing.
--   first_at, last_at  first and latest counted event (load or server-answered combine)
--   sessions           1 + pauses over 30 minutes between counted events
--   active_secs        sum of the gaps of at most 5 minutes between counted events
--   entry              how the day's first bootstrap that sent one was reached:
--                      search | direct | standalone | other (from document.referrer, never the URL)
ALTER TABLE {{schema}}.player_days ADD COLUMN IF NOT EXISTS first_at TIMESTAMPTZ NULL;
ALTER TABLE {{schema}}.player_days ADD COLUMN IF NOT EXISTS last_at TIMESTAMPTZ NULL;
ALTER TABLE {{schema}}.player_days ADD COLUMN IF NOT EXISTS sessions INT4 NOT NULL DEFAULT 0;
ALTER TABLE {{schema}}.player_days ADD COLUMN IF NOT EXISTS active_secs INT4 NOT NULL DEFAULT 0;
ALTER TABLE {{schema}}.player_days ADD COLUMN IF NOT EXISTS entry STRING NULL;

-- "Report this element" (POST /api/report): one row per player and element, the first report
-- wins (ON CONFLICT DO NOTHING). reason: inappropriate | wrong | other, or NULL. Read only in
-- aggregate (scripts/analytics/snapshot.ts top_reported_elements), as input to the purge review.
CREATE TABLE IF NOT EXISTS {{schema}}.element_reports (
  player_id INT8 NOT NULL,
  element_id INT8 NOT NULL,
  reason STRING NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (player_id, element_id)
);
CREATE INDEX IF NOT EXISTS element_reports_element_idx ON {{schema}}.element_reports (element_id);

-- The "fresh from the lab" feed (server/game/players.ts recentElements: the 20 newest active,
-- non-starter elements with art) on every bootstrap cache miss. Without this it is a full scan
-- of elements (~126k rows, ~700 RU, ~280 ms in 2026-11), growing with the table; this partial
-- index holds only the painted rows, newest first, and stores what the feed reads, so the query
-- reads about 20 index rows and no table rows.
CREATE INDEX IF NOT EXISTS elements_fresh_idx ON {{schema}}.elements (created_at DESC)
  STORING (name, emoji, description, notable, depth, steps, is_starter, status, image_status, image_key)
  WHERE status = 'active' AND NOT is_starter AND image_status = 'ready' AND image_key IS NOT NULL;
