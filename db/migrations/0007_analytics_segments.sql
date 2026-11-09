-- Analytics segments (docs/ARCHITECTURE.md "Analytics", docs/ANALYTICS.md).
--   acq_ua_class      coarse platform of the browser that created the player (server/ua.ts):
--                     bot | chromeos | android | ios | windows | mac | linux | other | unknown.
--                     Never the raw User-Agent. Exclude 'bot' from player metrics.
--   switched_away_at  when this player's browser redeemed a transfer code for another player:
--                     the player was a throwaway, so exclude it from activation and retention.
ALTER TABLE {{schema}}.players ADD COLUMN IF NOT EXISTS acq_ua_class STRING NULL;
ALTER TABLE {{schema}}.players ADD COLUMN IF NOT EXISTS switched_away_at TIMESTAMPTZ NULL;

-- From this migration on, player_days.day is the player's LOCAL calendar day (the client date the
-- server validates, as daily challenges use), not the UTC day 0006 describes. Rows written before
-- 2026-11-09 are UTC-dated; cohort analyses start with local-day cohorts on 2026-11-09.
