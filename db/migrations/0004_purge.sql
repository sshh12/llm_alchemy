-- Soft purge of junk elements (scripts/purge-elements.ts; docs/ARCHITECTURE.md "Element purge").
--
-- elements.quarantine_reason says why a quarantined element is hidden:
--   'legacy-filter'  quarantined by the legacy backfill (checkName / spam rules); set below for
--                    every row that was already quarantined when this migration ran
--   'review'         judged junk by the purge review (purge_review verdicts)
--   'orphaned'       not junk, only unreachable from the starters because of a purge; combine
--                    reactivates it when the model names it again
-- elements.purge_run / recipes.purge_run: id of the purge apply run that quarantined the row
-- (purge-YYYYMMDD-HHMMSS); `restore --run <id>` reverses that run.
ALTER TABLE {{schema}}.elements ADD COLUMN IF NOT EXISTS quarantine_reason STRING NULL;
ALTER TABLE {{schema}}.elements ADD COLUMN IF NOT EXISTS purge_run STRING NULL;
ALTER TABLE {{schema}}.recipes ADD COLUMN IF NOT EXISTS purge_run STRING NULL;

UPDATE {{schema}}.elements SET quarantine_reason = 'legacy-filter' WHERE status = 'quarantined' AND quarantine_reason IS NULL;

CREATE INDEX IF NOT EXISTS elements_purge_run_idx ON {{schema}}.elements (purge_run) WHERE purge_run IS NOT NULL;
CREATE INDEX IF NOT EXISTS recipes_purge_run_idx ON {{schema}}.recipes (purge_run) WHERE purge_run IS NOT NULL;

-- Staging for the review: one verdict per element and pass. 'review' covers every exported
-- element; 'verify' is a second opinion on the review's 'purge' verdicts. An element is purged
-- only when both passes say 'purge'.
CREATE TABLE IF NOT EXISTS {{schema}}.purge_review (
  element_id INT8 NOT NULL,
  pass STRING NOT NULL CHECK (pass IN ('review', 'verify')),
  batch INT4 NOT NULL,
  verdict STRING NOT NULL CHECK (verdict IN ('purge', 'keep')),
  reason STRING NULL,
  reviewed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (element_id, pass)
);
