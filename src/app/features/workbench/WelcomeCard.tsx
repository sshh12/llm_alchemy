// First-run welcome card (experiment firstRun, treatment; firstRun.ts): the modal welcome
// sheet's content in a collapsed card at the top of the workbench. It never blocks the board:
// the seeded pair and the coach are playable at once, and the card expands on demand.
import { lazy, Suspense, useEffect, useId } from "react";
import { ChevronDownIcon, ChevronUpIcon, CloseIcon, LogoMark } from "../../components/Icons.tsx";
import { useUi } from "../../state/ui.ts";
import { closeWelcome, toggleWelcome, welcomeLink, welcomeShown } from "./firstRun.ts";

// The About sheet's body (prefetched on idle with the other sheets, so it is usually instant).
const AboutBody = lazy(() => import("../sheets/AboutSheet.tsx").then((m) => ({ default: m.AboutBody })));

const onLink = (target: string) => () => welcomeLink(target);

export function WelcomeCard() {
  const state = useUi((s) => s.welcome);
  const id = useId();
  useEffect(() => {
    if (state) welcomeShown();
  }, [state]);
  if (!state) return null;
  const expanded = state === "expanded";
  return (
    <section
      className="welcome-card"
      data-state={state}
      data-testid="welcome-card"
      aria-labelledby={`${id}-title`}
      onKeyDown={(e) => {
        if (e.key !== "Escape" || !expanded) return;
        e.stopPropagation(); // not also "clear selection"
        toggleWelcome();
      }}
    >
      <div className="welcome-head">
        <button
          type="button"
          className="welcome-toggle"
          aria-expanded={expanded}
          aria-controls={`${id}-body`}
          data-testid="welcome-expand"
          onClick={toggleWelcome}
        >
          <LogoMark size={24} />
          <span className="min-w-0 flex-1 text-left">
            <span id={`${id}-title`} className="font-display block truncate text-[16px] font-semibold leading-tight">
              Welcome, alchemist
            </span>
            <span className="block truncate text-[12.5px] text-ink-muted">{expanded ? "Hide how to play" : "How to play"}</span>
          </span>
          {expanded ? <ChevronUpIcon size={18} /> : <ChevronDownIcon size={18} />}
        </button>
        <button type="button" className="icon-btn" aria-label="Dismiss welcome" data-testid="welcome-dismiss" onClick={() => closeWelcome("dismiss")}>
          <CloseIcon size={18} />
        </button>
      </div>
      <div id={`${id}-body`} className="welcome-body" data-testid="welcome-body" hidden={!expanded}>
        {expanded && (
          <>
            <Suspense fallback={<p className="py-6 text-center text-[14px] text-ink-muted">Loading…</p>}>
              <AboutBody onLink={onLink} />
            </Suspense>
            <button type="button" className="btn btn-primary mt-5 w-full" data-testid="welcome-start" onClick={() => closeWelcome("start")}>
              Start mixing
            </button>
          </>
        )}
      </div>
    </section>
  );
}
