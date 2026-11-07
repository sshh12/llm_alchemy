import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

export default defineConfig({
  plugins: [react(), tailwindcss()],
  // No SPA history fallback: the game lives only at "/". Unknown paths must 404 so netlify dev
  // falls back to public/<path>.html (the content pages) and anything else is a real 404, as on the CDN.
  appType: "mpa",
  build: {
    outDir: "dist",
    sourcemap: true,
    target: "es2022",
  },
  server: {
    port: 5173,
    strictPort: true,
  },
});
