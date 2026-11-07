import { describe, expect, it } from "vitest";
import { EDIT_OPTION, NAV_CHANGE_MS, armedKey, changeFromNavKey, isNavKey, sortPick } from "./sortSelectKeys.ts";

describe("isNavKey", () => {
  it("is every key that steps a closed select (and fires change on Windows/Linux)", () => {
    for (const key of ["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", "PageUp", "PageDown", "Home", "End"]) {
      expect(isNavKey({ key }), key).toBe(true);
    }
  });

  it("is a typed character too (type-ahead: \"c\" jumps to Custom…)", () => {
    for (const key of ["c", "C", "a", "r", "✦", "1"]) expect(isNavKey({ key }), key).toBe(true);
  });

  it("is not a key that opens the option list, commits, or is a shortcut", () => {
    expect(isNavKey({ key: "ArrowDown", altKey: true })).toBe(false); // opens the list
    expect(isNavKey({ key: "ArrowUp", metaKey: true })).toBe(false);
    expect(isNavKey({ key: "c", ctrlKey: true })).toBe(false);
    expect(isNavKey({ key: "c", metaKey: true })).toBe(false);
    expect(isNavKey({ key: "c", altKey: true })).toBe(false);
    for (const key of ["Enter", " ", "Escape", "Tab", "F4", "Shift", "Backspace"]) expect(isNavKey({ key }), key).toBe(false);
  });
});

describe("changeFromNavKey", () => {
  it("ties a change to a navigation keydown just before it", () => {
    expect(changeFromNavKey(1_000, 1_000)).toBe(true); // dispatched inside the key's default action
    expect(changeFromNavKey(1_000, 1_000 + NAV_CHANGE_MS - 1)).toBe(true);
  });

  it("treats a later change as deliberate (a pick in a list a key opened, a click)", () => {
    expect(changeFromNavKey(1_000, 1_000 + NAV_CHANGE_MS)).toBe(false);
    expect(changeFromNavKey(1_000, 5_000)).toBe(false);
    expect(changeFromNavKey(null, 1_000)).toBe(false); // no key since the last pointer press / change
    expect(changeFromNavKey(2_000, 1_000)).toBe(false); // clock oddity: never a match
  });
});

describe("sortPick", () => {
  it("arms Custom… when a navigation key stepped onto it, and opens it otherwise", () => {
    for (const current of ["recent", "custom"]) {
      expect(sortPick(EDIT_OPTION, true, current)).toEqual({ do: "arm", option: EDIT_OPTION });
      expect(sortPick(EDIT_OPTION, false, current)).toEqual({ do: "open-sheet" });
    }
  });

  it("arms the stored ✦ sort when a key stepped onto it, so arrowing past it starts no weighing run", () => {
    expect(sortPick("custom", true, "rarity")).toEqual({ do: "arm", option: "custom" });
    expect(sortPick("custom", false, "rarity")).toEqual({ do: "custom" });
  });

  it("disarms when a key steps back onto the ✦ sort that is already active", () => {
    expect(sortPick("custom", true, "custom")).toEqual({ do: "disarm" });
  });

  it("applies the built-in sorts however they were reached (they are instant and free)", () => {
    for (const byKey of [true, false]) {
      expect(sortPick("recent", byKey, "custom")).toEqual({ do: "sort", sort: "recent" });
      expect(sortPick("az", byKey, "recent")).toEqual({ do: "sort", sort: "az" });
      expect(sortPick("rarity", byKey, "recent")).toEqual({ do: "sort", sort: "rarity" });
    }
  });
});

describe("armedKey", () => {
  it("opens on Enter or Space, snaps back on Escape, ignores the rest", () => {
    expect(armedKey("Enter")).toBe("open");
    expect(armedKey(" ")).toBe("open");
    expect(armedKey("Escape")).toBe("disarm");
    expect(armedKey("ArrowUp")).toBeNull();
    expect(armedKey("Tab")).toBeNull();
  });
});
