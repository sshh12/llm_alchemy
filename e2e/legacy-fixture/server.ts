// Two tiny servers that let a test play out "the same origin switches from the 2023 app to v2":
//
//   startLegacyServer  serves the fake 2023 app (precached shell, Workbox-like SW, legacy
//                      localStorage) on a port.
//   startOriginProxy   later binds the SAME port and forwards everything (HTTP + WebSocket
//                      upgrades for Vite HMR) to the real v2 stack (netlify dev), preserving
//                      the Host header so same-origin checks and cookies behave as on one origin.
//
// Standalone: `npx tsx e2e/legacy-fixture/server.ts legacy 8890 <userId>` or
//             `npx tsx e2e/legacy-fixture/server.ts proxy 8890 8888`.
import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";

const DIR = path.dirname(fileURLToPath(import.meta.url));

export interface LegacyState {
  /** 'alchemy:<uuid>' as the 2023 app generated it. */
  userId: string;
  /** Legacy element objects exactly as stored in localStorage['elements']. */
  elements: unknown[];
}

export interface RunningServer {
  port: number;
  close(): Promise<void>;
}

function listen(server: http.Server, port: number): Promise<RunningServer> {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, () => {
      server.off("error", reject);
      resolve({
        port,
        close: () =>
          new Promise<void>((done) => {
            server.closeAllConnections();
            server.close(() => done());
          }),
      });
    });
  });
}

/** JSON safe to inline in a <script> element. */
function inlineJson(value: unknown): string {
  return JSON.stringify(value).replace(/</g, "\\u003c");
}

export function startLegacyServer(port: number, state: LegacyState): Promise<RunningServer> {
  const html = fs.readFileSync(path.join(DIR, "index.html"), "utf8").replace("__LEGACY_STATE__", inlineJson(state));
  const files: Record<string, { type: string; body: string; cache: string }> = {
    "/service-worker.js": {
      type: "text/javascript",
      body: fs.readFileSync(path.join(DIR, "service-worker.js"), "utf8"),
      cache: "no-cache",
    },
    "/static/js/main.legacy.js": {
      type: "text/javascript",
      body: fs.readFileSync(path.join(DIR, "main.legacy.js"), "utf8"),
      cache: "public, max-age=31536000, immutable",
    },
    "/manifest.json": {
      type: "application/manifest+json",
      body: JSON.stringify({ short_name: "Alchemy", name: "Infinite Alchemy", start_url: ".", display: "standalone" }),
      cache: "public, max-age=0, must-revalidate",
    },
  };
  const server = http.createServer((req, res) => {
    const pathname = new URL(req.url ?? "/", "http://x").pathname;
    const file = files[pathname];
    if (file) {
      res.writeHead(200, { "content-type": file.type, "cache-control": file.cache });
      res.end(file.body);
      return;
    }
    // Netlify-style SPA fallback, like the old deploy's _redirects.
    res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "public, max-age=0, must-revalidate" });
    res.end(html);
  });
  return listen(server, port);
}

export function startOriginProxy(port: number, targetPort: number): Promise<RunningServer> {
  const rewriteLocation = (v: string) => v.replace(`//localhost:${targetPort}`, `//localhost:${port}`);
  const server = http.createServer((req, res) => {
    const upstream = http.request(
      { host: "localhost", port: targetPort, method: req.method, path: req.url, headers: req.headers },
      (up) => {
        const headers = { ...up.headers };
        if (typeof headers.location === "string") headers.location = rewriteLocation(headers.location);
        res.writeHead(up.statusCode ?? 502, up.statusMessage, headers);
        up.pipe(res);
      },
    );
    upstream.on("error", (e) => {
      if (!res.headersSent) res.writeHead(502, { "content-type": "text/plain" });
      res.end(`origin proxy: ${e.message}`);
    });
    req.pipe(upstream);
  });
  // Raw TCP tunnel for WebSocket upgrades (Vite's HMR client connects to the page origin).
  server.on("upgrade", (req, socket, head) => {
    const upstream = net.connect(targetPort, "localhost", () => {
      const lines = [`${req.method} ${req.url} HTTP/${req.httpVersion}`];
      for (let i = 0; i < req.rawHeaders.length; i += 2) lines.push(`${req.rawHeaders[i]}: ${req.rawHeaders[i + 1]}`);
      upstream.write(lines.join("\r\n") + "\r\n\r\n");
      if (head.length) upstream.write(head);
      socket.pipe(upstream).pipe(socket);
    });
    const destroy = () => {
      socket.destroy();
      upstream.destroy();
    };
    upstream.on("error", destroy);
    socket.on("error", destroy);
  });
  return listen(server, port);
}

// CLI for poking at the fixture by hand.
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [mode, portArg, arg] = process.argv.slice(2);
  const port = Number(portArg ?? 8890);
  const started =
    mode === "proxy"
      ? startOriginProxy(port, Number(arg ?? 8888))
      : startLegacyServer(port, { userId: arg ?? "alchemy:00000000-0000-4000-8000-000000000000", elements: [] });
  started.then(() => console.log(`${mode ?? "legacy"} server on http://localhost:${port}`));
}
