import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { identify } from "./analytics.ts";
import {
  canInstall,
  installVersion,
  isIpad,
  onAppInstalled,
  onBeforeInstallPrompt,
  promptInstall,
  resetInstallForTests,
  subscribeInstall,
  watchInstall,
  type BeforeInstallPromptEvent,
} from "./install.ts";

/** A stand-in for Chromium's event; `answer` is what the player picks in the dialog. */
function fakePrompt(answer: "accepted" | "dismissed" | "throws" = "dismissed") {
  const e = new Event("beforeinstallprompt", { cancelable: true }) as BeforeInstallPromptEvent;
  const prompt = vi.fn(async () => {
    if (answer === "throws") throw new DOMException("not allowed", "NotAllowedError");
  });
  Object.assign(e, { prompt, userChoice: Promise.resolve({ outcome: answer === "throws" ? "dismissed" : answer }) });
  return { e, prompt };
}

let events: [string, unknown][];

// These tests run after bootstrap: install_eligible waits for identify() (see "before bootstrap").
beforeAll(() => identify("player", { legacy: false }));

beforeEach(() => {
  resetInstallForTests();
  events = [];
  vi.stubGlobal("window", {
    gtag: (_cmd: string, name: string, params: unknown) => events.push([name, params]),
  });
});

afterEach(() => vi.unstubAllGlobals());

describe("beforeinstallprompt", () => {
  it("treatment holds the browser prompt back and can show it later, once", async () => {
    const { e, prompt } = fakePrompt("accepted");
    onBeforeInstallPrompt(e, true);
    expect(e.defaultPrevented).toBe(true);
    expect(canInstall()).toBe(true);
    expect(events).toContainEqual(["install_eligible", { prevented: true, arm: "control" }]);

    expect(await promptInstall()).toBe("accepted");
    expect(prompt).toHaveBeenCalledOnce();
    expect(events).toContainEqual(["install_prompt", { outcome: "accepted" }]);
    expect(canInstall()).toBe(false); // an event prompts once
    expect(await promptInstall()).toBe("failed");
    expect(prompt).toHaveBeenCalledOnce();

    onAppInstalled();
    expect(events).toContainEqual(["install", { via: "prompt" }]);
  });

  it("control keeps the browser default (no preventDefault)", () => {
    const { e } = fakePrompt();
    onBeforeInstallPrompt(e, false);
    expect(e.defaultPrevented).toBe(false);
    expect(events).toContainEqual(["install_eligible", { prevented: false, arm: "control" }]);
  });

  it("reports a dismissed or refused prompt", async () => {
    onBeforeInstallPrompt(fakePrompt("dismissed").e, true);
    expect(await promptInstall()).toBe("dismissed");
    onBeforeInstallPrompt(fakePrompt("throws").e, true);
    expect(await promptInstall()).toBe("failed");
    expect(events.filter(([n]) => n === "install_prompt").map(([, p]) => p)).toEqual([{ outcome: "dismissed" }, { outcome: "failed" }]);
  });

  it("an install from the browser's own menu is via browser, and ends the offer", () => {
    onBeforeInstallPrompt(fakePrompt().e, true);
    onAppInstalled();
    expect(canInstall()).toBe(false);
    expect(events).toContainEqual(["install", { via: "browser" }]);
  });

  it("notifies subscribers on every change", async () => {
    const seen: number[] = [];
    const off = subscribeInstall(() => seen.push(installVersion()));
    onBeforeInstallPrompt(fakePrompt().e, true);
    await promptInstall();
    off();
    onAppInstalled();
    expect(seen).toHaveLength(2);
  });

  it("watchInstall listens once and reads the arm when the event fires", () => {
    const target = new EventTarget();
    let treatment = false;
    watchInstall(target as unknown as Window, () => treatment);
    watchInstall(target as unknown as Window, () => true); // idempotent
    const first = fakePrompt();
    target.dispatchEvent(first.e);
    expect(first.e.defaultPrevented).toBe(false);
    treatment = true;
    const second = fakePrompt();
    target.dispatchEvent(second.e);
    expect(second.e.defaultPrevented).toBe(true);
    target.dispatchEvent(new Event("appinstalled"));
    expect(canInstall()).toBe(false);
  });
});

describe("before bootstrap", () => {
  const TREATED = "0b3e5a1c-7d2f-4c8e-9a6b-1f2e3d4c5111"; // odd digit 34: idleCard treatment

  it("install_eligible waits for identify(), then carries the player's real arm", async () => {
    vi.resetModules();
    const analytics = await import("./analytics.ts");
    const install = await import("./install.ts");
    const { useGame } = await import("../state/game.ts");
    const { e } = fakePrompt();
    install.onBeforeInstallPrompt(e, false); // no arm known yet: the browser default
    expect(e.defaultPrevented).toBe(false);
    expect(events.filter(([n]) => n === "install_eligible")).toEqual([]);
    useGame.setState({ player: { id: TREATED, createdAt: "2026-11-30T00:00:00Z", legacy: false } });
    analytics.identify(TREATED, { legacy: false });
    expect(events.filter(([n]) => n === "install_eligible")).toEqual([["install_eligible", { prevented: false, arm: "treatment" }]]);
    useGame.setState({ player: null });
  });
});

describe("isIpad", () => {
  const SAFARI_IPAD = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.1 Safari/605.1.15";
  it("is a 'Mac' with touch, or an iPad UA", () => {
    expect(isIpad(SAFARI_IPAD, 5)).toBe(true);
    expect(isIpad(SAFARI_IPAD, 0)).toBe(false); // a real Mac
    expect(isIpad("Mozilla/5.0 (iPad; CPU OS 18_1 like Mac OS X) AppleWebKit/605.1.15 CriOS/131.0 Mobile/15E148 Safari/604.1", 5)).toBe(true);
    expect(isIpad("Mozilla/5.0 (iPhone; CPU iPhone OS 18_1 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148", 5)).toBe(false);
    expect(isIpad("Mozilla/5.0 (X11; CrOS x86_64 14541.0.0) AppleWebKit/537.36 Chrome/131.0 Safari/537.36", 10)).toBe(false);
  });
});
