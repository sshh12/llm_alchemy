// Unit tests for the shared custom-sort spec helpers (cleaning, validation, identity, labels).
import { describe, expect, it } from "vitest";
import { SORT_GROUPS_MAX, SORT_GROUP_MAX_CHARS, SORT_PROMPT_MAX_CHARS, type SortSpec } from "./api.ts";
import { cleanSortText, normalizeSpec, questionsPer, specKey, specLabel, specShortLabel } from "./sortSpec.ts";

const rank = (prompt: string): SortSpec => ({ kind: "rank", prompt });
const groups = (...g: string[]): SortSpec => ({ kind: "groups", groups: g });

describe("cleanSortText", () => {
  it("turns control, format and line/paragraph separators into spaces and collapses whitespace", () => {
    expect(cleanSortText("  spoo\u0000ky\tthings \n\n in​side out  ")).toBe("spoo ky things in side out");
    expect(cleanSortText("a­b﻿c")).toBe("a b c"); // soft hyphen and BOM are format characters
    expect(cleanSortText("‮spooky‬")).toBe("spooky"); // bidi overrides never survive
  });
  it("normalizes to NFC", () => {
    expect(cleanSortText("café")).toBe("café");
  });
  it("keeps ordinary punctuation and emoji", () => {
    expect(cleanSortText("things in a kitchen 🍳, “cutest”")).toBe("things in a kitchen 🍳, “cutest”");
  });
  it("returns an empty string for blank input", () => {
    expect(cleanSortText(" \u0000​\n ")).toBe("");
  });
});

describe("normalizeSpec", () => {
  it("cleans a rank prompt", () => {
    expect(normalizeSpec(rank("  most\u0000  dangerous "))).toEqual({ ok: true, spec: { kind: "rank", prompt: "most dangerous" } });
  });
  it("reports empty prompts", () => {
    expect(normalizeSpec(rank(""))).toEqual({ ok: false, problem: "empty" });
    expect(normalizeSpec(rank(" ​\t "))).toEqual({ ok: false, problem: "empty" });
  });
  it("measures length after cleaning", () => {
    expect(normalizeSpec(rank("x".repeat(SORT_PROMPT_MAX_CHARS)))).toMatchObject({ ok: true });
    expect(normalizeSpec(rank(`  ${"x".repeat(SORT_PROMPT_MAX_CHARS)}  `))).toMatchObject({ ok: true });
    expect(normalizeSpec(rank("x".repeat(SORT_PROMPT_MAX_CHARS + 1)))).toEqual({ ok: false, problem: "too_long" });
  });
  it("drops blank group rows and cleans the rest", () => {
    expect(normalizeSpec(groups(" Animals ", "", "  ", "Food\u0000 & drink"))).toEqual({
      ok: true,
      spec: { kind: "groups", groups: ["Animals", "Food & drink"] },
    });
  });
  it("reports every group problem", () => {
    expect(normalizeSpec(groups("", " "))).toEqual({ ok: false, problem: "empty" });
    expect(normalizeSpec(groups("Animals", ""))).toEqual({ ok: false, problem: "few_groups" });
    const nine = Array.from({ length: SORT_GROUPS_MAX + 1 }, (_, i) => `Group ${i}`);
    expect(normalizeSpec(groups(...nine))).toEqual({ ok: false, problem: "many_groups" });
    expect(normalizeSpec(groups(...nine.slice(0, SORT_GROUPS_MAX)))).toMatchObject({ ok: true });
    expect(normalizeSpec(groups("Animals", "animals "))).toEqual({ ok: false, problem: "duplicate_group" });
    expect(normalizeSpec(groups("Animals", " OTHER"))).toEqual({ ok: false, problem: "other_group" });
    expect(normalizeSpec(groups("Animals", "x".repeat(SORT_GROUP_MAX_CHARS + 1)))).toEqual({ ok: false, problem: "too_long" });
    expect(normalizeSpec(groups("Animals", "x".repeat(SORT_GROUP_MAX_CHARS)))).toMatchObject({ ok: true });
  });
  it("is defensive about non-string data (e.g. from storage)", () => {
    expect(normalizeSpec({ kind: "rank", prompt: 5 } as unknown as SortSpec)).toEqual({ ok: false, problem: "empty" });
    expect(normalizeSpec({ kind: "groups", groups: "Animals" } as unknown as SortSpec)).toEqual({ ok: false, problem: "empty" });
    expect(normalizeSpec({ kind: "groups", groups: ["A", 3, null, "B"] } as unknown as SortSpec)).toEqual({
      ok: true,
      spec: { kind: "groups", groups: ["A", "B"] },
    });
  });
});

describe("specKey", () => {
  it("is case-insensitive", () => {
    expect(specKey(rank("Spookiest"))).toBe(specKey(rank("spookiest")));
    expect(specKey(groups("Animals", "Food"))).toBe(specKey(groups("ANIMALS", "food")));
  });
  it("depends on group order and kind", () => {
    expect(specKey(groups("Animals", "Food"))).not.toBe(specKey(groups("Food", "Animals")));
    expect(specKey(rank("animals"))).not.toBe(specKey(groups("animals", "x")));
  });
  it("cannot be confused by a comma inside a group", () => {
    expect(specKey(groups("a,b", "c"))).not.toBe(specKey(groups("a", "b,c")));
  });
  it("is equal after cleaning", () => {
    const a = normalizeSpec(rank("  spooky\u0000  things "));
    const b = normalizeSpec(rank("Spooky things"));
    expect(a.ok && b.ok && specKey(a.spec) === specKey(b.spec)).toBe(true);
  });
});

describe("labels", () => {
  it("full label: the prompt, or the groups joined", () => {
    expect(specLabel(rank("spookiest"))).toBe("spookiest");
    expect(specLabel(groups("Animals", "Food", "Weather"))).toBe("Animals · Food · Weather");
  });
  it("short label: capitalized prompt or first group + count, truncated after 12 characters", () => {
    expect(specShortLabel(rank("spookiest"))).toBe("Spookiest");
    expect(specShortLabel(rank("x".repeat(12)))).toBe(`X${"x".repeat(11)}`);
    expect(specShortLabel(rank("things in a kitchen"))).toBe("Things in a…");
    expect(specShortLabel(rank("related to the ocean"))).toBe("Related to t…");
    expect(specShortLabel(groups("Animals", "Food", "Weather"))).toBe("Animals +2");
    expect(specShortLabel(groups("Living things", "Nature"))).toBe("Living thing…");
  });
  it("trims a trailing space before the ellipsis", () => {
    expect(specShortLabel(rank("biggest and best"))).toBe("Biggest and…");
  });
  it("questions per element", () => {
    expect(questionsPer(rank("x"))).toBe(1);
    expect(questionsPer(groups("a", "b"))).toBe(2);
  });
});
