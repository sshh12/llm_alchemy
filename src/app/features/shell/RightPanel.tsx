// Wide screens (≥1280 px): today's challenge, stats, and "fresh from the lab": elements
// other alchemists discovered recently.
import type { Tier } from "../../../shared/api.ts";
import { formatCount, formatCountdown, formatPercent, msUntilLocalMidnight } from "../../lib/format.ts";
import { useNow } from "../../lib/hooks.ts";
import { useGame } from "../../state/game.ts";
import { openDetails, openSheet } from "../../state/ui.ts";
import { DrawnCheckIcon, FlameIcon } from "../../components/Icons.tsx";
import { ElementArt } from "../../components/ElementArt.tsx";
import { clearSelection, spawnElement } from "../workbench/actions.ts";
import { TIER_COLOR, TIER_LABEL } from "./TopBar.tsx";

const TIERS: Tier[] = ["easy", "hard", "expert"];

function Card({ title, action, children }: { title: string; action?: { label: string; run: () => void }; children: React.ReactNode }) {
  return (
    <section className="rounded-[22px] border border-border bg-surface p-4 shadow-[0_2px_0_var(--border)]">
      <div className="mb-2.5 flex items-baseline justify-between">
        <h2 className="section-title">{title}</h2>
        {action && (
          <button type="button" className="text-[13px] font-semibold text-accent hover:underline" onClick={action.run}>
            {action.label}
          </button>
        )}
      </div>
      {children}
    </section>
  );
}

function TodayCard() {
  const challenge = useGame((s) => s.challenge);
  const streak = useGame((s) => s.stats.streak.current);
  const now = useNow(30_000);
  return (
    <Card title="Today's challenge" action={{ label: "Details", run: () => openSheet("challenges") }}>
      {challenge ? (
        <ul className="flex flex-col gap-1.5">
          {TIERS.map((tier) => {
            const t = challenge.targets.find((x) => x.tier === tier);
            if (!t) return null;
            return (
              <li key={tier} className="flex items-center gap-2.5">
                <ElementArt element={t.element} box={34} />
                <span className="min-w-0 flex-1">
                  <span className="block text-[10.5px] font-bold uppercase tracking-[0.14em]" style={{ color: TIER_COLOR[tier] }}>
                    {TIER_LABEL[tier]}
                  </span>
                  <span className={`block truncate text-[14px] font-semibold ${t.completed ? "text-ink-muted line-through decoration-2" : ""}`}>{t.element.name}</span>
                </span>
                {t.completed && (
                  <span className="check-badge grid h-6 w-6 place-items-center rounded-full" style={{ background: TIER_COLOR[tier], color: "var(--surface)" }}>
                    <DrawnCheckIcon size={14} strokeWidth={3} />
                  </span>
                )}
              </li>
            );
          })}
        </ul>
      ) : (
        <p className="text-[14px] text-ink-muted">No challenge today.</p>
      )}
      <p className="mt-3 flex items-center justify-between text-[12.5px] text-ink-muted">
        <span className="inline-flex items-center gap-1 font-semibold text-accent">
          <FlameIcon size={14} /> {streak}-day streak
        </span>
        <span className="tabular">Next in {formatCountdown(msUntilLocalMidnight(new Date(now)))}</span>
      </p>
    </Card>
  );
}

function StatsCard() {
  const stats = useGame((s) => s.stats);
  return (
    <Card title="Your lab" action={{ label: "Stats", run: () => openSheet("stats") }}>
      <dl className="grid grid-cols-3 gap-2 text-center">
        {[
          [formatCount(stats.mine), "elements"],
          [formatPercent(stats.mine, stats.known), "of known"],
          [formatCount(stats.firsts), "firsts"],
        ].map(([v, l]) => (
          <div key={l} className="rounded-2xl bg-surface-2 px-1 py-2.5">
            <dt className="sr-only">{l}</dt>
            <dd className="font-display tabular text-[20px] font-semibold leading-none">{v}</dd>
            <dd className="mt-1 text-[11.5px] font-medium text-ink-muted">{l}</dd>
          </div>
        ))}
      </dl>
    </Card>
  );
}

function FreshFeed() {
  const recent = useGame((s) => s.recent);
  const elements = useGame((s) => s.elements);
  const owned = useGame((s) => s.owned);
  if (recent.length === 0) return null;
  return (
    <Card title="Fresh from the lab">
      <p className="-mt-1.5 mb-2 text-[12.5px] text-ink-muted">Just discovered by alchemists around the world.</p>
      <ul className="flex flex-col">
        {recent.map((id) => {
          const el = elements[id];
          if (!el) return null;
          const mine = !!owned[id];
          return (
            <li key={id}>
              <button
                type="button"
                className="flex w-full items-center gap-2.5 rounded-xl px-1.5 py-1.5 text-left hover:bg-surface-2"
                onClick={(e) => {
                  if (mine) {
                    clearSelection();
                    spawnElement(id);
                    return;
                  }
                  const r = e.currentTarget.getBoundingClientRect();
                  openDetails({ elementId: id, source: "feed", anchor: { x: r.left, y: r.top, w: r.width, h: r.height } });
                }}
              >
                <ElementArt element={el} box={32} />
                <span className="min-w-0 flex-1 truncate text-[14px] font-semibold">{el.name}</span>
                {mine && <span className="text-[11px] font-semibold uppercase tracking-[0.1em] text-success">yours</span>}
              </button>
            </li>
          );
        })}
      </ul>
    </Card>
  );
}

export function RightPanel() {
  const ready = useGame((s) => s.status === "ready");
  return (
    <aside className="no-scrollbar flex min-h-0 flex-col gap-3 overflow-y-auto border-l border-border bg-surface-2 p-3 pb-[max(12px,env(safe-area-inset-bottom))]" aria-label="Today">
      {ready && (
        <>
          <TodayCard />
          <StatsCard />
          <FreshFeed />
        </>
      )}
    </aside>
  );
}
