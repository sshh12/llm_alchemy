import { describe, expect, it } from "vitest";
import { buildInput, parseTiers, parseVerdicts, sameName, withinOneEdit } from "./classify-recognizable.ts";

const names = ["Geyser", "Temporaplasm", "Ice Sculpture"];
const answer = (items: unknown[]) => ({ items });

describe("buildInput", () => {
  it("numbers the batch 1..n", () => {
    expect(JSON.parse(buildInput(names))).toEqual([
      { id: 1, name: "Geyser" },
      { id: 2, name: "Temporaplasm" },
      { id: 3, name: "Ice Sculpture" },
    ]);
  });
});

describe("parseVerdicts", () => {
  it("maps verdicts back by id, in any order", () => {
    const res = parseVerdicts(
      names,
      answer([
        { id: 3, name: "Ice Sculpture", recognizable: true },
        { id: 1, name: "Geyser", recognizable: true },
        { id: 2, name: "Temporaplasm", recognizable: false },
      ]),
    );
    expect(res).toEqual({ ok: true, verdicts: [true, false, true] });
  });

  it("tolerates casing, spacing and a one-letter copy slip in the echoed name", () => {
    const res = parseVerdicts(
      ["Acidrain", "Mudscreen"],
      answer([
        { id: 1, name: "Acid Rain", recognizable: false },
        { id: 2, name: "Mudscreeen", recognizable: false },
      ]),
    );
    expect(res.ok).toBe(true);
  });

  it("rejects missing, extra, duplicate, unknown or misaligned items", () => {
    const ok = [
      { id: 1, name: "Geyser", recognizable: true },
      { id: 2, name: "Temporaplasm", recognizable: false },
      { id: 3, name: "Ice Sculpture", recognizable: true },
    ];
    expect(parseVerdicts(names, answer(ok.slice(0, 2))).ok).toBe(false);
    expect(parseVerdicts(names, answer([...ok, { id: 4, name: "Salsa", recognizable: true }])).ok).toBe(false);
    expect(parseVerdicts(names, answer([ok[0], ok[0], ok[2]])).ok).toBe(false);
    expect(parseVerdicts(names, answer([ok[0], { ...ok[1], id: 7 }, ok[2]])).ok).toBe(false);
    expect(parseVerdicts(names, answer([ok[0], { ...ok[1], id: "2" }, ok[2]])).ok).toBe(false);
    // Shifted answers: names no longer match their ids.
    expect(parseVerdicts(names, answer([ok[0], { ...ok[1], name: "Ice Sculpture" }, { ...ok[2], name: "Temporaplasm" }])).ok).toBe(false);
    expect(parseVerdicts(names, answer([ok[0], ok[1], { ...ok[2], recognizable: "yes" }])).ok).toBe(false);
    expect(parseVerdicts(names, { list: ok }).ok).toBe(false);
    expect(parseVerdicts(names, null).ok).toBe(false);
  });
});

describe("name matching", () => {
  it("withinOneEdit", () => {
    expect(withinOneEdit("mudscreen", "mudscreeen")).toBe(true);
    expect(withinOneEdit("geyser", "geyzer")).toBe(true);
    expect(withinOneEdit("geyser", "geyse")).toBe(true);
    expect(withinOneEdit("geyser", "geysers!")).toBe(false);
    expect(withinOneEdit("geyser", "gyeser")).toBe(false);
    expect(withinOneEdit("salsa", "mosaic")).toBe(false);
  });

  it("sameName ignores case, spaces, hyphens and apostrophes", () => {
    expect(sameName("Time-Capsule", "time capsule")).toBe(true);
    expect(sameName("Nebula", "Mosaic")).toBe(false);
  });
});

describe("parseTiers", () => {
  it("defaults to the generator's BFS tiers", () => {
    expect(parseTiers(undefined)).toEqual([2, 4, 6]);
    expect(parseTiers("6,2,2,3")).toEqual([2, 3, 6]);
    expect(() => parseTiers("0")).toThrow();
    expect(() => parseTiers("a")).toThrow();
  });
});
