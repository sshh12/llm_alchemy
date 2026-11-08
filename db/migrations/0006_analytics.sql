-- First-party analytics for retention and acquisition (docs/ARCHITECTURE.md "Analytics").
-- Server-side, so ad blockers that drop Google Analytics do not hide players from these numbers.

-- One row per player per UTC day with any activity. Exact DAU and D1/D7/D30 retention: a
-- returning player who finds nothing new still counts (discoveries only record new elements).
--   loads     bootstraps (app opens / reloads) that day
--   combines  combines answered by the server (repeats the client already knows never get here)
CREATE TABLE IF NOT EXISTS {{schema}}.player_days (
  player_id INT8 NOT NULL,
  day DATE NOT NULL,
  loads INT4 NOT NULL DEFAULT 0,
  combines INT4 NOT NULL DEFAULT 0,
  PRIMARY KEY (player_id, day)
);

-- First-touch acquisition, captured by the page head on the visit's first page and stored once,
-- when the player is created. NULL on players created before this migration. A player created
-- after it always has acq_landing; acq_referrer NULL then means direct (no external referrer).
--   acq_referrer  external referrer host only (e.g. www.google.com), never a full URL
--   acq_landing   path of the first page (e.g. /how-to-play), no query string
--   acq_utm_*     utm_source / utm_medium / utm_campaign of that first page
ALTER TABLE {{schema}}.players ADD COLUMN IF NOT EXISTS acq_referrer STRING NULL;
ALTER TABLE {{schema}}.players ADD COLUMN IF NOT EXISTS acq_landing STRING NULL;
ALTER TABLE {{schema}}.players ADD COLUMN IF NOT EXISTS acq_utm_source STRING NULL;
ALTER TABLE {{schema}}.players ADD COLUMN IF NOT EXISTS acq_utm_medium STRING NULL;
ALTER TABLE {{schema}}.players ADD COLUMN IF NOT EXISTS acq_utm_campaign STRING NULL;
