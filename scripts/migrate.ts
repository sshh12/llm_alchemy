// Versioned, idempotent SQL migration runner for CockroachDB.
//
//   npm run db:migrate                              # schema from DB_SCHEMA (default "alchemy")
//   npm run db:migrate -- --schema=alchemy,alchemy_e2e
//
// - Applies db/migrations/NNNN_name.sql in lexical order, substituting {{schema}}.
// - Records version + sha256 (of the template, CRLF-normalized) in <schema>.schema_migrations
//   and refuses to continue if an applied file has since changed.
// - CockroachDB has no advisory locks (pg_try_advisory_lock is a no-op), so a lease row in
//   <schema>.schema_migrations_lock keeps two runners from migrating the same schema at once.
// - Each statement runs on its own (implicit transaction, no explicit BEGIN): migration files
//   must be idempotent (IF NOT EXISTS ...) so a crash mid-file is safe to re-run.
import "./lib/env.ts";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { parseArgs } from "node:util";
import type pg from "pg";
import { isMain, runMain } from "./lib/cli.ts";
import { assertSchema, createPool, resolveSchema } from "./lib/db.ts";
import { REPO_ROOT } from "./lib/env.ts";
import { splitSqlStatements } from "./lib/sql.ts";

export const MIGRATIONS_DIR = path.join(REPO_ROOT, "db", "migrations");
const LEASE = "INTERVAL '10 minutes'";

export interface MigrationFile {
  version: string;
  sql: string;
  checksum: string;
}

export function loadMigrations(dir = MIGRATIONS_DIR): MigrationFile[] {
  return fs
    .readdirSync(dir)
    .filter((f) => /^\d{4,}_[a-z0-9_]+\.sql$/.test(f))
    .sort()
    .map((f) => {
      const sql = fs.readFileSync(path.join(dir, f), "utf8").replace(/\r\n/g, "\n");
      return {
        version: f.replace(/\.sql$/, ""),
        sql,
        checksum: crypto.createHash("sha256").update(sql).digest("hex"),
      };
    });
}

export function renderMigration(sql: string, schema: string): string {
  return sql.replaceAll("{{schema}}", assertSchema(schema));
}

/** Apply pending migrations to `schema`. Returns the number of files applied. */
export async function migrate(pool: pg.Pool, schema: string, log: (msg: string) => void = console.log): Promise<number> {
  assertSchema(schema);
  const files = loadMigrations();
  const client = await pool.connect();
  const holder = `${os.hostname()}:${process.pid}:${crypto.randomUUID()}`;
  let locked = false;
  try {
    await client.query(`CREATE SCHEMA IF NOT EXISTS ${schema}`);
    await client.query(`
      CREATE TABLE IF NOT EXISTS ${schema}.schema_migrations (
        version STRING PRIMARY KEY,
        checksum STRING NOT NULL,
        applied_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        duration_ms INT8 NOT NULL DEFAULT 0
      )`);
    await client.query(`
      CREATE TABLE IF NOT EXISTS ${schema}.schema_migrations_lock (
        id INT8 PRIMARY KEY DEFAULT 1 CHECK (id = 1),
        holder STRING NOT NULL,
        expires_at TIMESTAMPTZ NOT NULL
      )`);
    const got = await client.query(
      `INSERT INTO ${schema}.schema_migrations_lock (id, holder, expires_at) VALUES (1, $1, now() + ${LEASE})
       ON CONFLICT (id) DO UPDATE SET holder = excluded.holder, expires_at = excluded.expires_at
         WHERE ${schema}.schema_migrations_lock.expires_at < now()
       RETURNING holder`,
      [holder],
    );
    if (got.rowCount !== 1) throw new Error(`[${schema}] another migration runner holds the lock (lease not expired)`);
    locked = true;

    const applied = new Map(
      (await client.query<{ version: string; checksum: string }>(`SELECT version, checksum FROM ${schema}.schema_migrations`)).rows.map(
        (r) => [r.version, r.checksum],
      ),
    );
    const known = new Set(files.map((f) => f.version));
    for (const v of applied.keys()) if (!known.has(v)) log(`[${schema}] warning: applied migration ${v} has no file`);

    let ran = 0;
    for (const file of files) {
      const prev = applied.get(file.version);
      if (prev !== undefined) {
        if (prev !== file.checksum) {
          throw new Error(`[${schema}] migration ${file.version} was edited after being applied (checksum mismatch); add a new file instead`);
        }
        continue;
      }
      const t0 = performance.now();
      const statements = splitSqlStatements(renderMigration(file.sql, schema));
      log(`[${schema}] applying ${file.version} (${statements.length} statements) ...`);
      for (const stmt of statements) await client.query(stmt);
      await client.query(`INSERT INTO ${schema}.schema_migrations (version, checksum, duration_ms) VALUES ($1, $2, $3)`, [
        file.version,
        file.checksum,
        Math.round(performance.now() - t0),
      ]);
      // Renew the lease between files; losing it means someone else may be migrating.
      const renewed = await client.query(
        `UPDATE ${schema}.schema_migrations_lock SET expires_at = now() + ${LEASE} WHERE id = 1 AND holder = $1`,
        [holder],
      );
      if (renewed.rowCount !== 1) throw new Error(`[${schema}] lost the migration lease`);
      ran++;
    }
    log(ran ? `[${schema}] applied ${ran} migration(s)` : `[${schema}] schema up to date (${files.length} migration(s))`);
    return ran;
  } finally {
    if (locked) {
      await client.query(`DELETE FROM ${schema}.schema_migrations_lock WHERE id = 1 AND holder = $1`, [holder]).catch(() => {});
    }
    client.release();
  }
}

if (isMain(import.meta.url)) {
  runMain(async () => {
    const { values } = parseArgs({ options: { schema: { type: "string" } } });
    const schemas = (values.schema ?? resolveSchema()).split(",").map((s) => assertSchema(s.trim()));
    const pool = createPool(2);
    try {
      for (const schema of schemas) await migrate(pool, schema);
    } finally {
      await pool.end();
    }
  });
}
