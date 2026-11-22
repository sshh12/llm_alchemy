// Netlify event function: runs after every successful deploy. Tells IndexNow (Bing and other
// participating engines) about public pages whose content actually changed, nothing else.
// Changes are detected by hashing each page's HTML (ignoring hashed asset file names) and
// comparing with the hashes stored in Netlify Blobs from the previous deploy. Every submission
// is also recorded as {time, urls, status} under "log/<time>" in the same store (indexNowLogKey),
// next to the daily /daily ping's (indexnow-daily.mts), so it can be inspected and reported.
import { createHash } from "node:crypto";
import { getStore } from "@netlify/blobs";
import { PUBLIC_PAGES, SITE, indexNowLogKey, submitIndexNow } from "../../src/shared/pages.ts";

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
  for (const path of PUBLIC_PAGES) {
    const res = await fetch(`${SITE}${path}`, { headers: { "user-agent": "infinite-alchemy-indexnow" } }).catch(() => null);
    if (res?.ok) current[path] = fingerprint(await res.text());
    else if (previous[path]) current[path] = previous[path];
  }
  const changed = PUBLIC_PAGES.filter((p) => current[p] && current[p] !== previous[p]);
  if (changed.length > 0) {
    const submission = await submitIndexNow(changed);
    console.info("[indexnow] submitted", changed.join(" "), "->", submission.status);
    // The record is for inspection only: losing it must not lose the hashes (or vice versa).
    await store.setJSON(indexNowLogKey(submission), { ...submission, trigger: "deploy" }).catch((e: Error) => console.warn("[indexnow] log failed", e?.name));
    // Not accepted (2xx; IndexNow answers 200 or 202): keep the old hashes so the next deploy
    // submits these pages again.
    if (submission.status < 200 || submission.status > 299) return new Response(null, { status: 502 });
  } else {
    console.info("[indexnow] no public page changed");
  }
  await store.setJSON("hashes", current);
  return new Response(null, { status: 204 });
};
