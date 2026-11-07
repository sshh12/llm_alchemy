// Haptic feedback. navigator.vibrate works on Chromium Android (needs sticky user
// activation). iOS Safari has no vibrate API; behind IOS_SWITCH_HAPTICS we toggle a hidden
// <input type=checkbox switch>, which produces the system switch tick on Safari 17.4+.
// That trick only works inside a real user gesture, so it is used for gesture-driven kinds.
import { useSettings } from "../state/settings.ts";

export type HapticKind = "pickup" | "lock" | "gather" | "merge" | "new" | "first" | "error";

const PATTERNS: Record<HapticKind, number | number[]> = {
  pickup: 8,
  lock: 12,
  gather: 10,
  merge: [10, 30, 18],
  new: [15, 40, 25],
  first: [20, 40, 20, 40, 60],
  error: [40, 60, 40],
};

const IOS_SWITCH_HAPTICS = true;
const GESTURE_KINDS = new Set<HapticKind>(["pickup", "merge"]);

let switchLabel: HTMLLabelElement | null = null;

function iosTick(): void {
  if (!switchLabel) {
    switchLabel = document.createElement("label");
    switchLabel.setAttribute("aria-hidden", "true");
    switchLabel.style.cssText = "position:fixed;left:-9999px;top:0;opacity:0;pointer-events:none";
    const input = document.createElement("input");
    input.type = "checkbox";
    input.setAttribute("switch", "");
    input.tabIndex = -1;
    switchLabel.appendChild(input);
    document.body.appendChild(switchLabel);
  }
  switchLabel.click();
}

export const supportsHaptics = (): boolean =>
  typeof navigator !== "undefined" && (typeof navigator.vibrate === "function" || (IOS_SWITCH_HAPTICS && isIOS()));

function isIOS(): boolean {
  return /iP(hone|ad|od)/.test(navigator.userAgent) || (navigator.userAgent.includes("Mac") && navigator.maxTouchPoints > 1);
}

export function haptic(kind: HapticKind): void {
  if (!useSettings.getState().haptics) return;
  try {
    if (typeof navigator.vibrate === "function") navigator.vibrate(PATTERNS[kind]);
    else if (IOS_SWITCH_HAPTICS && GESTURE_KINDS.has(kind) && isIOS()) iosTick();
  } catch {
    // Vibration can be blocked by permissions policy; feedback is optional.
  }
}
