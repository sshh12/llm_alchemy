import { describe, expect, it } from "vitest";
import { loadMigrations, renderMigration } from "../migrate.ts";
import { splitSqlStatements } from "./sql.ts";

describe("splitSqlStatements", () => {
  it("splits on top-level semicolons only", () => {
    const sql = `-- header; with a semicolon
CREATE TABLE a (x STRING DEFAULT 'a;b'); /* block; comment */
CREATE TABLE "we;ird" (y INT);
SELECT $$ body; $$;
-- trailing comment only`;
    expect(splitSqlStatements(sql)).toEqual([
      "-- header; with a semicolon\nCREATE TABLE a (x STRING DEFAULT 'a;b')",
      `/* block; comment */\nCREATE TABLE "we;ird" (y INT)`,
      "SELECT $$ body; $$",
    ]);
  });

  it("handles doubled quotes inside strings", () => {
    expect(splitSqlStatements("SELECT 'it''s; fine'; SELECT 2")).toEqual(["SELECT 'it''s; fine'", "SELECT 2"]);
  });
});

describe("migrations", () => {
  it("render every placeholder and split into statements", () => {
    const files = loadMigrations();
    expect(files[0]!.version).toBe("0001_init");
    for (const f of files) {
      const sql = renderMigration(f.sql, "alchemy_e2e");
      expect(sql).not.toContain("{{");
      expect(splitSqlStatements(sql).length).toBeGreaterThan(0);
    }
  });

  it("rejects bad schema names", () => {
    expect(() => renderMigration("x", "bad-name; DROP")).toThrow();
  });
});
