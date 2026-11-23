import { describe, expect, it } from "vitest";
import { EXPERIMENTS, armFor, experimentProperty, experimentUserProperties } from "./experiments.ts";

// Last three characters ...<33><34><35>.
const uuid = (tail: string) => `0b3e5a1c-7d2f-4c8e-9a6b-1f2e3d4c5${tail}`;

describe("experiment arms", () => {
  it("uses the digits the snapshot reads (contract K2)", () => {
    expect(EXPERIMENTS.firstRun.digit).toBe(35);
    expect(EXPERIMENTS.idleCard.digit).toBe(34);
    expect(EXPERIMENTS.goals.digit).toBe(33);
    expect(uuid("abc")).toHaveLength(36);
  });

  it("maps an odd hex digit to treatment and an even one to control", () => {
    for (const [ch, arm] of [
      ["0", "control"],
      ["1", "treatment"],
      ["8", "control"],
      ["9", "treatment"],
      ["a", "control"],
      ["b", "treatment"],
      ["E", "control"],
      ["F", "treatment"],
    ] as const) {
      expect(armFor(uuid(`00${ch}`), "firstRun"), ch).toBe(arm);
    }
  });

  it("reads a different digit per experiment", () => {
    const id = uuid("123"); // goals=1, idleCard=2, firstRun=3
    expect(armFor(id, "goals")).toBe("treatment");
    expect(armFor(id, "idleCard")).toBe("control");
    expect(armFor(id, "firstRun")).toBe("treatment");
  });

  it("splits random ids about evenly", () => {
    let treated = 0;
    for (let i = 0; i < 2_000; i++) if (armFor(crypto.randomUUID(), "firstRun") === "treatment") treated++;
    expect(treated).toBeGreaterThan(850);
    expect(treated).toBeLessThan(1_150);
  });

  it("is control for a missing or malformed id", () => {
    expect(armFor(null, "firstRun")).toBe("control");
    expect(armFor(undefined, "goals")).toBe("control");
    expect(armFor("", "idleCard")).toBe("control");
    expect(armFor("short", "firstRun")).toBe("control");
    expect(armFor(uuid("zz-"), "firstRun")).toBe("control");
  });

  it("is control for everyone while an experiment is disabled", () => {
    const exp = EXPERIMENTS.firstRun;
    const was = exp.enabled;
    exp.enabled = false;
    try {
      expect(armFor(uuid("001"), "firstRun")).toBe("control");
    } finally {
      exp.enabled = was;
    }
  });

  it("names GA user properties in snake case", () => {
    expect(experimentProperty("firstRun")).toBe("exp_first_run");
    expect(experimentUserProperties(uuid("123"))).toEqual({
      exp_first_run: "treatment",
      exp_idle_card: "control",
      exp_goals: "treatment",
    });
  });
});
