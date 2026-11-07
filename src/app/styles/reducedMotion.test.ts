// Reduced motion (the OS setting and the in-app override) must stop the custom-sort sweeps
// without hiding them: stopped at 0%, a 300%-wide gradient shows only its faded edge, so a
// pending tile would look just like an unscored one.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const css = readFileSync(new URL("./app.css", import.meta.url), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");

/** The inside of the block whose `{` is the first one at or after `from`. */
function blockAt(src: string, from: number): string {
  const open = src.indexOf("{", from);
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    if (src[i] === "{") depth++;
    else if (src[i] === "}" && --depth === 0) return src.slice(open + 1, i);
  }
  throw new Error("unbalanced braces");
}

/** Flat `selectors { declarations }` rules (nested blocks come out as junk selectors, never matched). */
const rules = (src: string) =>
  [...src.matchAll(/([^{}]+)\{([^{}]*)\}/g)].map((m) => ({
    selectors: m[1]!.split(",").map((s) => s.trim()),
    decls: m[2]!.replace(/\s+/g, " "),
  }));

const media = rules(blockAt(css, css.indexOf("@media (prefers-reduced-motion: reduce)")));
const override = rules(css)
  .filter((r) => r.selectors.every((s) => s.startsWith(':root[data-motion="reduce"] ')))
  .map((r) => ({ ...r, selectors: r.selectors.map((s) => s.slice(':root[data-motion="reduce"] '.length)) }));

const SWEEPS = ['.lt[data-cs="pending"]::after', ".cs-progress"];
const declFor = (rs: typeof media, selector: string, decl: RegExp) => rs.some((r) => r.selectors.includes(selector) && decl.test(r.decls));

describe("reduced motion: custom sort sweeps", () => {
  it("both sweeps are 300%-wide gradients (why a stopped one needs a frame)", () => {
    const base = rules(css);
    for (const s of SWEEPS) expect(declFor(base, s, /background-size: 300% 100%/), s).toBe(true);
  });

  for (const [name, rs] of [
    ["prefers-reduced-motion", media],
    ['data-motion="reduce"', override],
  ] as const) {
    it(`${name}: stops them and shows a static frame with the accent stop`, () => {
      for (const s of SWEEPS) {
        expect(declFor(rs, s, /animation: none !important/), `${s} animation`).toBe(true);
        expect(declFor(rs, s, /background-position: 50% 0/), `${s} static frame`).toBe(true);
      }
    });
  }
});
