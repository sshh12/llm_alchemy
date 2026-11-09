// Small React hooks shared across features.
import { useEffect, useState, useSyncExternalStore } from "react";
import { prefersReducedMotion, useSettings } from "../state/settings.ts";

export function useMediaQuery(query: string): boolean {
  return useSyncExternalStore(
    (cb) => {
      const m = matchMedia(query);
      m.addEventListener("change", cb);
      return () => m.removeEventListener("change", cb);
    },
    () => matchMedia(query).matches,
  );
}

/** The right panel (today's challenge, stats) shows at this width and up. */
export const WIDE_QUERY = "(min-width: 1280px)";

/** Layout tier: phone shelf (<640), rail (≥640), large tiles (≥1024), right panel (≥1280). */
export function useLayoutTier() {
  const rail = useMediaQuery("(min-width: 640px)");
  const desktop = useMediaQuery("(min-width: 1024px)");
  const wide = useMediaQuery(WIDE_QUERY);
  return { rail, desktop, wide };
}

export function useReducedMotion(): boolean {
  const os = useMediaQuery("(prefers-reduced-motion: reduce)");
  const pref = useSettings((s) => s.motion);
  return pref === "reduce" || os || prefersReducedMotion();
}

/** Re-render every `ms` (for countdowns). */
export function useNow(ms: number): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), ms);
    return () => clearInterval(t);
  }, [ms]);
  return now;
}

export function useOnline(): boolean {
  return useSyncExternalStore(
    (cb) => {
      window.addEventListener("online", cb);
      window.addEventListener("offline", cb);
      return () => {
        window.removeEventListener("online", cb);
        window.removeEventListener("offline", cb);
      };
    },
    () => navigator.onLine,
  );
}
