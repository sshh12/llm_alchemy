import { describe, expect, it } from "vitest";
import { libraryEmptyCopy, weakMatchText } from "./libraryCopy.ts";

const base = { bucket: null, compact: false, query: "", filter: "all" } as const;

describe("weakMatchText (rubric r2 evals)", () => {
  it("suggests a quality, or “or” for a union “and” (which gets no Matches)", () => {
    expect(weakMatchText("weather")).toBe("Nothing clearly matches “weather”. Try a quality, like “cutest”.");
    expect(weakMatchText("fire and ice")).toBe("Nothing clearly matches “fire and ice”. Want either one? Try “fire or ice”.");
    expect(weakMatchText("Fire AND Ice")).toBe("Nothing clearly matches “Fire AND Ice”. Want either one? Try “Fire or Ice”.");
  });

  it("only for the word “and” (not sand, candy, android), replacing its first use", () => {
    expect(weakMatchText("sandy candy android")).toBe("Nothing clearly matches “sandy candy android”. Try a quality, like “cutest”.");
    expect(weakMatchText("cats and dogs and birds")).toBe(
      "Nothing clearly matches “cats and dogs and birds”. Want either one? Try “cats or dogs and birds”.",
    );
  });
});

describe("libraryEmptyCopy", () => {
  it("names the bucket chip that emptied the list (the bar is on screen)", () => {
    expect(libraryEmptyCopy({ ...base, bucket: { kind: "matches", label: "storm" } })).toEqual({
      state: "matches",
      title: "Nothing clearly matches “storm”.",
      body: "Tap Matches again to see everything.",
    });
    expect(libraryEmptyCopy({ ...base, bucket: { kind: "group", name: "Space" } })).toEqual({
      state: "group",
      title: "Nothing in “Space” yet.",
      body: "Tap All to see everything in order.",
    });
  });

  it("in the phone peek row (no bar, no chips) points at opening the library instead", () => {
    for (const bucket of [{ kind: "matches", label: "storm" }, { kind: "group", name: "Other" }] as const) {
      const copy = libraryEmptyCopy({ ...base, compact: true, bucket });
      expect(copy.body).toBe("Open the library to see everything.");
      expect(copy.title).toBe(libraryEmptyCopy({ ...base, bucket }).title);
    }
  });

  it("a bucket wins over the search and filter (it is what emptied the list)", () => {
    expect(libraryEmptyCopy({ ...base, query: "x", filter: "pinned", bucket: { kind: "matches", label: "metal" } }).state).toBe("matches");
  });

  it("keeps the search and filter messages", () => {
    expect(libraryEmptyCopy({ ...base, query: "metal" })).toEqual({ state: "search", title: "No “metal” yet.", body: "Maybe you'll be the one to make it." });
    expect(libraryEmptyCopy({ ...base, compact: true, query: "metal" }).body).toBe("Maybe you'll be the one to make it.");
    expect(libraryEmptyCopy({ ...base, filter: "pinned" }).state).toBe("pinned");
    expect(libraryEmptyCopy({ ...base, filter: "new" }).state).toBe("new");
    expect(libraryEmptyCopy({ ...base, filter: "firsts" }).state).toBe("firsts");
    expect(libraryEmptyCopy(base)).toEqual({ state: "empty", title: "Your library is empty.", body: null });
  });
});
