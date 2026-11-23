import { afterEach, describe, expect, it, vi } from "vitest";
import { useGame } from "../state/game.ts";
import { PRODUCTION_HOST, arm, armOf, earlyArm, readOverrides } from "./experiments.ts";

const TREATED = "0b3e5a1c-7d2f-4c8e-9a6b-1f2e3d4c5111"; // odd digits at 33, 34 and 35
const CONTROL = "0b3e5a1c-7d2f-4c8e-9a6b-1f2e3d4c5222";

afterEach(() => useGame.setState({ player: null }));

describe("experiment overrides", () => {
  it("are honored off the production host", () => {
    const o = readOverrides("localhost", { firstRun: "treatment", goals: "control" });
    expect(o).toEqual({ firstRun: "treatment", goals: "control" });
    expect(armOf("firstRun", CONTROL, o)).toBe("treatment");
    expect(armOf("goals", TREATED, o)).toBe("control");
    expect(armOf("idleCard", TREATED, o)).toBe("treatment"); // not overridden
    expect(readOverrides("deploy-preview-12--llm-alchemy.netlify.app", { idleCard: "treatment" })).toEqual({ idleCard: "treatment" });
  });

  it("are ignored on the production host", () => {
    const o = readOverrides(PRODUCTION_HOST, { firstRun: "treatment" });
    expect(o).toEqual({});
    expect(armOf("firstRun", CONTROL, o)).toBe("control");
  });

  it("drop unknown names, bad values and garbage", () => {
    expect(readOverrides("localhost", { firstRun: "yes", nope: "treatment", goals: 1 })).toEqual({});
    expect(readOverrides("localhost", "treatment")).toEqual({});
    expect(readOverrides("localhost", null)).toEqual({});
  });
});

describe("arm()", () => {
  it("reads the current player's public id", () => {
    expect(arm("firstRun")).toBe("control"); // before bootstrap
    useGame.setState({ player: { id: TREATED, createdAt: "2026-11-30T00:00:00Z", legacy: false } });
    expect(arm("firstRun")).toBe("treatment");
    useGame.setState({ player: { id: CONTROL, createdAt: "2026-11-30T00:00:00Z", legacy: false } });
    expect(arm("firstRun")).toBe("control");
  });
});

describe("earlyArm()", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("before bootstrap, uses the arms this browser's last player had (never the id)", () => {
    const store = new Map<string, string>();
    vi.stubGlobal("window", {
      localStorage: { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => void store.set(k, v), removeItem: (k: string) => void store.delete(k) },
    });
    expect(earlyArm("idleCard")).toBe("control"); // never booted here
    useGame.setState({ player: { id: TREATED, createdAt: "2026-11-30T00:00:00Z", legacy: false } });
    expect(JSON.parse(store.get("ia:arms")!)).toEqual({ firstRun: "treatment", idleCard: "treatment", goals: "treatment" });
    expect(store.get("ia:arms")).not.toContain(TREATED);
    useGame.setState({ player: null }); // the next page load, before bootstrap answers
    expect(arm("idleCard")).toBe("control");
    expect(earlyArm("idleCard")).toBe("treatment");
    // Once bootstrap names the player, their own arm wins.
    useGame.setState({ player: { id: CONTROL, createdAt: "2026-11-30T00:00:00Z", legacy: false } });
    expect(earlyArm("idleCard")).toBe("control");
    expect(JSON.parse(store.get("ia:arms")!)).toMatchObject({ idleCard: "control" });
    useGame.setState({ player: null });
    store.set("ia:arms", "garbage");
    expect(earlyArm("idleCard")).toBe("control");
  });
});
