// Non-blocking feedback: a top stack (discoveries, inline world-firsts, goals, errors, info)
// and the bottom undo snackbar (rendered inside the workbench so it never covers the library).
import { AnimatePresence, m } from "motion/react";
import { useShallow } from "zustand/react/shallow";
import { useGame } from "../../state/game.ts";
import { dismissToast, openDetails, useUi, type Toast } from "../../state/ui.ts";
import { formatCount } from "../../lib/format.ts";
import { useNow } from "../../lib/hooks.ts";
import { ElementArt } from "../../components/ElementArt.tsx";
import { SparkleIcon } from "../../components/Icons.tsx";

function Countdown({ until }: { until: number }) {
  const now = useNow(500);
  return <span className="tabular font-semibold">{Math.max(0, Math.ceil((until - now) / 1000))}s</span>;
}

function NewChip({ toast }: { toast: Toast }) {
  const el = useGame((s) => (toast.elementId ? s.elements[toast.elementId] : undefined));
  if (!el) return null;
  return (
    <button
      type="button"
      className="flex min-w-0 items-center gap-2.5 text-left"
      onClick={() => {
        dismissToast(toast.id);
        openDetails({ elementId: el.id, source: "library", anchor: null });
      }}
    >
      <ElementArt element={el} box={30} />
      <span className="flex min-w-0 flex-col leading-tight">
        <span className="text-[11px] font-bold uppercase tracking-[0.12em] text-success">New discovery</span>
        <span className="flex items-center gap-1 truncate font-semibold">
          {el.name}
          {toast.notable && <SparkleIcon size={13} className="flex-none text-gold" aria-label="notable" />}
        </span>
      </span>
    </button>
  );
}

/**
 * A world-first shown inline instead of the full card (celebration throttle, actions.ts). Tap
 * opens the element's menu, where Share lives.
 */
function FirstChip({ toast }: { toast: Toast }) {
  const el = useGame((s) => (toast.elementId ? s.elements[toast.elementId] : undefined));
  if (!el) return null;
  return (
    <button
      type="button"
      className="flex min-w-0 items-center gap-2.5 text-left"
      data-testid="first-toast"
      onClick={() => {
        dismissToast(toast.id);
        openDetails({ elementId: el.id, source: "library", anchor: null });
      }}
    >
      <span className="first-chip-art">
        <ElementArt element={el} box={30} />
      </span>
      <span className="flex min-w-0 flex-col leading-tight">
        <span className="flex items-center gap-1 text-[11px] font-bold uppercase tracking-[0.12em] text-gold">
          <SparkleIcon size={11} /> First discovery!
        </span>
        <span className="truncate font-semibold">You're the first to make {el.name}</span>
      </span>
    </button>
  );
}

/** A library goal reached (experiment goals). */
function MilestoneView({ goal }: { goal: NonNullable<Toast["milestone"]> }) {
  return (
    <span className="flex min-w-0 items-center gap-2.5 py-0.5" data-testid="milestone-toast" data-rung={goal.rung}>
      <span className="goal-badge tabular" aria-hidden="true">
        {formatCount(goal.rung)}
      </span>
      <span className="flex min-w-0 flex-col leading-tight">
        <span className="text-[11px] font-bold uppercase tracking-[0.12em] text-accent">Goal reached</span>
        <span className="truncate font-semibold">
          {formatCount(goal.rung)} elements! Next goal: {formatCount(goal.next)}
        </span>
      </span>
    </span>
  );
}

function ToastView({ toast }: { toast: Toast }) {
  return (
    <m.div
      layout
      className="toast"
      data-testid={toast.testId ?? "toast"}
      data-kind={toast.kind}
      role={toast.kind === "error" ? "alert" : "status"}
      initial={{ opacity: 0, y: -14, scale: 0.96 }}
      animate={{ opacity: 1, y: 0, scale: 1 }}
      exit={{ opacity: 0, y: -10, scale: 0.96, transition: { duration: 0.15 } }}
      transition={{ type: "spring", visualDuration: 0.3, bounce: 0.25 }}
    >
      {toast.kind === "new" ? (
        <NewChip toast={toast} />
      ) : toast.kind === "first" ? (
        <FirstChip toast={toast} />
      ) : toast.kind === "milestone" && toast.milestone ? (
        <MilestoneView goal={toast.milestone} />
      ) : (
        <span className="min-w-0 py-1.5">
          {toast.text}
          {toast.until && (
            <>
              {" "}
              <Countdown until={toast.until} />
            </>
          )}
        </span>
      )}
      {toast.action && (
        <button
          type="button"
          className="toast-action"
          onClick={() => {
            dismissToast(toast.id);
            toast.action!.run();
          }}
        >
          {toast.action.label}
        </button>
      )}
    </m.div>
  );
}

export function TopToasts() {
  const toasts = useUi(useShallow((s) => s.toasts.filter((t) => t.kind !== "undo")));
  return (
    <div className="toasts">
      <AnimatePresence initial={false}>
        {toasts.map((t) => (
          <ToastView key={t.id} toast={t} />
        ))}
      </AnimatePresence>
    </div>
  );
}

export function Snackbar() {
  const toast = useUi((s) => s.toasts.findLast((t) => t.kind === "undo"));
  return (
    <AnimatePresence initial={false}>
      {toast && (
        <m.div
          key={toast.id}
          className="toast"
          data-testid="toast"
          data-kind="undo"
          role="status"
          initial={{ opacity: 0, y: 14 }}
          animate={{ opacity: 1, y: 0 }}
          exit={{ opacity: 0, y: 10, transition: { duration: 0.15 } }}
          transition={{ type: "spring", visualDuration: 0.28, bounce: 0.2 }}
        >
          <span className="min-w-0 truncate py-1.5">{toast.text}</span>
          {toast.action && (
            <button
              type="button"
              className="toast-action"
              onClick={() => {
                dismissToast(toast.id);
                toast.action!.run();
              }}
            >
              {toast.action.label}
            </button>
          )}
        </m.div>
      )}
    </AnimatePresence>
  );
}

export function LiveRegion() {
  const live = useUi((s) => s.live);
  return (
    <>
      <div className="sr-only-live" aria-live="polite" aria-atomic="true">
        {live.polite}
      </div>
      <div className="sr-only-live" aria-live="assertive" aria-atomic="true">
        {live.assertive}
      </div>
    </>
  );
}
