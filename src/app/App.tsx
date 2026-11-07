// App shell: top bar, library (phone shelf or rail), workbench, wide-screen panel, and
// the floating layers (toasts, drag ghost, overlays, screen-reader live region).
import { LazyMotion, MotionConfig } from "motion/react";
import { useEffect } from "react";
import { useLayoutTier } from "./lib/hooks.ts";
import { bootGame, useGame } from "./state/game.ts";
import { useSettings } from "./state/settings.ts";
import { useUi } from "./state/ui.ts";
import { Rail } from "./features/library/Rail.tsx";
import { Shelf } from "./features/library/Shelf.tsx";
import { Overlays } from "./features/shell/Overlays.tsx";
import { RightPanel } from "./features/shell/RightPanel.tsx";
import { LiveRegion, TopToasts } from "./features/shell/Toasts.tsx";
import { TopBar } from "./features/shell/TopBar.tsx";
import { useHotkeys } from "./features/shell/useHotkeys.ts";
import { DragLayer } from "./features/workbench/DragLayer.tsx";
import { useDrag } from "./features/workbench/drag.ts";
import { Workbench } from "./features/workbench/Workbench.tsx";

const loadFeatures = () => import("./lib/motionFeatures.ts").then((m) => m.default);

export function App() {
  const { rail, wide } = useLayoutTier();
  const dragSource = useDrag((s) => s.source);
  const motion = useSettings((s) => s.motion);
  const ready = useGame((s) => s.status === "ready");
  const shelf = useUi((s) => s.shelf);
  useHotkeys();
  useEffect(() => {
    void bootGame();
  }, []);

  return (
    <MotionConfig reducedMotion={motion === "reduce" ? "always" : "user"}>
      <LazyMotion features={loadFeatures} strict>
        <div className="app" data-testid="app" data-ready={ready ? "true" : "false"}>
          <TopBar />
          <main className="main" data-drag={dragSource ?? undefined} data-shelf={rail ? undefined : shelf}>
            {rail && <Rail />}
            <Workbench />
            {!rail && <Shelf />}
            {wide && <RightPanel />}
          </main>
        </div>
        <TopToasts />
        <DragLayer />
        <Overlays />
        <LiveRegion />
      </LazyMotion>
    </MotionConfig>
  );
}
