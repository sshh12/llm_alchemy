// Daily challenges: today's three targets (with art and min-combo hints), completion
// state, streak, countdown to tomorrow, and the history of completed days.
import type { CSSProperties } from "react";
import type { ChallengeTarget, Tier } from "../../../shared/api.ts";
import { formatCountdown, formatDay, msUntilLocalMidnight } from "../../lib/format.ts";
import { useNow } from "../../lib/hooks.ts";
import { useGame } from "../../state/game.ts";
import { openSheet } from "../../state/ui.ts";
import { DrawnCheckIcon, FlameIcon } from "../../components/Icons.tsx";
import { Tile } from "../../components/Tile.tsx";
import { TIER_COLOR, TIER_LABEL } from "../shell/TopBar.tsx";
import { spawnElement } from "../workbench/actions.ts";
import { Sheet } from "./Sheet.tsx";

const TIERS: Tier[] = ["easy", "hard", "expert"];

function TargetCard({ target, index }: { target: ChallengeTarget; index: number }) {
  const owned = useGame((s) => !!s.owned[target.element.id]);
  const color = TIER_COLOR[target.tier];
  return (
    <li
      data-testid="challenge-target"
      data-tier={target.tier}
      data-completed={target.completed ? "true" : "false"}
      className="flex items-center gap-3.5 rounded-[20px] border p-3"
      style={{
        borderColor: target.completed ? color : "var(--border)",
        background: target.completed ? `color-mix(in oklab, ${color} 9%, var(--surface))` : "var(--surface)",
      }}
    >
      <Tile element={target.element} size={68} />
      <div className="min-w-0 flex-1">
        <p className="text-[11.5px] font-bold uppercase tracking-[0.14em]" style={{ color }}>
          {TIER_LABEL[target.tier]}
        </p>
        <p className="font-display truncate text-[19px] font-semibold leading-tight">{target.element.name}</p>
        <p className="mt-0.5 text-[13px] text-ink-muted">
          {target.completed
            ? "Completed today"
            : target.steps
              ? `Can be made in ${target.steps} combination${target.steps === 1 ? "" : "s"}`
              : "Reachable from the starters"}
        </p>
      </div>
      {target.completed ? (
        <span
          className="check-badge grid h-9 w-9 flex-none place-items-center rounded-full"
          style={{ background: color, color: "var(--surface)", "--d": `${200 + index * 90}ms` } as CSSProperties}
        >
          <DrawnCheckIcon size={20} strokeWidth={2.6} />
        </span>
      ) : owned ? (
        <button
          type="button"
          className="btn btn-sm btn-quiet flex-none"
          onClick={() => {
            spawnElement(target.element.id);
            openSheet(null);
          }}
        >
          Add
        </button>
      ) : null}
    </li>
  );
}

export default function ChallengesSheet({ open }: { open: boolean }) {
  const challenge = useGame((s) => s.challenge);
  const history = useGame((s) => s.history);
  const streak = useGame((s) => s.stats.streak);
  const now = useNow(30_000);
  const done = challenge?.targets.filter((t) => t.completed).length ?? 0;

  return (
    <Sheet
      open={open}
      onOpenChange={(o) => !o && openSheet(null)}
      title="Daily challenges"
      description="Today's three target elements, your streak and past results."
      testId="challenges-sheet"
    >
      <div className="mb-4 flex items-center gap-3 rounded-[20px] bg-surface-2 px-4 py-3">
        <span className="grid h-11 w-11 place-items-center rounded-full bg-accent-soft text-accent">
          <FlameIcon size={24} />
        </span>
        <div className="flex-1">
          <p className="font-semibold">
            {streak.current > 0 ? `${streak.current}-day streak` : "Start a streak today"}
          </p>
          <p className="text-[13px] text-ink-muted">Best: {streak.best} day{streak.best === 1 ? "" : "s"} · Complete any target to keep it going</p>
        </div>
      </div>

      {challenge ? (
        <>
          <div className="mb-2 flex items-baseline justify-between">
            <h3 className="section-title">Today · {formatDay(challenge.day)}</h3>
            <span className="tabular text-[13px] font-semibold text-ink-muted">{done} of 3</span>
          </div>
          {done === 3 && (
            <p className="mb-3 rounded-2xl px-4 py-3 text-center font-semibold" style={{ background: "color-mix(in oklab, var(--gold-2) 22%, var(--surface))" }}>
              Clean sweep! All three made today.
            </p>
          )}
          <ul className="flex flex-col gap-2.5">
            {TIERS.map((tier, i) => {
              const t = challenge.targets.find((x) => x.tier === tier);
              return t ? <TargetCard key={tier} target={t} index={i} /> : null;
            })}
          </ul>
          <p className="mt-3 text-center text-[13px] text-ink-muted">
            New targets in <span className="tabular font-semibold text-ink">{formatCountdown(msUntilLocalMidnight(new Date(now)))}</span>
            {" · "}every target can be made from the five starters.
          </p>
        </>
      ) : (
        <p className="py-6 text-center text-ink-muted">No challenge today. Check back tomorrow!</p>
      )}

      <h3 className="section-title mb-2 mt-6">History</h3>
      {history.length === 0 ? (
        <p className="text-[14px] text-ink-muted">Days you complete a target will show up here.</p>
      ) : (
        <ul className="divide-y divide-border rounded-[18px] border border-border" data-testid="challenge-history">
          {history.map((h) => (
            <li
              key={h.day}
              className="flex items-center gap-3 px-4 py-2.5"
              data-testid="challenge-history-day"
              data-day={h.day}
              data-completed={h.completed.join(",")}
            >
              <span className="w-[92px] flex-none text-[13px] font-semibold text-ink-muted">{formatDay(h.day)}</span>
              <span className="flex flex-none gap-1" aria-hidden="true">
                {TIERS.map((t) => (
                  <span key={t} className="pip" style={{ color: TIER_COLOR[t] }} data-done={h.completed.includes(t) ? "" : undefined} />
                ))}
              </span>
              <span className="min-w-0 flex-1 truncate text-[14px]">
                {TIERS.map((t, i) => (
                  <span key={t} className={h.completed.includes(t) ? "font-semibold text-ink" : "text-ink-muted"}>
                    {i > 0 ? " · " : ""}
                    {h.names[t]}
                  </span>
                ))}
              </span>
              <span className="sr-only">
                Completed {h.completed.length} of 3: {h.completed.map((t) => TIER_LABEL[t]).join(", ")}
              </span>
            </li>
          ))}
        </ul>
      )}
    </Sheet>
  );
}
