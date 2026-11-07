-- Short visual description of an element written by the combine LLM ("icon" field),
-- used to steer the image model (e.g. "sleek modern smartphone with a glowing screen").
ALTER TABLE {{schema}}.elements ADD COLUMN IF NOT EXISTS art_hint STRING NULL;
