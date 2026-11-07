// Top bar: wordmark (→ About), daily-challenge chip, stats chip, settings.
import { AnimatePresence, m } from "motion/react";
import { useEffect, useRef, useState } from "react";
import type { Tier } from "../../../shared/api.ts";
import { formatCount, formatPercent } from "../../lib/format.ts";
import { useGame } from "../../state/game.ts";
import { openSheet } from "../../state/ui.ts";
import { FlameIcon, LayersIcon, LogoMark, SettingsIcon } from "../../components/Icons.tsx";

const TIERS: Tier[] = ["easy", "hard", "expert"];
export const TIER_COLOR: Record<Tier, string> = { easy: "var(--easy)", hard: "var(--hard)", expert: "var(--expert)" };
export const TIER_LABEL: Record<Tier, string> = { easy: "Easy", hard: "Hard", expert: "Expert" };

/** A number that rolls when it changes. */
export function Rolling({ value, className = "" }: { value: string | number; className?: string }) {
  return (
    <span className={`relative inline-grid overflow-hidden ${className}`}>
      <AnimatePresence mode="popLayout" initial={false}>
        <m.span
          key={value}
          className="tabular col-start-1 row-start-1"
          initial={{ y: "70%", opacity: 0 }}
          animate={{ y: 0, opacity: 1 }}
          exit={{ y: "-70%", opacity: 0 }}
          transition={{ type: "spring", visualDuration: 0.3, bounce: 0.2 }}
        >
          {value}
        </m.span>
      </AnimatePresence>
    </span>
  );
}

/** How many times `value` has gone up since the game loaded (bootstrap values don't count). */
function useIncreases(value: number): number {
  const ready = useGame((s) => s.status === "ready");
  const prev = useRef<number | null>(null);
  const [count, setCount] = useState(0);
  useEffect(() => {
    if (!ready) return;
    if (prev.current !== null && value > prev.current) setCount((c) => c + 1);
    prev.current = value;
  }, [value, ready]);
  return count;
}

/** A tier pip; it pops when the tier is completed during play. */
function Pip({ tier, done }: { tier: Tier; done: boolean }) {
  const pops = useIncreases(done ? 1 : 0);
  return (
    <span
      key={pops}
      className="pip"
      style={{ color: TIER_COLOR[tier] }}
      data-done={done ? "" : undefined}
      data-pop={pops > 0 ? "" : undefined}
    />
  );
}

function ChallengeChip() {
  const challenge = useGame((s) => s.challenge);
  const streak = useGame((s) => s.stats.streak.current);
  const flares = useIncreases(streak);
  const done = new Set(challenge?.targets.filter((t) => t.completed).map((t) => t.tier));
  const label = challenge
    ? `Daily challenges: ${done.size} of 3 complete${streak ? `, ${streak}-day streak` : ""}`
    : "Daily challenges";
  return (
    <button type="button" className="pill-hit" aria-label={label} data-testid="challenge-chip" onClick={() => openSheet("challenges")}>
      <span className="pill">
        <span className="flex items-center gap-[5px]" aria-hidden="true">
          {TIERS.map((t) => (
            <Pip key={t} tier={t} done={done.has(t)} />
          ))}
        </span>
        {streak > 0 && (
          <span className="flex items-center gap-0.5 text-accent" aria-hidden="true">
            <FlameIcon key={flares} size={15} className="flame" data-pulse={flares > 0 ? "" : undefined} />
            <Rolling value={streak} />
          </span>
        )}
      </span>
    </button>
  );
}

function StatsChip() {
  const mine = useGame((s) => s.stats.mine);
  const known = useGame((s) => s.stats.known);
  const ready = useGame((s) => s.status === "ready");
  const pct = formatPercent(mine, known);
  return (
    <button
      type="button"
      className="pill-hit"
      aria-label={`Your elements: ${mine}, ${pct} of all known`}
      data-testid="stats-chip"
      onClick={() => openSheet("stats")}
    >
      <span className="pill">
        <LayersIcon size={16} className="text-accent" />
        {ready ? (
          <span data-testid="library-count" data-count={mine}>
            <Rolling value={formatCount(mine)} />
          </span>
        ) : (
          <span className="shimmer h-3 w-8 rounded" />
        )}
        {ready && <span className="hidden text-ink-muted min-[430px]:inline">· {pct}</span>}
      </span>
    </button>
  );
}

export function TopBar() {
  return (
    <header className="topbar">
      <button
        type="button"
        className="-ml-1 flex min-h-11 min-w-0 items-center gap-1.5 rounded-xl px-1"
        aria-label="Infinite Alchemy: about and how to play"
        onClick={() => openSheet("about")}
      >
        <LogoMark size={28} />
        <span className="flex min-w-0 flex-col items-start leading-none">
          {/* Below 380px there is only room for "Alchemy" next to the chips. */}
          <span className="whitespace-nowrap text-[10px] font-semibold uppercase tracking-[0.16em] text-accent max-[339px]:hidden">The original</span>
          <span
            className="whitespace-nowrap font-display text-[21px] font-semibold tracking-[-0.01em] text-ink min-[380px]:text-[16px] min-[420px]:text-[19px] sm:text-[21px]"
            style={{ fontVariationSettings: '"SOFT" 100' }}
          >
            <span className="max-[379px]:hidden">Infinite </span>Alchemy
          </span>
        </span>
      </button>
      <span className="flex-1" />
      <ChallengeChip />
      <StatsChip />
      <button type="button" className="icon-btn" aria-label="Settings" data-testid="menu-button" onClick={() => openSheet("settings")}>
        <SettingsIcon size={21} />
      </button>
    </header>
  );
}
