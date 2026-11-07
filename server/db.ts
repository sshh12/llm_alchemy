// CockroachDB access via node-postgres. One small pool per function instance,
// reused across warm invocations. Raw SQL; table names come from `t()` so the
// same code runs against the production schema or the e2e schema.
import pg from "pg";
import { env } from "./env.ts";

// INT8 stays a string (pg default). DATE as 'YYYY-MM-DD'. TIMESTAMP (no tz) is stored as UTC.
pg.types.setTypeParser(1082, (v) => v);
pg.types.setTypeParser(1114, (v) => new Date(`${v.replace(" ", "T")}Z`));

let pool: pg.Pool | null = null;

export function getPool(): pg.Pool {
  if (pool) return pool;
  pool = new pg.Pool({
    connectionString: env.databaseUrl,
    max: Number(process.env.PG_POOL_MAX || 3),
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 10_000,
    maxLifetimeSeconds: 1_500,
    options: "-c statement_timeout=15000 -c idle_in_transaction_session_timeout=20000",
    application_name: "infinite-alchemy",
  });
  pool.on("error", (err) => console.error("[db] idle client error", err.message));
  return pool;
}

/** Fully-qualified table name in the configured schema, e.g. t('elements') -> alchemy.elements */
export function t(table: string): string {
  if (!/^[a-z_]+$/.test(table)) throw new Error(`bad table ${table}`);
  return `${env.schema}.${table}`;
}

export type Queryable = Pick<pg.PoolClient, "query">;

export async function q<R extends pg.QueryResultRow = pg.QueryResultRow>(
  text: string,
  params: unknown[] = [],
  client?: Queryable,
): Promise<R[]> {
  const res = await (client ?? getPool()).query<R>(text, params);
  return res.rows;
}

export async function q1<R extends pg.QueryResultRow = pg.QueryResultRow>(
  text: string,
  params: unknown[] = [],
  client?: Queryable,
): Promise<R | undefined> {
  const rows = await q<R>(text, params, client);
  return rows[0];
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Run `fn` in a transaction, retrying CockroachDB serialization failures (40001).
 * `fn` may run more than once: never call external APIs (OpenAI, Blobs) inside it.
 */
export async function withTx<T>(fn: (c: pg.PoolClient) => Promise<T>): Promise<T> {
  const client = await getPool().connect();
  try {
    for (let attempt = 0; ; attempt++) {
      try {
        await client.query("BEGIN");
        const result = await fn(client);
        await client.query("COMMIT");
        return result;
      } catch (e) {
        await client.query("ROLLBACK").catch(() => {});
        const code = (e as { code?: string }).code;
        if (code === "40001" && attempt < 6) {
          await sleep(Math.random() * Math.min(1_000, 25 * 2 ** attempt));
          continue;
        }
        throw e;
      }
    }
  } finally {
    client.release();
  }
}
