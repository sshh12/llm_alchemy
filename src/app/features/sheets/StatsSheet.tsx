// Stats: your elements, share of everything known, world firsts (+ list), challenges.
import { useMemo } from "react";
import { formatCount, formatPercent } from "../../lib/format.ts";
import { useGame } from "../../state/game.ts";
import { openDetails, openSheet } from "../../state/ui.ts";
import { Tile } from "../../components/Tile.tsx";
import { Sheet } from "./Sheet.tsx";

function Stat({ value, label, accent }: { value: string; label: string; accent?: string }) {
  return (
    <div className="rounded-[18px] bg-surface-2 px-4 py-3">
      <p className="font-display tabular text-[28px] font-semibold leading-none tracking-[-0.02em]" style={{ color: accent }}>
        {value}
      </p>
      <p className="mt-1.5 text-[13px] font-medium text-ink-muted">{label}</p>
    </div>
  );
}

const FIRSTS_SHOWN = 60;

export default function StatsSheet({ open }: { open: boolean }) {
  const stats = useGame((s) => s.stats);
  const owned = useGame((s) => s.owned);
  const firsts = useMemo(() => {
    const els = useGame.getState().elements;
    return Object.entries(owned)
      .filter(([id, o]) => o.first && els[id])
      .sort((a, b) => Date.parse(b[1].discoveredAt) - Date.parse(a[1].discoveredAt))
      .map(([id]) => els[id]!);
  }, [owned]);

  return (
    <Sheet open={open} onOpenChange={(o) => !o && openSheet(null)} title="Your stats" description="Your elements, world firsts and challenge record." testId="stats-sheet">
      <div className="grid grid-cols-2 gap-2.5">
        <Stat value={formatCount(stats.mine)} label="Your elements" />
        <Stat value={formatPercent(stats.mine, stats.known)} label={`of ${formatCount(stats.known)} known`} />
        <Stat value={formatCount(stats.firsts)} label="World firsts" accent="var(--gold)" />
        <Stat value={formatCount(stats.challengesCompleted)} label="Challenges completed" />
      </div>
      <p className="mt-3 text-[13px] text-ink-muted">
        Best streak: <span className="font-semibold text-ink">{stats.streak.best} day{stats.streak.best === 1 ? "" : "s"}</span>
      </p>

      <h3 className="section-title mb-1 mt-6">World firsts</h3>
      <p className="mb-3 text-[13px] text-ink-muted">Elements nobody had ever made before you.</p>
      {firsts.length === 0 ? (
        <p className="rounded-[18px] border border-dashed border-[var(--border-strong)] px-4 py-5 text-center text-[14px] text-ink-muted">
          None yet. Mix something unusual: the first person to create an element gets the gold seal.
        </p>
      ) : (
        <>
          <ul className="flex flex-wrap gap-2">
            {firsts.slice(0, FIRSTS_SHOWN).map((el) => (
              <li key={el.id}>
                <button
                  type="button"
                  className="rounded-[22px]"
                  aria-label={el.name}
                  onClick={(e) => {
                    const r = e.currentTarget.getBoundingClientRect();
                    openSheet(null);
                    openDetails({ elementId: el.id, source: "library", anchor: { x: r.left, y: r.top, w: r.width, h: r.height } });
                  }}
                >
                  <Tile element={el} size={72} first />
                </button>
              </li>
            ))}
          </ul>
          {firsts.length > FIRSTS_SHOWN && (
            <p className="mt-2 text-[13px] text-ink-muted">and {formatCount(firsts.length - FIRSTS_SHOWN)} more (filter the library by Firsts)</p>
          )}
        </>
      )}
    </Sheet>
  );
}
