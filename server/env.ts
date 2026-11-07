// Typed access to runtime configuration. Read lazily so scripts can load .env first.

function req(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing required env var ${name}`);
  return v;
}

function int(name: string, fallback: number): number {
  const v = process.env[name];
  if (!v) return fallback;
  const n = Number.parseInt(v, 10);
  return Number.isFinite(n) ? n : fallback;
}

export const env = {
  get databaseUrl() {
    return req("DATABASE_URL");
  },
  get openaiKey() {
    return req("OPENAI_API_KEY");
  },
  get sessionSecret() {
    const s = req("SESSION_SECRET");
    if (s.length < 32) throw new Error("SESSION_SECRET must be at least 32 characters");
    return s;
  },
  get schema() {
    const s = process.env.DB_SCHEMA || "alchemy";
    if (!/^[a-z_][a-z0-9_]{0,40}$/.test(s)) throw new Error(`Invalid DB_SCHEMA ${s}`);
    return s;
  },
  /** Netlify sets CONTEXT to production | deploy-preview | branch-deploy | dev. */
  get isProduction() {
    return process.env.CONTEXT === "production";
  },
  get aiMode(): "live" | "mock" {
    const m = process.env.AI_MODE === "mock" ? "mock" : "live";
    if (m === "mock" && process.env.CONTEXT === "production") {
      throw new Error("AI_MODE=mock is not allowed in production");
    }
    return m;
  },
  get llmDailyCap() {
    return int("LLM_DAILY_CAP", 40_000);
  },
  get imageDailyCap() {
    return int("IMAGE_DAILY_CAP", 1_500);
  },
  get powBits() {
    return int("POW_BITS", 18);
  },
};
