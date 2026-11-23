// Install the game as an app (docs/ARCHITECTURE.md "Experiments", the idleCard bet).
// Chrome-family browsers (Chrome OS, Windows, Android) fire `beforeinstallprompt` once the page
// meets their install criteria. No service worker is needed for that any more (Chrome 108 mobile,
// 112 desktop), which matters because main.tsx unregisters every worker on purpose. Every
// eligible session is counted (`install_eligible`); only players in the idleCard treatment arm
// get the browser's own prompt held back (preventDefault) so the "Today in your lab" card can
// offer it at a calmer moment. Control keeps the browser default. iPad has no such event: it
// gets a one-line "Share, then Add to Home Screen" tip instead.
import { afterIdentify, track, trackOncePerSession } from "./analytics.ts";
import { arm, earlyArm } from "./experiments.ts";

/** Chromium's event (not in lib.dom). `prompt()` works once per event and needs a user gesture. */
export interface BeforeInstallPromptEvent extends Event {
  prompt(): Promise<unknown>;
  readonly userChoice: Promise<{ outcome: "accepted" | "dismissed"; platform?: string }>;
}

/** install_prompt `outcome`: the player's answer, or "failed" when the browser refused to show it. */
export type InstallOutcome = "accepted" | "dismissed" | "failed";

/** The deferred event, kept for both arms: stashing changes nothing the player sees. */
let deferred: BeforeInstallPromptEvent | null = null;
/** Our prompt was accepted: the next `appinstalled` came from it, not from the browser's menu. */
let acceptedHere = false;
let installed = false;
let watching = false;
let version = 0;
const listeners = new Set<() => void>();

function changed(): void {
  version++;
  for (const l of listeners) l();
}

/** For useSyncExternalStore: re-read canInstall() whenever this fires. */
export function subscribeInstall(cb: () => void): () => void {
  listeners.add(cb);
  return () => listeners.delete(cb);
}

/** Bumps on every change of the install state (useSyncExternalStore snapshot). */
export const installVersion = (): number => version;

function matches(query: string): boolean {
  try {
    return window.matchMedia(query).matches;
  } catch {
    return false;
  }
}

/** Already running as an installed app (iOS home-screen apps also set navigator.standalone). */
export function isStandalone(): boolean {
  try {
    return matches("(display-mode: standalone)") || (navigator as Navigator & { standalone?: boolean }).standalone === true;
  } catch {
    return false;
  }
}

/**
 * iPad: iPadOS Safari asks for desktop sites, so it says "Macintosh"; only the touch points give
 * it away (Macs report 0). Other iPad browsers still say "iPad". Exported for tests.
 */
export function isIpad(ua: string, maxTouchPoints: number): boolean {
  return /\biPad\b/.test(ua) || (/\bMacintosh\b/.test(ua) && maxTouchPoints > 1);
}

/** "ipad": show the Add to Home Screen tip (an iPad browser tab, not the installed app). */
export function installTip(): "ipad" | null {
  try {
    return isIpad(navigator.userAgent, navigator.maxTouchPoints) && !isStandalone() ? "ipad" : null;
  } catch {
    return null;
  }
}

/** A held-back install prompt is ready to show (from a click: promptInstall). */
export function canInstall(): boolean {
  return deferred !== null && !installed && !isStandalone();
}

/**
 * Show the browser's install dialog. Call it straight from a click (the browser needs the
 * gesture). The event works once, so the button goes away whatever the answer.
 */
export async function promptInstall(): Promise<InstallOutcome> {
  const e = deferred;
  if (!e) return "failed";
  deferred = null;
  changed();
  let outcome: InstallOutcome;
  try {
    await e.prompt();
    outcome = (await e.userChoice).outcome === "accepted" ? "accepted" : "dismissed";
  } catch {
    outcome = "failed";
  }
  if (outcome === "accepted") acceptedHere = true;
  track("install_prompt", { outcome });
  return outcome;
}

/**
 * The browser says this page can be installed. `treatment`: hold it back for the card. The event
 * often fires before bootstrap answers; the arm is then the one this browser's player had last
 * time (earlyArm), so only a player new to this browser keeps the browser default (the event is
 * stashed either way, so a treatment player's card can still offer it). install_eligible waits
 * for identify(), so it carries user_id and exp_idle_card, plus `arm` (the player's real arm)
 * next to `prevented` (what was done), which can differ for an event that early.
 */
export function onBeforeInstallPrompt(e: BeforeInstallPromptEvent, treatment: boolean): void {
  if (treatment) e.preventDefault();
  deferred = e;
  afterIdentify(() => trackOncePerSession("install_eligible", { prevented: treatment, arm: arm("idleCard") }));
  changed();
}

/** The app was installed, from our prompt (`via` prompt) or the browser's own UI (`via` browser). */
export function onAppInstalled(): void {
  installed = true;
  deferred = null;
  track("install", { via: acceptedHere ? "prompt" : "browser" });
  changed();
}

/** Listen from app start (idempotent). `treatment` is read when the event fires. */
export function watchInstall(
  target: Pick<Window, "addEventListener"> | undefined = typeof window !== "undefined" ? window : undefined,
  treatment: () => boolean = () => earlyArm("idleCard") === "treatment",
): void {
  if (watching || !target) return;
  watching = true;
  target.addEventListener("beforeinstallprompt", (e) => onBeforeInstallPrompt(e as BeforeInstallPromptEvent, treatment()));
  target.addEventListener("appinstalled", onAppInstalled);
}

/** Tests only: forget everything. */
export function resetInstallForTests(): void {
  deferred = null;
  acceptedHere = false;
  installed = false;
  watching = false;
  listeners.clear();
}
