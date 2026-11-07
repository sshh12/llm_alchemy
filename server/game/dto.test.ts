import { describe, expect, it } from "vitest";
import { RARITY_MIN_DEPTH, RARITY_ORDER } from "../../src/shared/rarity.ts";
import { candidateCost } from "./combine.ts";
import { artState, isElementId, sortIds, toElementDTO, toLibraryEntry, type ElementRow } from "./dto.ts";

const row = (over: Partial<ElementRow> = {}): ElementRow => ({
  id: "1083333177628557313",
  name: "Steam",
  emoji: "♨️",
  description: "Hot vapor.",
  notable: false,
  depth: 1,
  steps: 1,
  is_starter: false,
  status: "active",
  image_status: "none",
  image_key: null,
  ...over,
});

describe("recipe keys", () => {
  it("sorts ids numerically, not lexicographically, keeping duplicates", () => {
    const a = "999999999999999999"; // 18 digits
    const b = "1000000000000000000"; // 19 digits
    expect([a, b].sort()).toEqual([b, a]); // the legacy (string) order
    expect(sortIds([b, a])).toEqual([a, b]);
    expect(sortIds([b, a, b])).toEqual([a, b, b]);
    // Ids beyond 2^53 that collide as JS numbers still order correctly.
    expect(sortIds(["9007199254740993", "9007199254740992"])).toEqual(["9007199254740992", "9007199254740993"]);
  });

  it("is order-independent", () => {
    const ids = ["1225355715905617921", "866674527284625410", "1083333177628557313"];
    expect(sortIds(ids)).toEqual(sortIds([...ids].reverse()));
  });

  it("validates INT8 ids", () => {
    expect(isElementId("1")).toBe(true);
    expect(isElementId("9223372036854775807")).toBe(true);
    expect(isElementId("9223372036854775808")).toBe(false);
    expect(isElementId("0")).toBe(false);
    expect(isElementId("01")).toBe(false);
    expect(isElementId("-5")).toBe(false);
    expect(isElementId("1e5")).toBe(false);
    expect(isElementId(12)).toBe(false);
  });
});

describe("element DTOs", () => {
  it("maps art state and image path", () => {
    expect(artState(row())).toBe("missing");
    expect(artState(row({ image_status: "pending" }))).toBe("missing");
    expect(artState(row({ image_status: "failed" }))).toBe("missing");
    expect(artState(row({ image_status: "blocked" }))).toBe("blocked");
    expect(artState(row({ image_status: "ready", image_key: null }))).toBe("missing");
    const ready = toElementDTO(row({ image_status: "ready", image_key: "0123456789abcdef.webp" }));
    expect(ready.art).toBe("ready");
    expect(ready.img).toBe("/img/1083333177628557313/0123456789abcdef.webp");
    expect(toElementDTO(row()).img).toBeNull();
  });

  it("derives rarity from depth", () => {
    expect(toElementDTO(row({ depth: null })).rarity).toBe("common");
    for (const tier of RARITY_ORDER) {
      const min = RARITY_MIN_DEPTH[tier];
      expect(toElementDTO(row({ depth: min })).rarity).toBe(tier);
      if (min > 0) expect(toElementDTO(row({ depth: min - 1 })).rarity).not.toBe(tier);
    }
  });

  it("exposes exactly the contract fields", () => {
    expect(Object.keys(toElementDTO(row())).sort()).toEqual(
      ["art", "depth", "description", "emoji", "id", "img", "name", "notable", "rarity", "starter"].sort(),
    );
  });

  it("marks firsts in library entries", () => {
    const at = new Date("2026-11-06T12:00:00Z");
    const mine = toLibraryEntry({ ...row(), discovered_at: at, discovered_by: "42" }, "42");
    expect(mine).toMatchObject({ first: true, discoveredAt: "2026-11-06T12:00:00.000Z" });
    expect(toLibraryEntry({ ...row(), discovered_at: at, discovered_by: null }, "42").first).toBe(false);
  });
});

describe("depth / steps of a new recipe", () => {
  it("uses 1 + max depth and 1 + sum of distinct ingredient steps", () => {
    const fire = { id: "1", depth: 0, steps: 0 };
    const steam = { id: "2", depth: 1, steps: 1 };
    const cloud = { id: "3", depth: 2, steps: 3 };
    expect(candidateCost([fire, steam])).toEqual({ depth: 2, steps: 2 });
    expect(candidateCost([steam, cloud])).toEqual({ depth: 3, steps: 5 });
    expect(candidateCost([steam, steam])).toEqual({ depth: 2, steps: 2 }); // duplicates count once
  });

  it("is unknown if any ingredient is unknown", () => {
    expect(candidateCost([{ id: "1", depth: 0, steps: 0 }, { id: "2", depth: null, steps: null }])).toEqual({
      depth: null,
      steps: null,
    });
  });
});
