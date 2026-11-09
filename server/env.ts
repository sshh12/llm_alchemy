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
  /** TypeSafe Jev (custom library sort). Read inside the client's try so a missing key is a 503, not a 500. */
  get typesafeKey() {
    return req("TYPESAFE_API_KEY");
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
    return int("LLM_DAILY_CAP", 100_000);
  },
  /** Jev questions per UTC day across all players (rank = 1 per element, groups = 2): ≈ $10-13. */
  get jevDailyCap() {
    return int("JEV_DAILY_CAP", 2_500_000);
  },
  /**
   * Image generations per UTC day (≈ $0.0053 each, so 2,000 ≈ $10.60/day). About 1.5× the monthly
   * cap's daily average: a busy school day is absorbed, but no single week can spend the month,
   * so art pauses for the rest of a day instead of for the rest of the month.
   */
  get imageDailyCap() {
    return int("IMAGE_DAILY_CAP", 2_000);
  },
  /**
   * Image generations per 30-day window: the OpenAI art budget (40,000 ≈ $212). Sized to the
   * observed ~1,100-1,400/day (2026-11). Netlify run time is not the constraint: the site is on
   * Functions Level 1 (1,000 h/month; each generation holds a function ~8-10 s), see
   * docs/ARCHITECTURE.md "Stack".
   */
  get imageMonthlyCap() {
    return int("IMAGE_MONTHLY_CAP", 40_000);
  },
  get powBits() {
    return int("POW_BITS", 18);
  },
  /** Global cap on new (non-legacy) players per UTC day. */
  get playerDailyCap() {
    return int("PLAYER_DAILY_CAP", 20_000);
  },
};
