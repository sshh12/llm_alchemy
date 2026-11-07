// Database helpers for CLI scripts: a dedicated pool with generous timeouts, schema
// selection, and small batching utilities. Request handlers use server/db.ts instead.
import pg from "pg";

// Same parsers as server/db.ts: INT8 stays a string (pg default), DATE stays 'YYYY-MM-DD',
// TIMESTAMP without time zone holds UTC (the legacy "createdAt" columns).
pg.types.setTypeParser(1082, (v) => v);
pg.types.setTypeParser(1114, (v) => new Date(`${v.replace(" ", "T")}Z`));

const SCHEMA_RE = /^[a-z_][a-z0-9_]{0,40}$/;

export function assertSchema(schema: string): string {
  if (!SCHEMA_RE.test(schema)) throw new Error(`Invalid schema name ${JSON.stringify(schema)}`);
  return schema;
}

/** `--schema=` wins over DB_SCHEMA, which defaults to the production schema "alchemy". */
export function resolveSchema(flag?: string): string {
  return assertSchema(flag || process.env.DB_SCHEMA || "alchemy");
}

export function createPool(max = Number(process.env.PG_POOL_MAX || 8)): pg.Pool {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) throw new Error("Missing DATABASE_URL (expected in .env)");
  const pool = new pg.Pool({
    connectionString,
    max,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 20_000,
    maxLifetimeSeconds: 1_500,
    options: "-c statement_timeout=600000 -c idle_in_transaction_session_timeout=600000",
    application_name: "infinite-alchemy-scripts",
  });
  pool.on("error", (err) => console.error("[db] idle client error:", err.message));
  return pool;
}

export function chunk<T>(items: readonly T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

/** Run `fn` over `items` with at most `concurrency` in flight; results keep input order. */
export async function mapConcurrent<T, R>(
  items: readonly T[],
  concurrency: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i]!, i);
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, worker));
  return results;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Retry a single idempotent statement on transient CockroachDB/network errors
 * (40001 serialization, 40003 ambiguous result, connection resets).
 */
export async function retrying<T>(label: string, fn: () => Promise<T>, attempts = 5): Promise<T> {
  for (let i = 1; ; i++) {
    try {
      return await fn();
    } catch (e) {
      const err = e as { code?: string; message?: string };
      const transient =
        err.code === "40001" ||
        err.code === "40003" ||
        err.code === "57P01" ||
        /ECONNRESET|ETIMEDOUT|Connection terminated|socket hang up/i.test(err.message ?? "");
      if (!transient || i >= attempts) throw e;
      console.warn(`[db] ${label}: transient error (${err.code ?? err.message}); retry ${i}/${attempts - 1}`);
      await sleep(250 * 2 ** i + Math.random() * 250);
    }
  }
}

/**
 * Run `fn` in one transaction. The whole transaction is retried on transient errors (40001,
 * 40003, connection resets; see `retrying`), so `fn` must be idempotent and must not call
 * external services.
 */
export async function withTx<T>(pool: pg.Pool, label: string, fn: (c: pg.PoolClient) => Promise<T>): Promise<T> {
  return retrying(label, async () => {
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const out = await fn(client);
      await client.query("COMMIT");
      return out;
    } catch (e) {
      await client.query("ROLLBACK").catch(() => {});
      throw e;
    } finally {
      client.release();
    }
  });
}

/** Format integers with thousands separators for logs. */
export const fmt = (n: number) => n.toLocaleString("en-US");
