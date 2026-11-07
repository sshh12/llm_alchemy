// Load the repo's .env into process.env for CLI scripts. Variables that are already set
// (e.g. DB_SCHEMA=alchemy_e2e on the command line) win over the file. Never logs values.
// Imported for its side effect as the first import of every script.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

export function loadEnv(file = path.join(REPO_ROOT, ".env")): void {
  if (!fs.existsSync(file)) return;
  for (const line of fs.readFileSync(file, "utf8").split(/\r?\n/)) {
    const m = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/.exec(line);
    if (!m) continue;
    const [, key, raw] = m as unknown as [string, string, string];
    if (process.env[key] !== undefined) continue;
    let value = raw;
    const quoted = /^(['"])(.*)\1$/.exec(value);
    if (quoted) value = quoted[2]!;
    else value = value.replace(/\s+#.*$/, ""); // unquoted trailing comment
    process.env[key] = value;
  }
}

loadEnv();
