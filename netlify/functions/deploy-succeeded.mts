// Netlify event function: runs after every successful deploy. Tells IndexNow (Bing and other
// participating engines) about public pages whose content actually changed, nothing else.
// Changes are detected by hashing each page's HTML (ignoring hashed asset file names) and
// comparing with the hashes stored in Netlify Blobs from the previous deploy.
import { createHash } from "node:crypto";
import { getStore } from "@netlify/blobs";

const HOST = "alchemy.sshh.io";
const KEY = "7fc8fe186af1a871241cd282c69fea92"; // also served as /7fc8fe186af1a871241cd282c69fea92.txt
const PAGES = ["/", "/how-to-play", "/recipes", "/daily", "/about"];

const fingerprint = (html: string) =>
  createHash("sha256")
    .update(html.replace(/\/assets\/[\w.-]+/g, "/assets/*"))
    .digest("hex");

export default async (req: Request): Promise<Response> => {
  if (req.method !== "POST") return new Response(null, { status: 405 });
  const body = (await req.json().catch(() => null)) as { payload?: { context?: string; site_id?: string } } | null;
  const deploy = body?.payload;
  if (deploy?.context !== "production") return new Response(null, { status: 204 });
  if (process.env.SITE_ID && deploy.site_id !== process.env.SITE_ID) return new Response(null, { status: 403 });

  const store = getStore({ name: "indexnow", consistency: "strong" });
  const previous = ((await store.get("hashes", { type: "json" })) ?? {}) as Record<string, string>;
  const current: Record<string, string> = {};
  for (const path of PAGES) {
    const res = await fetch(`https://${HOST}${path}`, { headers: { "user-agent": "infinite-alchemy-indexnow" } }).catch(() => null);
    if (res?.ok) current[path] = fingerprint(await res.text());
    else if (previous[path]) current[path] = previous[path];
  }
  const changed = PAGES.filter((p) => current[p] && current[p] !== previous[p]);
  if (changed.length > 0) {
    const res = await fetch("https://api.indexnow.org/indexnow", {
      method: "POST",
      headers: { "content-type": "application/json; charset=utf-8" },
      body: JSON.stringify({
        host: HOST,
        key: KEY,
        keyLocation: `https://${HOST}/${KEY}.txt`,
        urlList: changed.map((p) => `https://${HOST}${p}`),
      }),
    }).catch((e: Error) => ({ ok: false, status: 0, statusText: e.message }));
    console.info("[indexnow] submitted", changed.join(" "), "->", res.status);
    if (!res.ok && res.status !== 202) return new Response(null, { status: 502 });
  } else {
    console.info("[indexnow] no public page changed");
  }
  await store.setJSON("hashes", current);
  return new Response(null, { status: 204 });
};
