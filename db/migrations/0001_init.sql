-- Infinite Alchemy v2 schema. Lives in its own SQL schema ("alchemy" by default,
-- "alchemy_e2e" for tests) next to the untouched legacy "public"."Alchemy*" tables.
-- Every statement is idempotent. The runner substitutes {{schema}}.

CREATE SCHEMA IF NOT EXISTS {{schema}};

-- Players. Anonymous; identified by a signed HttpOnly cookie.
-- Legacy (2023-2026) players are pre-created by the backfill with legacy_user_id set
-- ('alchemy:<uuid>' from the old app's localStorage) and adopted on first visit.
CREATE TABLE IF NOT EXISTS {{schema}}.players (
  id INT8 PRIMARY KEY DEFAULT unique_rowid(),
  public_id UUID NOT NULL UNIQUE DEFAULT gen_random_uuid(),
  legacy_user_id STRING NULL UNIQUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_seen_at TIMESTAMPTZ NULL,
  legacy_imported_at TIMESTAMPTZ NULL,
  legacy_import_count INT4 NOT NULL DEFAULT 0,
  created_ip_hash STRING NULL,
  session_version INT4 NOT NULL DEFAULT 1
);

-- Elements. name_key is the unique normalized identity; name is for display.
CREATE TABLE IF NOT EXISTS {{schema}}.elements (
  id INT8 PRIMARY KEY DEFAULT unique_rowid(),
  name STRING NOT NULL,
  name_key STRING NOT NULL UNIQUE,
  fold_key STRING NOT NULL,
  emoji STRING NULL,
  description STRING NULL,
  notable BOOL NOT NULL DEFAULT false,
  status STRING NOT NULL DEFAULT 'active',          -- active | quarantined
  is_starter BOOL NOT NULL DEFAULT false,
  depth INT4 NULL,                                   -- generations from starters
  steps INT4 NULL,                                   -- min number of combinations (tree cost)
  discovered_by INT8 NULL,                           -- player id of first discoverer
  image_status STRING NOT NULL DEFAULT 'none',       -- none | pending | ready | blocked | failed
  image_key STRING NULL,
  image_attempts INT4 NOT NULL DEFAULT 0,
  image_lease_until TIMESTAMPTZ NULL,
  source STRING NOT NULL,                            -- seed | legacy | llm
  legacy_id INT8 NULL UNIQUE,
  enriched_at TIMESTAMPTZ NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS elements_fold_key_idx ON {{schema}}.elements (fold_key);
CREATE INDEX IF NOT EXISTS elements_discovered_by_idx ON {{schema}}.elements (discovered_by) WHERE discovered_by IS NOT NULL;
CREATE INDEX IF NOT EXISTS elements_created_at_idx ON {{schema}}.elements (created_at DESC);
CREATE INDEX IF NOT EXISTS elements_starter_idx ON {{schema}}.elements (is_starter) WHERE is_starter;

-- Every legacy element id resolves here (old clients store legacy ids in localStorage).
CREATE TABLE IF NOT EXISTS {{schema}}.legacy_element_map (
  legacy_id INT8 PRIMARY KEY,
  element_id INT8 NOT NULL,
  disposition STRING NOT NULL                        -- active | quarantined | alias
);

-- Recipes. ingredient_ids is the multiset of ingredient element ids sorted ascending
-- numerically (duplicates kept, e.g. fire+fire = {f,f}). Recipes are permanent once active.
CREATE TABLE IF NOT EXISTS {{schema}}.recipes (
  id INT8 PRIMARY KEY DEFAULT unique_rowid(),
  ingredient_ids INT8[] NOT NULL,
  result_id INT8 NOT NULL,
  arity INT2 NOT NULL,
  status STRING NOT NULL DEFAULT 'active',          -- active | quarantined
  protected BOOL NOT NULL DEFAULT false,             -- on a challenge path; never re-rolled
  source STRING NOT NULL,                            -- legacy | llm
  created_by INT8 NULL,
  legacy_id INT8 NULL UNIQUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (ingredient_ids)
);
CREATE INDEX IF NOT EXISTS recipes_result_idx ON {{schema}}.recipes (result_id);

-- A player's library.
CREATE TABLE IF NOT EXISTS {{schema}}.discoveries (
  player_id INT8 NOT NULL,
  element_id INT8 NOT NULL,
  discovered_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  source STRING NOT NULL,                            -- starter | combine | legacy
  recipe_id INT8 NULL,
  PRIMARY KEY (player_id, element_id)
);

-- Daily challenges (one row per calendar day).
CREATE TABLE IF NOT EXISTS {{schema}}.challenges (
  day DATE PRIMARY KEY,
  easy_id INT8 NOT NULL,
  hard_id INT8 NOT NULL,
  expert_id INT8 NOT NULL,
  easy_steps INT4 NULL,
  hard_steps INT4 NULL,
  expert_steps INT4 NULL,
  source STRING NOT NULL,                            -- legacy | generated
  generator STRING NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS {{schema}}.challenge_completions (
  player_id INT8 NOT NULL,
  day DATE NOT NULL,
  tier STRING NOT NULL,                              -- easy | hard | expert
  completed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  source STRING NOT NULL,                            -- legacy | live
  PRIMARY KEY (player_id, day, tier)
);

-- Fixed-window counters for rate limits, global daily budgets and PoW replay protection.
CREATE TABLE IF NOT EXISTS {{schema}}.counters (
  key STRING PRIMARY KEY,
  count INT8 NOT NULL DEFAULT 0,
  expires_at TIMESTAMPTZ NOT NULL
) WITH (ttl_expiration_expression = 'expires_at', ttl_job_cron = '@hourly');

-- Small key/value store for cached aggregates and backfill bookkeeping.
CREATE TABLE IF NOT EXISTS {{schema}}.meta (
  key STRING PRIMARY KEY,
  value JSONB NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
