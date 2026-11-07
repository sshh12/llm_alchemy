// GET/HEAD /img/<elementId>/<key>.<ext>: serve element art from Netlify Blobs. Keys are
// random per generation, so responses are immutable and cached durably at the CDN.
import type { Config } from "@netlify/functions";
import { ART_CONTENT_TYPES, getArt, type ArtExt } from "../../server/blobs.ts";
import { route } from "../../server/http.ts";

const PATH_RE = /^\/img\/([1-9]\d{0,18})\/([0-9a-f]{16}\.(webp|png))$/;

const notFound = () =>
  new Response("Not found", { status: 404, headers: { "cache-control": "no-store", "content-type": "text/plain" } });

export default route("img", async (req) => {
  if (req.method !== "GET" && req.method !== "HEAD") {
    return new Response(null, { status: 405, headers: { allow: "GET, HEAD", "cache-control": "no-store" } });
  }
  const m = PATH_RE.exec(new URL(req.url).pathname);
  if (!m) return notFound();
  const [, id, file, ext] = m as unknown as [string, string, string, ArtExt];
  const data = await getArt(id, file);
  if (!data) return notFound();
  return new Response(req.method === "HEAD" ? null : data, {
    headers: {
      "content-type": ART_CONTENT_TYPES[ext],
      "content-length": String(data.byteLength),
      "cache-control": "public, max-age=31536000, immutable",
      "netlify-cdn-cache-control": "public, durable, max-age=31536000, immutable",
      // Keep cached art across deploys (function responses are otherwise invalidated per deploy).
      "netlify-cache-id": "img",
      "netlify-cache-tag": "img",
      "x-content-type-options": "nosniff",
    },
  });
});

// No `method` filter: HEAD is not an accepted value there, so methods are checked above.
export const config: Config = {
  path: "/img/*",
};
