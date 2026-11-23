// "Today in your lab" (experiment idleCard, treatment only): once a local day, after 10+
// discoveries, a quiet card at the bottom of the workbench when the player pauses (idleCard.ts
// has the rules). It ends the session on a high (today's discoveries and world firsts), teases
// tomorrow's easy target as a silhouette with the countdown, and offers the two ways back:
// install the app (or the iPad Add to Home Screen tip) and "Play at home" (Settings' transfer
// QR). Not a modal: it takes no focus, every button is keyboard reachable, Escape inside it
// dismisses, and it steps aside for onboarding, sheets, celebration cards and other dialogs.
import "../../styles/idle.css";
import { useEffect, useMemo, useRef, useState, useSyncExternalStore, type CSSProperties } from "react";
import { localDay } from "../../../shared/dates.ts";
import { track } from "../../lib/analytics.ts";
import { thumbUrl } from "../../lib/api.ts";
import { arm } from "../../lib/experiments.ts";
import { formatCount, formatCountdown, msUntilLocalMidnight } from "../../lib/format.ts";
import { useLayoutTier, useNow } from "../../lib/hooks.ts";
import { canInstall, installTip, installVersion, promptInstall, subscribeInstall, watchInstall } from "../../lib/install.ts";
import { useGame } from "../../state/game.ts";
import { openSheet, useUi } from "../../state/ui.ts";
import { CloseIcon } from "../../components/Icons.tsx";
import { useDrag } from "../workbench/drag.ts";
import {
  ActivityClock,
  MIN_DISCOVERIES,
  attentionBusy,
  currentTimings,
  markShown,
  secsSince,
  shownOn,
  tickMs,
  todayCounts,
  trigger,
  type Trigger,
} from "./idleCard.ts";

// From app start: Chrome can fire beforeinstallprompt long before the card is due.
watchInstall();

const INPUTS = ["pointerdown", "pointermove", "keydown", "wheel", "touchstart"] as const;
const RAIL_QUERY = "(min-width: 640px)";


/** Any open dialog at all (the transfer prompt, the reset confirm, ...): never appear over one. */
function dialogOpen(): boolean {
  try {
    return document.querySelector('[role="dialog"], [role="alertdialog"]') !== null;
  } catch {
    return false;
  }
}

function railLayout(): boolean {
  try {
    return matchMedia(RAIL_QUERY).matches;
  } catch {
    return true;
  }
}

interface Shown {
  at: number;
  via: Trigger;
}

/** What the card can offer for getting back: the install prompt, the iPad tip, or neither. */
function offer(): "install" | "tip" | "none" {
  return canInstall() ? "install" : installTip() ? "tip" : "none";
}

export function IdleCard() {
  const ready = useGame((s) => s.status === "ready");
  const { rail } = useLayoutTier();
  const hidden = useUi((s) => attentionBusy(s, rail));
  const [shown, setShown] = useState<Shown | null>(null);
  /** A card is up (the interval reads this, not React state). */
  const up = useRef(false);
  useEffect(() => {
    up.current = shown !== null;
  }, [shown]);

  useEffect(() => {
    if (!ready || arm("idleCard") !== "treatment") return;
    const t = currentTimings();
    const clock = new ActivityClock(Date.now(), t.idleMs);
    const onInput = () => clock.input(Date.now());
    const onVisibility = () => (document.visibilityState === "visible" ? clock.show(Date.now()) : clock.hide());
    const opts = { capture: true, passive: true } as const;
    for (const ev of INPUTS) addEventListener(ev, onInput, opts);
    document.addEventListener("visibilitychange", onVisibility);
    const timer = setInterval(() => {
      const now = Date.now();
      const day = localDay(new Date(now));
      if (up.current || document.visibilityState !== "visible" || shownOn(day)) return;
      const via = trigger(clock, now, t);
      if (!via || attentionBusy(useUi.getState(), railLayout()) || useDrag.getState().source !== null || dialogOpen()) return;
      const g = useGame.getState();
      if (g.status !== "ready") return;
      const counts = todayCounts(g.owned, g.elements, new Date(now));
      if (counts.discoveries < MIN_DISCOVERIES) return;
      markShown(day);
      setShown({ at: now, via });
      // discoveries / firsts: today's, as shown. offer: install | tip | none. teaser: art (the
      // target's silhouette) | blank (no art yet: a "?" tile) | none (no teaser from the server).
      track("idle_card", {
        action: "shown",
        via,
        discoveries: counts.discoveries,
        firsts: counts.firsts,
        offer: offer(),
        teaser: g.tomorrow ? (g.tomorrow.img ? "art" : "blank") : "none",
      });
    }, tickMs(t));
    return () => {
      clearInterval(timer);
      for (const ev of INPUTS) removeEventListener(ev, onInput, opts);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [ready]);

  // A polite live region that only announces additions: the card arriving, not its countdown ticking.
  return (
    <div className="idle-live" aria-live="polite" aria-relevant="additions">
      {shown && !hidden && <Card shown={shown} onClose={() => setShown(null)} />}
    </div>
  );
}

/** The art as a CSS mask (idle.css .idle-silhouette-art). Masks load in CORS mode; this URL is same-origin. */
function silhouetteMask(img: string): CSSProperties {
  const url = `url("${thumbUrl(img, 192)}")`;
  return { maskImage: url, WebkitMaskImage: url };
}

function Card({ shown, onClose }: { shown: Shown; onClose: () => void }) {
  const owned = useGame((s) => s.owned);
  const elements = useGame((s) => s.elements);
  const tomorrow = useGame((s) => s.tomorrow);
  const counts = useMemo(() => todayCounts(owned, elements), [owned, elements]);
  const now = useNow(30_000);
  useSyncExternalStore(subscribeInstall, installVersion, installVersion);
  const install = canInstall();
  const tip = !install && installTip() === "ipad";
  const ref = useRef<HTMLElement>(null);
  /** Where keyboard focus came from, to hand it back when the card goes. */
  const returnFocus = useRef<HTMLElement | null>(null);

  const close = (action: "dismiss" | "home") => {
    track("idle_card", { action, secs: secsSince(shown.at) });
    const back = returnFocus.current;
    if (ref.current?.contains(document.activeElement) && back?.isConnected) back.focus({ preventScroll: true });
    onClose();
    // The Settings sheet holds "Play on another device" (code, QR and link).
    if (action === "home") openSheet("settings");
  };

  const onInstall = () => {
    track("idle_card", { action: "install", secs: secsSince(shown.at) });
    void promptInstall(); // tracks install_prompt {outcome}; the button goes either way
  };

  const firsts = counts.firsts;
  return (
    <section
      ref={ref}
      className="idle-card"
      data-testid="idle-card"
      data-via={shown.via}
      aria-labelledby="idle-card-title"
      onFocus={(e) => {
        const from = e.relatedTarget as HTMLElement | null;
        if (from && !ref.current?.contains(from)) returnFocus.current = from;
      }}
      onKeyDown={(e) => {
        if (e.key !== "Escape") return;
        e.stopPropagation(); // not also the workbench's "clear selection"
        close("dismiss");
      }}
    >
      <button type="button" className="idle-close" aria-label="Dismiss" data-testid="idle-card-dismiss" onClick={() => close("dismiss")}>
        <CloseIcon size={18} />
      </button>
      <h2 id="idle-card-title" className="idle-eyebrow">
        Today in your lab
      </h2>
      <p className="idle-stats" data-testid="idle-card-stats" data-discoveries={counts.discoveries} data-firsts={firsts}>
        <strong className="tabular">{formatCount(counts.discoveries)}</strong> {counts.discoveries === 1 ? "discovery" : "discoveries"}
        {firsts > 0 && (
          <>
            {" · "}
            <span className="idle-firsts">
              <strong className="tabular">{formatCount(firsts)}</strong> world {firsts === 1 ? "first" : "firsts"}
            </span>
          </>
        )}
      </p>
      <div className="idle-teaser" data-testid="idle-card-teaser">
        <span className="idle-silhouette" data-art={tomorrow?.img ? "true" : "false"} aria-hidden="true">
          {tomorrow?.img ? <span className="idle-silhouette-art" style={silhouetteMask(tomorrow.img)} /> : <span className="idle-silhouette-q">?</span>}
        </span>
        <span className="min-w-0">
          <span className="block font-semibold">Tomorrow's easy target</span>
          <span className="block text-[13px] text-ink-muted">
            {tomorrow && tomorrow.letters > 0 && <>{tomorrow.letters} letters · </>}
            Next target in <span className="tabular">{formatCountdown(msUntilLocalMidnight(new Date(now)))}</span>
          </span>
        </span>
      </div>
      <div className="idle-actions">
        {install && (
          <button type="button" className="btn btn-sm btn-primary" data-testid="idle-card-install" onClick={onInstall}>
            Install the game
          </button>
        )}
        <button type="button" className="btn btn-sm btn-quiet" data-testid="idle-card-home" onClick={() => close("home")}>
          Play at home
        </button>
      </div>
      {tip && (
        <p className="idle-tip" data-testid="idle-card-tip">
          Keep it on your iPad: tap Share, then Add to Home Screen.
        </p>
      )}
    </section>
  );
}
