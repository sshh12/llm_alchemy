import { describe, expect, it } from "vitest";
import { SORT_GROUPS_MAX } from "../../../shared/api.ts";
import { normalizeSpec, specKey, type SortSpecProblem } from "../../../shared/sortSpec.ts";
import {
  GROUPS_EXAMPLES,
  RANK_EXAMPLES,
  RANK_HELPER,
  applyLabel,
  groupPlaceholder,
  isLiveProblem,
  listHint,
  problemCopy,
  problemRow,
} from "./customSortExamples.ts";

describe("examples", () => {
  it("match the spec's chips", () => {
    expect(RANK_EXAMPLES.map((e) => `${e.emoji} ${e.label}`)).toEqual([
      "👻 Spookiest",
      "🪐 Biggest",
      "🐶 Cutest",
      "🔥 Hottest",
      "🍳 Things in a kitchen",
      "🌊 Related to the ocean",
      "☠️ Most dangerous",
      "🦖 Oldest",
    ]);
    expect(GROUPS_EXAMPLES.map((e) => [e.groups, e.other])).toEqual([
      [["Animals", "Food & drink", "Weather"], true],
      [["Fire", "Water", "Earth", "Air"], false],
      [["On land", "In the sea", "In the sky", "In outer space"], false],
      [["Living things", "Nature", "Made by people", "Ideas"], false],
      [["Heroes", "Villains"], true],
    ]);
  });

  it("are already normalized specs, so filling the form and applying sends exactly them", () => {
    for (const ex of RANK_EXAMPLES) {
      expect(normalizeSpec({ kind: "rank", prompt: ex.prompt })).toEqual({ ok: true, spec: { kind: "rank", prompt: ex.prompt } });
    }
    for (const ex of GROUPS_EXAMPLES) {
      expect(normalizeSpec({ kind: "groups", groups: ex.groups })).toEqual({ ok: true, spec: { kind: "groups", groups: ex.groups } });
    }
  });

  it("have unique ids (data-example) and unique specs", () => {
    const ids = [...RANK_EXAMPLES, ...GROUPS_EXAMPLES].map((e) => e.id);
    expect(new Set(ids).size).toBe(ids.length);
    const keys = [
      ...RANK_EXAMPLES.map((e) => specKey({ kind: "rank", prompt: e.prompt })),
      ...GROUPS_EXAMPLES.map((e) => specKey({ kind: "groups", groups: e.groups })),
    ];
    expect(new Set(keys).size).toBe(keys.length);
  });
});

describe("groupPlaceholder", () => {
  it("names three examples, then asks for another", () => {
    expect([0, 1, 2, 3, 7].map(groupPlaceholder)).toEqual(["e.g. Animals", "e.g. Food", "e.g. Weather", "Another group", "Another group"]);
  });
});

describe("listHint", () => {
  it("turns a typed list into capitalized groups", () => {
    expect(listHint("animals, food, weather")).toEqual(["Animals", "Food", "Weather"]);
    expect(listHint("fire/water;earth")).toEqual(["Fire", "Water", "Earth"]);
    expect(listHint("  heroes ,\tvillains  ")).toEqual(["Heroes", "Villains"]);
  });

  it("keeps quiet for a plain prompt or a list that can't be groups", () => {
    expect(listHint("spookiest")).toBeNull();
    expect(listHint("things in a kitchen")).toBeNull();
    expect(listHint("spooky,")).toBeNull(); // one part
    expect(listHint(", ,")).toBeNull();
    expect(listHint(Array.from({ length: SORT_GROUPS_MAX + 1 }, (_, i) => `g${i}`).join(","))).toBeNull();
    expect(listHint(`cats, ${"x".repeat(33)}`)).toBeNull(); // a part too long for a group
  });

  it("allows up to the group limit, each part up to 32 characters", () => {
    expect(listHint(Array.from({ length: SORT_GROUPS_MAX }, (_, i) => `g${i}`).join(","))).toHaveLength(SORT_GROUPS_MAX);
    expect(listHint(`cats, ${"x".repeat(32)}`)).toEqual(["Cats", "X".concat("x".repeat(31))]);
  });
});

describe("problemCopy", () => {
  it("uses the exact validation copy", () => {
    expect(problemCopy("empty", "rank")).toBe("Describe an order first.");
    expect(problemCopy("empty", "groups")).toBe("Add at least two groups.");
    expect(problemCopy("few_groups", "groups")).toBe("Add at least two groups.");
    expect(problemCopy("duplicate_group", "groups")).toBe("That group is already on the list.");
    expect(problemCopy("other_group", "groups")).toBe("Other is added for you.");
  });

  it("has no line for problems the inputs rule out", () => {
    expect(problemCopy("too_long", "rank")).toBeNull();
    expect(problemCopy("many_groups", "groups")).toBeNull();
  });

  it("shows only duplicate/Other while typing; missing text waits for an apply attempt", () => {
    const all: SortSpecProblem[] = ["empty", "too_long", "few_groups", "many_groups", "duplicate_group", "other_group"];
    expect(all.filter(isLiveProblem)).toEqual(["duplicate_group", "other_group"]);
  });
});

describe("problemRow", () => {
  it("points an apply attempt at the row to fix", () => {
    expect(problemRow(["Animals", "", ""], "few_groups")).toBe(1); // the first blank row to fill
    expect(problemRow(["", "Animals", ""], "few_groups")).toBe(0);
    expect(problemRow(["", "", ""], "empty")).toBe(0);
    expect(problemRow(["Animals", "  ", "Food"], "empty")).toBe(1); // whitespace is blank
    expect(problemRow(["Animals", "Food", "animals "], "duplicate_group")).toBe(2); // the repeat, not the first
    expect(problemRow(["Food", "", "food", "Food"], "duplicate_group")).toBe(2);
    expect(problemRow(["Animals", "a", "A", "Other"], "other_group")).toBe(3); // the Other row, not a duplicate
    expect(problemRow(["Animals", ` ${"x".repeat(33)}`], "too_long")).toBe(1);
  });

  it("falls back to the first row", () => {
    expect(problemRow(["Animals", "Food"], "few_groups")).toBe(0);
    expect(problemRow([], "empty")).toBe(0);
  });
});

describe("applyLabel", () => {
  it("says exactly what will happen", () => {
    expect(applyLabel("rank", 340, false)).toBe("Sort 340 elements");
    expect(applyLabel("groups", 1240, false)).toBe("Group 1,240 elements");
    expect(applyLabel("rank", 1, false)).toBe("Sort 1 element");
    expect(applyLabel("groups", 340, true)).toBe("Done");
  });

  it("promises no count while the library is still loading", () => {
    expect(applyLabel("rank", null, false)).toBe("Sort");
    expect(applyLabel("groups", null, false)).toBe("Group");
    expect(applyLabel("rank", null, true)).toBe("Done");
  });
});

describe("copy (rubric r2 evals)", () => {
  it("the Rank helper advertises negation and compounds, exactly", () => {
    expect(RANK_HELPER).toBe(
      "A vibe (“cutest”), a size (“biggest”) or a place (“things in a kitchen”) works best. “Least spooky” and “small and spooky” work too.",
    );
  });
});
