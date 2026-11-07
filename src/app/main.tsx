// Entry point: fonts + styles, service-worker cleanup, touch guard, settings → <html>,
// optional dev-only fake API, then render.
import "@fontsource-variable/instrument-sans/wdth.css";
import "@fontsource-variable/fraunces/soft.css";
import "./styles/app.css";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App.tsx";
import { installTouchGuard } from "./features/workbench/drag.ts";
import { bindSettingsToDocument } from "./state/settings.ts";

/**
 * Belt-and-braces for returning 2023 players: public/service-worker.js already replaces
 * the old Workbox worker, but unregister anything still registered on this origin.
 */
function unregisterServiceWorkers(): void {
  navigator.serviceWorker
    ?.getRegistrations()
    .then((regs) => Promise.all(regs.map((r) => r.unregister())))
    .catch(() => {});
}

async function start(): Promise<void> {
  unregisterServiceWorkers();
  installTouchGuard();
  bindSettingsToDocument();
  // Dev-only stand-in backend (`npx vite`, then open /?fake). Stripped from production builds.
  if (import.meta.env.DEV && location.search.includes("fake")) {
    const { installFakeApi } = await import("./dev/fakeApi.ts");
    installFakeApi();
  }
  createRoot(document.getElementById("root")!).render(
    <StrictMode>
      <App />
    </StrictMode>,
  );
}

void start();
