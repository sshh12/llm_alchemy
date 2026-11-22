// Netlify scheduled function: every day at 00:05 UTC, just after /daily switches to the new UTC
// day's targets (its CDN copy expires at midnight), tell IndexNow (Bing and the other participating
// engines) that /daily changed. The page changes every day, but deploy-succeeded.mts only pings
// what a deploy changed, so Bing could go weeks without hearing about it. Only /daily, once a
// day: re-pinging unchanged pages would look like spam.
// Production only; the HTTP status is logged and recorded as {time, urls, status} under
// "log/<time>" in the "indexnow" blob store, like the deploy hook's submissions.
import { getStore } from "@netlify/blobs";
import type { Config, Context } from "@netlify/functions";
import { indexNowLogKey, submitIndexNow } from "../../src/shared/pages.ts";

export default async (_req: Request, context: Context): Promise<Response> => {
  const deployContext = context?.deploy?.context ?? process.env.CONTEXT;
  if (deployContext !== "production") {
    console.info("[indexnow] daily ping skipped:", deployContext ?? "unknown context");
    return new Response(null, { status: 204 });
  }
  const submission = await submitIndexNow(["/daily"]);
  console.info("[indexnow] daily", submission.urls.join(" "), "->", submission.status);
  await getStore({ name: "indexnow", consistency: "strong" })
    .setJSON(indexNowLogKey(submission), { ...submission, trigger: "daily" })
    .catch((e: Error) => console.warn("[indexnow] log failed", e?.name));
  return new Response(null, { status: 204 });
};

export const config: Config = {
  schedule: "5 0 * * *",
};
