// The one modal-ish reward moment: "First discovery" (gold foil, wax seal, falling gold
// leaf, share) and challenge completion (tier colors, streak). Cards queue; any tap
// outside the buttons dismisses.
import { Dialog } from "radix-ui";
import { useMemo, useState, type CSSProperties } from "react";
import { RARITY_LABEL } from "../../../shared/rarity.ts";
import { formatDay } from "../../lib/format.ts";
import { shareElement } from "../../lib/share.ts";
import { useGame } from "../../state/game.ts";
import { nextCelebration, showToast, useUi, type Celebration } from "../../state/ui.ts";
import { ElementArt } from "../../components/ElementArt.tsx";
import { FlameIcon, ShareIcon, SparkleIcon } from "../../components/Icons.tsx";
import { Tile } from "../../components/Tile.tsx";
import { TIER_COLOR, TIER_LABEL } from "../shell/TopBar.tsx";
import { recipeLabel } from "../workbench/actions.ts";

function Flakes() {
  const flakes = useMemo(
    () =>
      Array.from({ length: 24 }, () => ({
        "--x": `${Math.random() * 100}%`,
        "--w": `${6 + Math.random() * 7}px`,
        "--d": `${(Math.random() * 0.9).toFixed(2)}s`,
        "--dur": `${(2 + Math.random() * 1.6).toFixed(2)}s`,
        "--dx": `${Math.round((Math.random() - 0.5) * 80)}px`,
        "--rot": `${Math.round(360 + Math.random() * 540)}deg`,
      })) as CSSProperties[],
    [],
  );
  return (
    <div className="flakes" aria-hidden="true">
      {flakes.map((s, i) => (
        <i key={i} style={s} />
      ))}
    </div>
  );
}

/** Staggered entrance for card content (.reveal) at `ms` after the card opens. */
const beat = (ms: number) => ({ "--d": `${ms}ms` }) as CSSProperties;

function FirstCard({ c }: { c: Extract<Celebration, { kind: "first" }> }) {
  const el = useGame((s) => s.elements[c.elementId]);
  const [sharing, setSharing] = useState(false);
  if (!el) return null;
  const recipe = recipeLabel(c.ingredients);
  const share = async () => {
    setSharing(true);
    const outcome = await shareElement({ element: el, recipe, first: true, at: c.at });
    setSharing(false);
    if (outcome === "downloaded") showToast({ kind: "info", text: "Card saved, and the link is copied to your clipboard.", duration: 4_000 });
    if (outcome === "failed") showToast({ kind: "error", text: "Couldn't create the share card.", duration: 4_000 });
  };
  return (
    <div className="relative overflow-hidden rounded-[28px] px-6 pb-6 pt-7">
      <div
        className="pointer-events-none absolute inset-x-0 top-0 h-56"
        style={{ background: "radial-gradient(ellipse at 50% 0%, color-mix(in oklab, var(--gold-1) 45%, transparent), transparent 70%)" }}
        aria-hidden="true"
      />
      <Flakes />
      <p className="reveal relative text-[12px] font-bold uppercase tracking-[0.2em] text-gold" style={beat(60)}>
        First discovery in the world
      </p>
      <div className="relative mx-auto mt-4 grid w-fit place-items-center">
        <Tile element={el} size={148} first bare />
        <span className="wax -bottom-4 -right-7" aria-hidden="true">
          <span className="font-display text-[12px] font-bold uppercase tracking-[0.08em]">Origin</span>
        </span>
      </div>
      <Dialog.Title
        className="font-display reveal relative mt-6 text-[34px] font-semibold leading-[1.05] tracking-[-0.02em] min-[640px]:text-[44px]"
        style={beat(180)}
      >
        {el.name}
      </Dialog.Title>
      <Dialog.Description className="reveal relative mt-1.5 text-[15px] font-semibold text-ink-muted" style={beat(240)}>
        {recipe}
      </Dialog.Description>
      <div className="reveal relative mt-3 flex flex-wrap items-center justify-center gap-2" style={beat(300)}>
        <span className="foil-badge">
          <span className="grid h-5 w-5 place-items-center rounded-full bg-[rgb(255_255_255/0.45)]">
            <SparkleIcon size={12} />
          </span>
          First discovered by you · {formatDay(c.at)}
        </span>
        {el.notable && <span className="chip h-7 text-[12px]">✦ Notable</span>}
        {el.rarity !== "common" && <span className="chip h-7 text-[12px]">{RARITY_LABEL[el.rarity]}</span>}
      </div>
      {el.description && (
        <p className="reveal relative mt-3 text-[14px] text-ink-muted" style={beat(340)}>
          {el.description}
        </p>
      )}
      <div className="reveal relative mt-6 flex gap-2.5" style={beat(380)}>
        <button type="button" className="btn btn-quiet flex-1" disabled={sharing} onClick={() => void share()}>
          <ShareIcon size={18} /> {sharing ? "Preparing…" : "Share"}
        </button>
        <Dialog.Close asChild>
          <button type="button" className="btn btn-primary flex-1">
            Keep playing
          </button>
        </Dialog.Close>
      </div>
    </div>
  );
}

function ChallengeCard({ c }: { c: Extract<Celebration, { kind: "challenge" }> }) {
  const challenge = useGame((s) => s.challenge);
  const streak = useGame((s) => s.stats.streak.current);
  const done = challenge?.targets.filter((t) => t.completed).length ?? 0;
  const targets = challenge?.targets.filter((t) => c.tiers.includes(t.tier)) ?? [];
  const tier = c.tiers[c.tiers.length - 1] ?? "easy";
  const color = TIER_COLOR[tier];
  const sweep = done === 3;
  return (
    <div className="relative overflow-hidden rounded-[28px] px-6 pb-6 pt-7">
      <div
        className="pointer-events-none absolute inset-x-0 top-0 h-48"
        style={{ background: `radial-gradient(ellipse at 50% 0%, color-mix(in oklab, ${color} 30%, transparent), transparent 70%)` }}
        aria-hidden="true"
      />
      {sweep && <Flakes />}
      <p className="reveal relative text-[12px] font-bold uppercase tracking-[0.2em]" style={{ color, ...beat(60) }}>
        {sweep ? "Clean sweep" : `${c.tiers.map((t) => TIER_LABEL[t]).join(" + ")} challenge`}
      </p>
      <div className="relative mt-4 flex justify-center gap-3">
        {targets.map((t) => (
          <div key={t.tier} className="flex flex-col items-center gap-1.5">
            <ElementArt element={t.element} box={96} />
          </div>
        ))}
      </div>
      <Dialog.Title className="font-display reveal relative mt-4 text-[30px] font-semibold leading-tight tracking-[-0.02em]" style={beat(180)}>
        {sweep ? "All three done!" : targets.map((t) => t.element.name).join(" & ")}
      </Dialog.Title>
      <Dialog.Description className="reveal relative mt-1 text-[15px] text-ink-muted" style={beat(240)}>
        {sweep ? "You made every target today. See you tomorrow." : `Challenge complete · ${done} of 3 today`}
      </Dialog.Description>
      {streak > 0 && (
        <p
          className="reveal relative mt-3 inline-flex items-center gap-1.5 rounded-full bg-accent-soft px-3 py-1 text-[14px] font-semibold text-accent"
          style={beat(300)}
        >
          <FlameIcon size={16} className="flame" data-pulse="" style={{ animationDelay: "520ms" }} /> {streak}-day streak
        </p>
      )}
      <Dialog.Close asChild>
        <button type="button" className="btn btn-primary reveal relative mt-6 w-full" style={beat(360)}>
          Keep playing
        </button>
      </Dialog.Close>
    </div>
  );
}

export default function CelebrationHost() {
  const current = useUi((s) => s.celebrations[0]);
  const [open, setOpen] = useState(true);
  if (!current) return null;
  // Close with the exit animation, then show the next queued card (never stacked).
  const dismiss = () => {
    setOpen(false);
    setTimeout(() => {
      nextCelebration();
      setOpen(true);
    }, 200);
  };
  return (
    <Dialog.Root
      key={current.kind === "first" ? `f${current.elementId}` : `c${current.tiers.join()}`}
      open={open}
      onOpenChange={(o) => !o && dismiss()}
    >
      <Dialog.Portal>
        <Dialog.Overlay className="overlay card-overlay" />
        <Dialog.Content
          className="card-dialog"
          data-testid={current.kind === "first" ? "discovery-card" : "challenge-complete"}
          data-tier={current.kind === "challenge" ? current.tiers[0] : undefined}
          onClick={(e) => {
            // Dismiss on any tap that isn't on a control.
            if (!(e.target as HTMLElement).closest("button, a")) dismiss();
          }}
        >
          {current.kind === "first" ? <FirstCard c={current} /> : <ChallengeCard c={current} />}
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
