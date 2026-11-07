// Player preferences, persisted per browser. Theme and motion overrides are mirrored to
// <html data-theme / data-motion> so CSS tokens switch without React re-rendering.
import { create } from "zustand";
import { springConfig } from "../lib/spring.ts";
import { KEYS, readJSON, writeJSON } from "../lib/storage.ts";

export type ThemePref = "system" | "light" | "dark";
export type MotionPref = "system" | "reduce";

export interface Settings {
  theme: ThemePref;
  sound: boolean;
  haptics: boolean;
  motion: MotionPref;
}

const DEFAULTS: Settings = { theme: "system", sound: false, haptics: true, motion: "system" };

function load(): Settings {
  const raw = readJSON<Partial<Settings>>(KEYS.settings, {});
  return {
    theme: raw.theme === "light" || raw.theme === "dark" ? raw.theme : "system",
    sound: raw.sound === true,
    haptics: raw.haptics !== false,
    motion: raw.motion === "reduce" ? "reduce" : "system",
  };
}

interface SettingsStore extends Settings {
  set(patch: Partial<Settings>): void;
}

export const useSettings = create<SettingsStore>((set, get) => ({
  ...DEFAULTS,
  ...load(),
  set(patch) {
    set(patch);
    const { theme, sound, haptics, motion } = get();
    writeJSON(KEYS.settings, { theme, sound, haptics, motion });
  },
}));

const reducedQuery = typeof matchMedia === "function" ? matchMedia("(prefers-reduced-motion: reduce)") : null;

export function prefersReducedMotion(): boolean {
  return useSettings.getState().motion === "reduce" || !!reducedQuery?.matches;
}

const THEME_COLOR = { light: "#EFE7D9", dark: "#2A231C" } as const;

function applyToDocument(): void {
  const s = useSettings.getState();
  const root = document.documentElement;
  if (s.theme === "system") delete root.dataset.theme;
  else root.dataset.theme = s.theme;
  if (s.motion === "reduce") root.dataset.motion = "reduce";
  else delete root.dataset.motion;
  // Browser chrome color: with an override both media-scoped metas get the chosen color.
  const metas = document.querySelectorAll<HTMLMetaElement>('meta[name="theme-color"]');
  metas.forEach((m) => {
    const media = m.getAttribute("media") ?? "";
    const natural = media.includes("dark") ? THEME_COLOR.dark : THEME_COLOR.light;
    m.content = s.theme === "system" ? natural : THEME_COLOR[s.theme];
  });
  springConfig.reduced = prefersReducedMotion();
}

/** Keep <html> attributes and the spring engine in sync with settings + OS preferences. */
export function bindSettingsToDocument(): void {
  applyToDocument();
  useSettings.subscribe(applyToDocument);
  reducedQuery?.addEventListener("change", applyToDocument);
}
