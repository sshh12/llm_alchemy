-- Daily-challenge generator pred-v6 (scripts/generate-challenges.ts, scripts/lib/challenges.ts).
-- Idempotent and additive; the generator, check-challenges and purge all work without it (they
-- detect the columns), but without challenges.meta the experiment log is lost for rows written
-- before it, including the holdout arm's pre-v6 targets (meta.replaced[0]). Apply it BEFORE the
-- first pred-v6 apply. The server never reads either column.
--
-- challenges.meta: per-day pick record (DayMeta in scripts/lib/challenges.ts): generator, model
--   version, config/git hashes, day type, reach cohort, experiment arms (assigned and realized),
--   per-tier features and predictions (p: school basis, pExp: day basis), and meta.replaced
--   (the row each re-pick replaced; the first entry is the pre-v6 row, kept forever).
--   NULL on legacy and pre-v6 rows.
ALTER TABLE {{schema}}.challenges ADD COLUMN IF NOT EXISTS meta JSONB NULL;

-- elements.challenge_tags: the kid-audience classifier's extra outputs for challenge targets,
--   {v: prompt version, appeal: 0|1|2, teacher: bool, synonyms: string[<=2], at}. NULL = not
--   classified with that prompt yet (appeal then weighs 1, no teacher exclusion, no synonym trap).
ALTER TABLE {{schema}}.elements ADD COLUMN IF NOT EXISTS challenge_tags JSONB NULL;
