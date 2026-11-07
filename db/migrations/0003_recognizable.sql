-- Whether an element is a real, widely recognizable thing a player would enjoy as a daily
-- challenge target ("Geyser": true, "Temporaplasm": false). Set by scripts/classify-recognizable.ts
-- for the challenge candidate pools; NULL = not classified. The generator prefers true.
ALTER TABLE {{schema}}.elements ADD COLUMN IF NOT EXISTS recognizable BOOL NULL;
