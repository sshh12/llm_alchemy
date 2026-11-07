// Unit tests for the small pure client modules: id ordering, legacy parsing, formatting,
// placeholders and the spring math.
import { describe, expect, it } from "vitest";
import { MAX_LEGACY_IDS } from "../../shared/api.ts";
import { compareIds, isCanonicalId, recipeKey, sortIds } from "./ids.ts";
import { formatCountdown, formatPercent, labelLength, msUntilLocalMidnight } from "./format.ts";
import { LEGACY_ELEMENTS_KEY, LEGACY_IMPORTED_KEY, LEGACY_USER_KEY, readLegacy } from "./legacy.ts";
import { fnv1a, placeholderFor } from "./placeholder.ts";

describe("ids", () => {
  it("orders INT8 decimal strings numerically, not lexicographically", () => {
    expect(compareIds("999999999999999999", "1000000000000000000")).toBeLessThan(0);
    expect(sortIds(["1000000000000000002", "999999999999999999", "1000000000000000002"])).toEqual([
      "999999999999999999",
      "1000000000000000002",
      "1000000000000000002",
    ]);
  });
  it("builds order-independent recipe keys that keep duplicates", () => {
    expect(recipeKey(["20", "3", "20"])).toBe("3,20,20");
    expect(recipeKey(["3", "20"])).toBe(recipeKey(["20", "3"]));
  });
  it("recognizes canonical ids", () => {
    expect(isCanonicalId("123")).toBe(true);
    expect(isCanonicalId("0123")).toBe(false);
    expect(isCanonicalId(123)).toBe(false);
  });
});

const store = (entries: Record<string, string>) => (k: string) => entries[k] ?? null;
const UID = "alchemy:2f1c3b9a-1234-4abc-8def-0123456789ab";

describe("readLegacy", () => {
  it("returns null without legacy data", () => {
    expect(readLegacy(store({}))).toBeNull();
  });
  it("reads the 2023 app's user id and element ids", () => {
    const legacy = readLegacy(
      store({
        [LEGACY_USER_KEY]: JSON.stringify({ value: UID }),
        [LEGACY_ELEMENTS_KEY]: JSON.stringify([{ id: "1000000000000000001", name: "fire" }, { id: "42" }, { id: "42" }]),
      }),
    );
    expect(legacy).toEqual({ payload: { userId: UID, elementIds: ["1000000000000000001", "42"] }, marker: UID });
  });
  it("is defensive about garbage", () => {
    const legacy = readLegacy(
      store({
        [LEGACY_USER_KEY]: "not json",
        [LEGACY_ELEMENTS_KEY]: JSON.stringify([null, 5, "7", { id: "x1" }, { id: -3 }, { name: "no id" }]),
      }),
    );
    expect(legacy?.payload).toEqual({ userId: null, elementIds: ["5", "7"] });
    expect(legacy?.marker).toBe("anonymous");
  });
  it("caps element ids", () => {
    const many = Array.from({ length: MAX_LEGACY_IDS + 50 }, (_, i) => ({ id: String(i + 1) }));
    expect(readLegacy(store({ [LEGACY_ELEMENTS_KEY]: JSON.stringify(many) }))?.payload.elementIds).toHaveLength(MAX_LEGACY_IDS);
  });
  it("stops once the import was confirmed for this user", () => {
    expect(readLegacy(store({ [LEGACY_USER_KEY]: JSON.stringify({ value: UID }), [LEGACY_IMPORTED_KEY]: UID }))).toBeNull();
    // A different legacy user on this browser is imported again.
    expect(readLegacy(store({ [LEGACY_USER_KEY]: JSON.stringify({ value: UID }), [LEGACY_IMPORTED_KEY]: "alchemy:other" }))).not.toBeNull();
  });
});

describe("format", () => {
  it("formats share of known elements with one decimal and a floor", () => {
    expect(formatPercent(0, 100)).toBe("0%");
    expect(formatPercent(5, 54_000)).toBe("<0.1%");
    expect(formatPercent(312, 22_000)).toBe("1.4%");
    expect(formatPercent(99_999, 100_000)).toBe("99.9%");
    expect(formatPercent(10, 10)).toBe("100%");
  });
  it("formats countdowns", () => {
    expect(formatCountdown(5 * 3_600_000 + 12 * 60_000)).toBe("5h 12m");
    expect(formatCountdown(90_000)).toBe("1m");
    expect(formatCountdown(4_000)).toBe("4s");
  });
  it("counts down to local midnight", () => {
    const d = new Date(2026, 10, 6, 23, 0, 0);
    expect(msUntilLocalMidnight(d)).toBe(3_600_000);
  });
  it("condenses long labels", () => {
    expect(labelLength("Fire")).toBe("s");
    expect(labelLength("Isaac Newton")).toBe("m");
    expect(labelLength("Philosopher's Stone")).toBe("l");
  });
});

describe("placeholder", () => {
  it("is deterministic and case-insensitive", () => {
    expect(fnv1a("Steam")).toBe(fnv1a("steam"));
    expect(placeholderFor("Steam")).toEqual(placeholderFor("STEAM"));
    const p = placeholderFor("Isaac Newton");
    expect(p.hue).toBeGreaterThanOrEqual(0);
    expect(p.hue).toBeLessThan(360);
  });
});
