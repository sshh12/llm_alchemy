// Non-blocking feedback: a top stack (discoveries, errors, info) and the bottom undo
// snackbar (rendered inside the workbench so it never covers the library).
import { AnimatePresence, m } from "motion/react";
import { useShallow } from "zustand/react/shallow";
import { useGame } from "../../state/game.ts";
import { dismissToast, openDetails, useUi, type Toast } from "../../state/ui.ts";
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
