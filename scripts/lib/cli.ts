// Tiny helpers shared by the CLI entry points.
import path from "node:path";
import { fileURLToPath } from "node:url";

/** True when the module at `metaUrl` is the script node/tsx was started with. */
export function isMain(metaUrl: string): boolean {
  const entry = process.argv[1];
  if (!entry) return false;
  const norm = (p: string) => {
    const r = path.resolve(p).replace(/\.ts$/, "");
    return process.platform === "win32" ? r.toLowerCase() : r;
  };
  return norm(fileURLToPath(metaUrl)) === norm(entry);
}

/** Run an async main, print the error and exit non-zero on failure. */
export function runMain(main: () => Promise<void>): void {
  main().then(
    () => process.exit(0),
    (e: unknown) => {
      console.error(e instanceof Error ? (e.stack ?? e.message) : e);
      process.exit(1);
    },
  );
}

/** Print rows as an aligned plain-text table. */
export function printTable(rows: Record<string, string | number>[]): void {
  if (rows.length === 0) return;
  const cols = Object.keys(rows[0]!);
  const width = cols.map((c) => Math.max(c.length, ...rows.map((r) => String(r[c] ?? "").length)));
  const line = (vals: string[]) => vals.map((v, i) => v.padEnd(width[i]!)).join("  ");
  console.log(line(cols));
  console.log(line(width.map((w) => "-".repeat(w))));
  for (const r of rows) console.log(line(cols.map((c) => String(r[c] ?? ""))));
}
