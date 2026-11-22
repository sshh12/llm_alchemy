-- Paced art budgets and fresh-first art (docs/ARCHITECTURE.md "Images").
--
-- When an element's art became ready (set by /api/image, server/game/images.ts), so art latency
-- is measurable: image_ready_at minus elements.created_at (world-firsts) or minus a player's
-- discoveries.discovered_at. NULL for art painted before this migration and for elements
-- without art.
--
-- Apply this BEFORE deploying the code that writes it. (The endpoint falls back to an update
-- without the column on undefined_column, so a late migration loses timestamps, never art.)
ALTER TABLE {{schema}}.elements ADD COLUMN IF NOT EXISTS image_ready_at TIMESTAMPTZ NULL;
