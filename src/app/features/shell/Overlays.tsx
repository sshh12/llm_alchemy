// Lazy-loaded secondary UI (sheets, celebration cards, quick actions) so Radix and the
// sheet code stay off the critical path. Loaded sheets stay mounted so their close
// animation can play; everything is prefetched once the game is idle.
import { lazy, Suspense, useEffect, useState } from "react";
import { bootGame, useGame } from "../../state/game.ts";
import { openSheet, showToast, useUi, type SheetName } from "../../state/ui.ts";
import { KEYS, readString, writeString } from "../../lib/storage.ts";
import { useOnline } from "../../lib/hooks.ts";

const loaders = {
  challenges: () => import("../sheets/ChallengesSheet.tsx"),
  stats: () => import("../sheets/StatsSheet.tsx"),
  settings: () => import("../sheets/SettingsSheet.tsx"),
  about: () => import("../sheets/AboutSheet.tsx"),
} satisfies Record<SheetName, () => Promise<{ default: React.ComponentType<{ open: boolean }> }>>;

const SHEETS = Object.fromEntries(Object.entries(loaders).map(([k, l]) => [k, lazy(l)])) as Record<
  SheetName,
  React.LazyExoticComponent<React.ComponentType<{ open: boolean }>>
>;
const loadCelebration = () => import("../discovery/CelebrationCard.tsx");
const loadQuickActions = () => import("../details/QuickActions.tsx");
const Celebration = lazy(loadCelebration);
const QuickActions = lazy(loadQuickActions);

function prefetchOverlays(): void {
  for (const l of Object.values(loaders)) void l();
  void loadCelebration();
  void loadQuickActions();
}

function SheetHost() {
  const sheet = useUi((s) => s.sheet);
  const [mounted, setMounted] = useState<SheetName[]>([]);
  useEffect(() => {
    if (sheet && !mounted.includes(sheet)) setMounted((m) => [...m, sheet]);
  }, [sheet, mounted]);
  return (
    <Suspense fallback={null}>
      {mounted.map((name) => {
        const C = SHEETS[name];
        return <C key={name} open={sheet === name} />;
      })}
    </Suspense>
  );
}

/** First-run onboarding + the one-time legacy "welcome back" message. */
function useFirstRun(): void {
  const ready = useGame((s) => s.status === "ready");
  const welcome = useGame((s) => s.legacyWelcome);
  useEffect(() => {
    if (!ready) return;
    if (welcome) {
      // Returning 2023 players already know the game: a single notice, no onboarding.
      const n = welcome.restored;
      showToast({
        kind: "info",
        testId: "welcome-back",
        text: n > 0 ? `Welcome back! We restored ${n.toLocaleString("en-US")} of your elements.` : "Welcome back, alchemist! Your lab is ready.",
        duration: 8_000,
      });
      writeString(KEYS.onboarded, "1");
    } else if (readString(KEYS.onboarded) !== "1") {
      useUi.setState({ onboarding: true });
      openSheet("about");
    }
    const idle = (window as Window & { requestIdleCallback?: (cb: () => void) => number }).requestIdleCallback;
    if (idle) idle(prefetchOverlays);
    else setTimeout(prefetchOverlays, 1_500);
  }, [ready, welcome]);
}

function OfflineBanner() {
  const online = useOnline();
  if (online) return null;
  return (
    <div className="pointer-events-none fixed inset-x-0 top-[calc(env(safe-area-inset-top)+60px)] z-[66] flex justify-center px-3" role="status">
      <p className="banner-in rounded-full bg-ink px-4 py-2 text-[13.5px] font-semibold text-surface shadow-lg">
        Offline: you can arrange, but new mixes need a connection
      </p>
    </div>
  );
}

function BootStatus() {
  const status = useGame((s) => s.status);
  const pow = useGame((s) => s.powSolving);
  const error = useGame((s) => s.bootError);
  const [slow, setSlow] = useState(false);
  useEffect(() => {
    const t = setTimeout(() => setSlow(true), 1_200);
    return () => clearTimeout(t);
  }, []);
  if (status === "ready") return null;
  if (status === "error") {
    const offline = error === "network" && navigator.onLine === false;
    return (
      <div className="fixed inset-0 z-[95] grid place-items-center bg-[var(--scrim)] p-6">
        <div className="w-full max-w-[360px] rounded-[26px] border border-border bg-surface p-6 text-center shadow-2xl" role="alert">
          <p className="font-display text-[24px] font-semibold">The kiln won't light</p>
          <p className="mt-2 text-[15px] text-ink-muted">
            {offline
              ? "You're offline. Connect to the internet to start playing."
              : error === "rate_limited"
                ? "Lots of alchemists right now. Try again in a moment."
                : "We couldn't reach the lab. Please try again."}
          </p>
          <button
            type="button"
            className="btn btn-primary mt-5 w-full"
            onClick={() => void bootGame()}
          >
            Try again
          </button>
        </div>
      </div>
    );
  }
  if (!slow && !pow) return null;
  return (
    <div className="pointer-events-none fixed inset-x-0 top-[40%] z-[60] flex justify-center" role="status">
      <p className="pill shadow-lg">
        <span className="h-2 w-2 animate-pulse rounded-full bg-accent" />
        {pow ? "Setting up your lab…" : "Warming up the kiln…"}
      </p>
    </div>
  );
}

export function Overlays() {
  useFirstRun();
  const hasCelebration = useUi((s) => s.celebrations.length > 0);
  const hasDetails = useUi((s) => s.details !== null);
  return (
    <>
      <SheetHost />
      <Suspense fallback={null}>
        {hasCelebration && <Celebration />}
        {hasDetails && <QuickActions />}
      </Suspense>
      <OfflineBanner />
      <BootStatus />
    </>
  );
}
