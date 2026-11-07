// Minimal SQL script splitter for migration files. Splits on top-level semicolons while
// respecting '-- line comments', '/* block comments */', 'single-quoted strings',
// "quoted identifiers" and $tag$ dollar-quoted bodies. Comment-only fragments are dropped.

export function splitSqlStatements(text: string): string[] {
  const out: string[] = [];
  let start = 0;
  let i = 0;
  const n = text.length;
  const push = (end: number) => {
    const stmt = text.slice(start, end).trim();
    if (stripComments(stmt).trim()) out.push(stmt);
  };
  while (i < n) {
    const c = text[i]!;
    const d = text[i + 1];
    if (c === "-" && d === "-") {
      const eol = text.indexOf("\n", i);
      i = eol === -1 ? n : eol + 1;
    } else if (c === "/" && d === "*") {
      const end = text.indexOf("*/", i + 2);
      i = end === -1 ? n : end + 2;
    } else if (c === "'" || c === '"') {
      // Doubled quotes ('' or "") are escapes and simply re-enter the loop.
      const end = text.indexOf(c, i + 1);
      i = end === -1 ? n : end + 1;
    } else if (c === "$") {
      const tag = /^\$[A-Za-z_]?[A-Za-z0-9_]*\$/.exec(text.slice(i))?.[0];
      if (tag) {
        const end = text.indexOf(tag, i + tag.length);
        i = end === -1 ? n : end + tag.length;
      } else i++;
    } else if (c === ";") {
      push(i);
      i++;
      start = i;
    } else i++;
  }
  push(n);
  return out;
}

function stripComments(sql: string): string {
  return sql.replace(/--[^\n]*/g, "").replace(/\/\*[\s\S]*?\*\//g, "");
}
