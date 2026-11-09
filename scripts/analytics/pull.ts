// Pull a GA4 + Search Console + Bing Webmaster snapshot into JSON files (gitignored .analytics/).
// Reads GOOGLE_APPLICATION_CREDENTIALS (service-account key file), GA4_PROPERTY_ID, GSC_SITE_URL,
// BING_WEBMASTER_API_KEY and BING_SITE_URL from .env.
// Never prints secrets.
//
//   npm run analytics:pull [-- --out=.analytics/2026-11-16] [--since=2026-11-07]
import "../lib/env.ts";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import { runMain } from "../lib/cli.ts";
import { REPO_ROOT } from "../lib/env.ts";

type Row = Record<string, string | number>;

function need(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing ${name} in .env`);
  return v;
}

const b64u = (b: string | Buffer) => Buffer.from(b).toString("base64url");
const isoDay = (offsetDays: number) => new Date(Date.now() + offsetDays * 864e5).toISOString().slice(0, 10);

async function googleToken(): Promise<string> {
  const sa = JSON.parse(fs.readFileSync(need("GOOGLE_APPLICATION_CREDENTIALS"), "utf8")) as { client_email: string; private_key: string; token_uri: string };
  const now = Math.floor(Date.now() / 1000);
  const scope = "https://www.googleapis.com/auth/analytics.readonly https://www.googleapis.com/auth/webmasters.readonly";
  const unsigned = `${b64u(JSON.stringify({ alg: "RS256", typ: "JWT" }))}.${b64u(JSON.stringify({ iss: sa.client_email, scope, aud: sa.token_uri, iat: now, exp: now + 3600 }))}`;
  const sig = crypto.createSign("RSA-SHA256").update(unsigned).sign(sa.private_key);
  const res = await fetch(sa.token_uri, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion: `${unsigned}.${b64u(sig)}` }),
  });
  const j = (await res.json()) as { access_token?: string; error?: string };
  if (!j.access_token) throw new Error(`Google token: ${res.status} ${j.error ?? ""}`);
  return j.access_token;
}

async function main(): Promise<void> {
  const { values } = parseArgs({ options: { out: { type: "string" }, since: { type: "string" } } });
  // GA "v2" slices start the first full v2 day (v2 went live the evening of 2026-11-06 PT).
  const since = values.since ?? "2026-11-07";
  const out = path.resolve(REPO_ROOT, values.out ?? path.join(".analytics", isoDay(0)));
  fs.mkdirSync(out, { recursive: true });
  const save = (name: string, data: unknown) => {
    fs.writeFileSync(path.join(out, name), JSON.stringify(data, null, 1));
    const d = data as { rows?: unknown[]; error?: string };
    console.log(`${name}: ${Array.isArray(data) ? data.length : d.error ? `ERROR ${d.error}` : (d.rows?.length ?? "-")}`);
  };

  const token = await googleToken();
  const post = async (url: string, body: unknown) => {
    const res = await fetch(url, { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify(body) });
    const j = (await res.json().catch(() => ({}))) as Record<string, unknown> & { error?: { message?: string } };
    return res.ok ? j : { error: `HTTP ${res.status} ${j.error?.message ?? ""}` };
  };

  // ------------------------------------------------------------------ GA4
  const property = need("GA4_PROPERTY_ID");
  type GaReport = { dimensionHeaders?: { name: string }[]; metricHeaders?: { name: string }[]; rows?: { dimensionValues: { value: string }[]; metricValues: { value: string }[] }[]; error?: string };
  const ga = async (name: string, body: Record<string, unknown>) => {
    const r = (await post(`https://analyticsdata.googleapis.com/v1beta/properties/${property}:runReport`, { limit: 10000, ...body })) as GaReport;
    if (r.error) return save(name, r);
    const dims = (r.dimensionHeaders ?? []).map((h) => h.name);
    const mets = (r.metricHeaders ?? []).map((h) => h.name);
    const rows: Row[] = (r.rows ?? []).map((row) => ({
      ...Object.fromEntries(row.dimensionValues.map((v, i) => [dims[i]!, v.value])),
      ...Object.fromEntries(row.metricValues.map((v, i) => [mets[i]!, Number(v.value)])),
    }));
    save(name, { dims, mets, rows });
  };
  const d = (names: string[]) => names.map((name) => ({ name }));
  const R90 = [{ startDate: "90daysAgo", endDate: "today" }];
  const V2 = [{ startDate: since, endDate: "today" }];
  const only = (events: string[]) => ({ filter: { fieldName: "eventName", inListFilter: { values: events } } });
  const FUNNEL = ["first_visit", "session_start", "app_ready", "onboarding", "first_tile", "first_combine", "discovery", "combine_failed", "challenge_complete", "share", "load_failed"];

  await ga("ga_events_by_date_90d.json", { dateRanges: R90, dimensions: d(["date", "eventName"]), metrics: d(["eventCount", "totalUsers"]) });
  await ga("ga_daily_traffic_90d.json", { dateRanges: R90, dimensions: d(["date"]), metrics: d(["activeUsers", "newUsers", "sessions", "engagedSessions", "userEngagementDuration", "screenPageViews"]) });
  await ga("ga_channels_v2.json", { dateRanges: V2, dimensions: d(["sessionDefaultChannelGroup", "sessionSourceMedium"]), metrics: d(["sessions", "totalUsers", "newUsers", "engagedSessions", "engagementRate", "keyEvents"]) });
  await ga("ga_landing_v2.json", { dateRanges: V2, dimensions: d(["landingPage"]), metrics: d(["sessions", "totalUsers", "newUsers", "engagedSessions", "engagementRate", "keyEvents"]) });
  await ga("ga_os_v2.json", { dateRanges: V2, dimensions: d(["operatingSystem", "deviceCategory"]), metrics: d(["sessions", "totalUsers", "engagementRate", "keyEvents"]) });
  await ga("ga_country_v2.json", { dateRanges: V2, dimensions: d(["country"]), metrics: d(["sessions", "totalUsers", "engagementRate", "keyEvents"]) });
  await ga("ga_pages_v2.json", { dateRanges: V2, dimensions: d(["pagePath"]), metrics: d(["screenPageViews", "totalUsers", "userEngagementDuration"]) });
  // Funnel events by segment: new vs returning, OS (school Chromebooks), landing page.
  for (const [tag, dim] of [["newret", "newVsReturning"], ["os", "operatingSystem"], ["landing", "landingPage"], ["device", "deviceCategory"]] as const) {
    await ga(`ga_funnel_by_${tag}_v2.json`, { dateRanges: V2, dimensions: d([dim, "eventName"]), metrics: d(["eventCount", "totalUsers"]), dimensionFilter: only(FUNNEL) });
  }
  // Custom-dimension breakdowns (only params registered as custom definitions in GA Admin).
  const byParam: [string, string, string[]][] = [
    ["ga_app_ready_segments.json", "app_ready", ["customEvent:pow", "customEvent:wide", "customEvent:standalone"]],
    ["ga_boot_ms.json", "app_ready", ["customEvent:pow", "deviceCategory"]],
    ["ga_onboarding.json", "onboarding", ["customEvent:action", "customEvent:target"]],
    ["ga_first_tile.json", "first_tile", ["customEvent:via"]],
    ["ga_sheet_open.json", "sheet_open", ["customEvent:sheet"]],
    ["ga_combine_failed.json", "combine_failed", ["customEvent:code"]],
    ["ga_load_failed.json", "load_failed", ["customEvent:code"]],
    ["ga_challenge_tiers.json", "challenge_complete", ["customEvent:tier"]],
    ["ga_share.json", "share", ["customEvent:surface", "customEvent:outcome"]],
    ["ga_custom_sort.json", "custom_sort", ["customEvent:kind", "customEvent:from", "customEvent:outcome"]],
  ];
  for (const [file, event, dims] of byParam) {
    const metrics = file === "ga_boot_ms.json" ? ["eventCount", "averageCustomEvent:boot_ms"] : ["eventCount", "totalUsers"];
    await ga(file, { dateRanges: V2, dimensions: d(dims), metrics: d(metrics), dimensionFilter: only([event]) });
  }

  // ------------------------------------------------------------------ Search Console
  const site = encodeURIComponent(need("GSC_SITE_URL"));
  type GscResponse = { rows?: { keys: string[]; clicks: number; impressions: number; ctr: number; position: number }[]; error?: string };
  const gsc = async (name: string, dims: string[], start: string, end: string) => {
    const r = (await post(`https://www.googleapis.com/webmasters/v3/sites/${site}/searchAnalytics/query`, { startDate: start, endDate: end, dimensions: dims, rowLimit: 5000, dataState: "all" })) as GscResponse;
    if (r.error) return save(name, r);
    save(name, {
      range: [start, end],
      dims,
      rows: (r.rows ?? []).map((x) => ({ ...Object.fromEntries(dims.map((k, i) => [k, x.keys[i]!])), clicks: x.clicks, impressions: x.impressions, ctr: +x.ctr.toFixed(4), position: +x.position.toFixed(2) })),
    });
  };
  await gsc("gsc_queries_28d.json", ["query"], isoDay(-29), isoDay(-1));
  await gsc("gsc_queries_prev28d.json", ["query"], isoDay(-57), isoDay(-30));
  await gsc("gsc_pages_28d.json", ["page"], isoDay(-29), isoDay(-1));
  await gsc("gsc_query_page_28d.json", ["query", "page"], isoDay(-29), isoDay(-1));
  await gsc("gsc_daily_16mo.json", ["date"], isoDay(-480), isoDay(-1));
  await gsc("gsc_device_28d.json", ["device"], isoDay(-29), isoDay(-1));
  await gsc("gsc_country_28d.json", ["country"], isoDay(-29), isoDay(-1));
  await gsc("gsc_queries_since.json", ["query"], since, isoDay(-1));
  await gsc("gsc_pages_since.json", ["page"], since, isoDay(-1));

  // ------------------------------------------------------------------ Bing
  const bingDate = (v: unknown) => (typeof v === "string" && /^\/Date\((\d+)/.test(v) ? new Date(Number(/\d+/.exec(v)![0])).toISOString().slice(0, 10) : v);
  const bing = async (name: string, method: string) => {
    const url = `https://ssl.bing.com/webmaster/api.svc/json/${method}?siteUrl=${encodeURIComponent(need("BING_SITE_URL"))}&apikey=${encodeURIComponent(need("BING_WEBMASTER_API_KEY"))}`;
    const res = await fetch(url);
    const text = await res.text();
    if (!res.ok) return save(name, { error: `HTTP ${res.status} ${text.slice(0, 200)}` });
    const rows = ((JSON.parse(text) as { d?: Record<string, unknown>[] }).d ?? []).map((r) =>
      Object.fromEntries(Object.entries(r).filter(([k]) => k !== "__type").map(([k, v]) => [k, bingDate(v)])),
    );
    save(name, rows);
  };
  await bing("bing_query_stats.json", "GetQueryStats");
  await bing("bing_page_stats.json", "GetPageStats");
  await bing("bing_rank_traffic.json", "GetRankAndTrafficStats");
  await bing("bing_crawl_stats.json", "GetCrawlStats");
  await bing("bing_crawl_issues.json", "GetCrawlIssues");
  await bing("bing_sitemaps.json", "GetFeeds");
  console.log(`\nwrote ${out}`);
}

runMain(main);
