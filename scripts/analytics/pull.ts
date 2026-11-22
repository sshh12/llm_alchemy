// Pull a GA4 + Search Console + Bing Webmaster snapshot into JSON files (gitignored .analytics/).
// Reads GOOGLE_APPLICATION_CREDENTIALS (service-account key file), GA4_PROPERTY_ID, GSC_SITE_URL,
// BING_WEBMASTER_API_KEY and BING_SITE_URL from .env. Read-only APIs and scopes only.
// Never prints secrets.
//
//   npm run analytics:pull [-- --out=.analytics/2026-11-16] [--since=2026-11-07]
//
// GA ranges end 2 days ago: GA keeps processing the last ~48 h (newUsers and engagement for
// "yesterday" rose 44-80% on a re-pull), so those days go to ga_provisional_2d.json instead.
// Derived files: ga_city_funnel_v2.json (blocked-district cells), gsc_index.json (URL Inspection
// of every sitemap URL), gsc_clusters_weekly.json (query clusters by week and the desktop
// "little alchemy" position alert), bing_url_info.json, bing_keyword_panel.json and
// bing_google_ratio.json. How to read them: .analytics/ANALYTICS.md.
import "../lib/env.ts";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import { isMain, runMain } from "../lib/cli.ts";
import { REPO_ROOT } from "../lib/env.ts";

type Row = Record<string, string | number>;
type Out = Record<string, string | number | boolean | null>;

function need(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing ${name} in .env`);
  return v;
}

const b64u = (b: string | Buffer) => Buffer.from(b).toString("base64url");
const isoDay = (offsetDays: number) => new Date(Date.now() + offsetDays * 864e5).toISOString().slice(0, 10);
const addDays = (day: string, n: number) => new Date(Date.parse(`${day}T00:00:00Z`) + n * 864e5).toISOString().slice(0, 10);
const weekdayOf = (day: string) => new Date(`${day}T00:00:00Z`).getUTCDay();
export const isWeekend = (day: string): boolean => weekdayOf(day) === 0 || weekdayOf(day) === 6;
/** Monday of the week containing `day` (YYYY-MM-DD). */
export const weekOf = (day: string): string => addDays(day, -((weekdayOf(day) + 6) % 7));
const round = (x: number, digits: number) => Math.round(x * 10 ** digits) / 10 ** digits;
const share = (y: number, n: number, digits = 1): number | null => (n > 0 ? round((100 * y) / n, digits) : null);

// ------------------------------------------------------------------ pure helpers (tested)

/** <loc> values of a sitemap. */
export function parseSitemapLocs(xml: string): string[] {
  return [...xml.matchAll(/<loc>\s*([^<\s]+)\s*<\/loc>/g)].map((m) => m[1]!.replace(/&amp;/g, "&"));
}

export type QueryCluster = "brand" | "unblocked" | "little-alchemy" | "alchemy-generic" | "element-generic" | "other";
/**
 * Search-query cluster, first match wins: brand (incl. misspellings), unblocked (any game),
 * little-alchemy, other alchemy queries, generic element-combining queries, other.
 */
export function classifyQuery(query: string): QueryCluster {
  const q = query.toLowerCase();
  if (/infini\w* ?alch|alch\w* infini|infinte alch|infinity alch|sshh|infinitealchemy/.test(q)) return "brand";
  if (q.includes("unblock")) return "unblocked";
  if (/little ?alch/.test(q)) return "little-alchemy";
  if (q.includes("alch")) return "alchemy-generic";
  if (/element|combin|merg|mix/.test(q)) return "element-generic";
  return "other";
}

export interface GscRow {
  date: string;
  query?: string;
  clicks: number;
  impressions: number;
  position: number;
}

/**
 * Weekly clicks/impressions/position per cluster, split weekday/weekend, plus the anonymized
 * share: what the date-only totals hold beyond the date x query rows (rare queries GSC hides).
 */
export function clusterWeekly(rows: readonly GscRow[], totals: readonly GscRow[]): { clusters: Out[]; anonymized: Out[] } {
  const part = (d: string) => (isWeekend(d) ? "weekend" : "weekday");
  const days = new Map<string, Set<string>>();
  const tot = new Map<string, { clicks: number; impressions: number }>();
  for (const t of totals) {
    const k = `${weekOf(t.date)}|${part(t.date)}`;
    (days.get(k) ?? days.set(k, new Set()).get(k)!).add(t.date);
    const x = tot.get(k) ?? { clicks: 0, impressions: 0 };
    x.clicks += t.clicks;
    x.impressions += t.impressions;
    tot.set(k, x);
  }
  const agg = new Map<string, { clicks: number; impressions: number; posImpr: number; queries: Set<string> }>();
  const inQueries = new Map<string, { clicks: number; impressions: number }>();
  for (const r of rows) {
    const wp = `${weekOf(r.date)}|${part(r.date)}`;
    const k = `${wp}|${classifyQuery(r.query ?? "")}`;
    const a = agg.get(k) ?? { clicks: 0, impressions: 0, posImpr: 0, queries: new Set<string>() };
    a.clicks += r.clicks;
    a.impressions += r.impressions;
    a.posImpr += r.position * r.impressions;
    a.queries.add(r.query ?? "");
    agg.set(k, a);
    const q = inQueries.get(wp) ?? { clicks: 0, impressions: 0 };
    q.clicks += r.clicks;
    q.impressions += r.impressions;
    inQueries.set(wp, q);
  }
  const clusters = [...agg]
    .map(([k, a]) => {
      const [week, weekpart, cluster] = k.split("|") as [string, string, string];
      const n = days.get(`${week}|${weekpart}`)?.size ?? 0;
      return {
        week,
        part: weekpart,
        days: n,
        cluster,
        queries: a.queries.size,
        clicks: a.clicks,
        impressions: a.impressions,
        clicks_per_day: n ? round(a.clicks / n, 1) : null,
        impressions_per_day: n ? round(a.impressions / n, 1) : null,
        ctr_pct: share(a.clicks, a.impressions),
        position: a.impressions ? round(a.posImpr / a.impressions, 2) : null,
      };
    })
    .sort((a, b) => (a.week === b.week ? (a.part === b.part ? b.impressions - a.impressions : a.part < b.part ? -1 : 1) : a.week < b.week ? -1 : 1));
  const anonymized = [...tot]
    .map(([k, t]) => {
      const [week, weekpart] = k.split("|") as [string, string];
      const q = inQueries.get(k) ?? { clicks: 0, impressions: 0 };
      return {
        week,
        part: weekpart,
        days: days.get(k)?.size ?? 0,
        total_clicks: t.clicks,
        total_impressions: t.impressions,
        anonymized_clicks_pct: share(Math.max(0, t.clicks - q.clicks), t.clicks),
        anonymized_impressions_pct: share(Math.max(0, t.impressions - q.impressions), t.impressions),
      };
    })
    .sort((a, b) => (a.week === b.week ? (a.part < b.part ? -1 : 1) : a.week < b.week ? -1 : 1));
  return { clusters, anonymized };
}

/**
 * Weekly impression-weighted position of one query (the desktop "little alchemy" head term).
 * Full weeks are Monday-Sunday weeks inside [firstDay, lastDay]; the alert fires when the last
 * two full weeks are both worse (higher) than `threshold`.
 */
export function headTermWeekly(rows: readonly GscRow[], firstDay: string, lastDay: string, threshold = 23): { threshold: number; alert: boolean; weeks: Out[] } {
  const weeks = new Map<string, GscRow[]>();
  for (const r of rows) (weeks.get(weekOf(r.date)) ?? weeks.set(weekOf(r.date), []).get(weekOf(r.date))!).push(r);
  const pos = (xs: readonly GscRow[]) => {
    const impr = xs.reduce((s, x) => s + x.impressions, 0);
    return impr ? round(xs.reduce((s, x) => s + x.position * x.impressions, 0) / impr, 2) : null;
  };
  const out = [...weeks]
    .sort(([a], [b]) => (a < b ? -1 : 1))
    .map(([week, xs]) => {
      const wd = xs.filter((x) => !isWeekend(x.date));
      return {
        week,
        full: week >= firstDay && addDays(week, 6) <= lastDay,
        clicks: xs.reduce((s, x) => s + x.clicks, 0),
        impressions: xs.reduce((s, x) => s + x.impressions, 0),
        position: pos(xs),
        weekday_position: pos(wd),
        weekday_clicks: wd.reduce((s, x) => s + x.clicks, 0),
      };
    });
  const full = out.filter((w) => w.full);
  const lastTwo = full.slice(-2);
  const alert = lastTwo.length === 2 && lastTwo.every((w) => w.position !== null && w.position > threshold);
  return { threshold, alert, weeks: out };
}

export interface CityRow {
  city: string;
  operatingSystem: string;
  eventName: string;
  totalUsers: number;
  eventCount: number;
}

/**
 * New-user boot funnel by city x OS. A cell is "blocked" (a filtered school district: the page
 * loads, the game never does) with >= minFirstVisits first visits and under maxReadyShare of
 * them reaching app_ready. "(not set)" cities are never flagged. Funnels with and without them.
 */
export function cityFunnelSummary(rows: readonly CityRow[], { minFirstVisits = 5, maxReadyShare = 0.3 } = {}) {
  const cells = new Map<string, { city: string; os: string; fv: number; ready: number; readyEvents: number; lfEvents: number }>();
  for (const r of rows) {
    const k = `${r.city}|${r.operatingSystem}`;
    const c = cells.get(k) ?? { city: r.city, os: r.operatingSystem, fv: 0, ready: 0, readyEvents: 0, lfEvents: 0 };
    if (r.eventName === "first_visit") c.fv += r.totalUsers;
    if (r.eventName === "app_ready") {
      c.ready += r.totalUsers;
      c.readyEvents += r.eventCount;
    }
    if (r.eventName === "load_failed") c.lfEvents += r.eventCount;
    cells.set(k, c);
  }
  const all = [...cells.values()];
  const isBlocked = (c: (typeof all)[number]) => c.city !== "(not set)" && c.fv >= minFirstVisits && c.ready / c.fv < maxReadyShare;
  const blocked = all.filter(isBlocked);
  const funnel = (cs: typeof all) => {
    const fv = cs.reduce((s, c) => s + c.fv, 0);
    const ready = cs.reduce((s, c) => s + c.ready, 0);
    const readyEvents = cs.reduce((s, c) => s + c.readyEvents, 0);
    const lf = cs.reduce((s, c) => s + c.lfEvents, 0);
    return { first_visit_users: fv, app_ready_users: ready, ready_pct: share(ready, fv), load_failed_events: lf, load_failed_pct_of_boots: share(lf, readyEvents + lf, 2) };
  };
  const oses = [...new Set(all.map((c) => c.os))];
  return {
    rule: `blocked cell: city x OS with >= ${minFirstVisits} new-user first visits and < ${maxReadyShare * 100}% of them reaching app_ready ("(not set)" never)`,
    blocked_cells: blocked
      .sort((a, b) => b.fv - a.fv)
      .map((c) => ({ city: c.city, operatingSystem: c.os, first_visit_users: c.fv, app_ready_users: c.ready, ready_pct: share(c.ready, c.fv) })),
    blocked_share_of_first_visits_pct: share(
      blocked.reduce((s, c) => s + c.fv, 0),
      all.reduce((s, c) => s + c.fv, 0),
    ),
    funnel_all: funnel(all),
    funnel_without_blocked: funnel(all.filter((c) => !isBlocked(c))),
    by_os: oses
      .map((os) => ({ operatingSystem: os, all: funnel(all.filter((c) => c.os === os)), without_blocked: funnel(all.filter((c) => c.os === os && !isBlocked(c))) }))
      .sort((a, b) => b.all.first_visit_users - a.all.first_visit_users),
  };
}

/**
 * Bing / Google impressions per weekday (Mon-Fri): a ratio robust to school holidays and
 * seasonality, both engines dip together. Only days both sources cover; Bing days missing
 * inside its range count as 0.
 */
export function weekdayImpressionRatio(
  bing: readonly { Date: string; Impressions: number }[],
  google: readonly { date: string; impressions: number }[],
  baseline: readonly [from: string, to: string],
  weeksBack = 12,
) {
  const b = new Map(bing.map((r) => [r.Date, r.Impressions]));
  const g = new Map(google.map((r) => [r.date, r.impressions]));
  const bDays = [...b.keys()].sort();
  const gDays = [...g.keys()].sort();
  if (!bDays.length || !gDays.length) return { baseline: null, weeks: [] };
  const from = bDays[0]! > gDays[0]! ? bDays[0]! : gDays[0]!;
  const to = bDays.at(-1)! < gDays.at(-1)! ? bDays.at(-1)! : gDays.at(-1)!;
  const window = (a: string, z: string) => {
    let n = 0;
    let bi = 0;
    let gi = 0;
    for (let d = a < from ? from : a; d <= (z > to ? to : z); d = addDays(d, 1)) {
      if (isWeekend(d)) continue;
      n++;
      bi += b.get(d) ?? 0;
      gi += g.get(d) ?? 0;
    }
    return { weekdays: n, bing_per_weekday: n ? round(bi / n, 1) : null, google_per_weekday: n ? round(gi / n, 1) : null, ratio_pct: share(bi, gi) };
  };
  const weeks: Out[] = [];
  for (let w = weekOf(addDays(to, -7 * (weeksBack - 1))); w <= to; w = addDays(w, 7)) weeks.push({ week: w, ...window(w, addDays(w, 6)) });
  return { covered: [from, to], baseline: { from: baseline[0], to: baseline[1], ...window(baseline[0], baseline[1]) }, weeks: weeks.filter((w) => Number(w.weekdays) > 0) };
}

/** Bing's "/Date(1794177778000)/" (optionally with an offset) → ISO timestamp; other values pass through. */
export const bingTime = (v: unknown): unknown => (typeof v === "string" && /^\/Date\((-?\d+)/.test(v) ? new Date(Number(/-?\d+/.exec(v)![0])).toISOString() : v);
const bingDate = (v: unknown): unknown => {
  const t = bingTime(v);
  return typeof t === "string" && t !== v ? t.slice(0, 10) : t;
};

// ------------------------------------------------------------------ API access

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

/** Sitemap URLs: the repo's public/sitemap.xml (what the next deploy serves), else the build. */
function sitemapUrls(): { source: string; urls: string[] } {
  for (const rel of ["public/sitemap.xml", "dist/sitemap.xml"]) {
    const f = path.join(REPO_ROOT, rel);
    if (fs.existsSync(f)) return { source: rel, urls: parseSitemapLocs(fs.readFileSync(f, "utf8")) };
  }
  return { source: "(none)", urls: [] };
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
  type GaResult = { dims: string[]; mets: string[]; rows: Row[] } | { error: string };
  const gaReport = async (body: Record<string, unknown>): Promise<GaResult> => {
    const r = (await post(`https://analyticsdata.googleapis.com/v1beta/properties/${property}:runReport`, { limit: 10000, ...body })) as GaReport;
    if (r.error) return { error: r.error };
    const dims = (r.dimensionHeaders ?? []).map((h) => h.name);
    const mets = (r.metricHeaders ?? []).map((h) => h.name);
    const rows: Row[] = (r.rows ?? []).map((row) => ({
      ...Object.fromEntries(row.dimensionValues.map((v, i) => [dims[i]!, v.value])),
      ...Object.fromEntries(row.metricValues.map((v, i) => [mets[i]!, Number(v.value)])),
    }));
    return { dims, mets, rows };
  };
  const ga = async (name: string, body: Record<string, unknown>) => {
    const r = await gaReport(body);
    save(name, r);
    return r;
  };
  const d = (names: string[]) => names.map((name) => ({ name }));
  // Complete days only: GA's last ~48 h are still processing (see the header).
  const R90 = [{ startDate: "90daysAgo", endDate: "2daysAgo" }];
  const V2 = [{ startDate: since, endDate: "2daysAgo" }];
  const only = (events: string[]) => ({ filter: { fieldName: "eventName", inListFilter: { values: events } } });
  const FUNNEL = ["first_visit", "session_start", "app_ready", "onboarding", "first_tile", "first_combine", "discovery", "combine_failed", "challenge_complete", "share", "load_failed"];
  const TRAFFIC = ["activeUsers", "newUsers", "sessions", "engagedSessions", "userEngagementDuration", "screenPageViews"];

  await ga("ga_events_by_date_90d.json", { dateRanges: R90, dimensions: d(["date", "eventName"]), metrics: d(["eventCount", "totalUsers"]) });
  await ga("ga_daily_traffic_90d.json", { dateRanges: R90, dimensions: d(["date"]), metrics: d(TRAFFIC) });
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
  // The last 2 days, still processing: provisional, never compared week over week.
  const LAST2 = [{ startDate: "yesterday", endDate: "today" }];
  const provTraffic = await gaReport({ dateRanges: LAST2, dimensions: d(["date"]), metrics: d(TRAFFIC) });
  const provEvents = await gaReport({ dateRanges: LAST2, dimensions: d(["date", "eventName"]), metrics: d(["eventCount", "totalUsers"]), dimensionFilter: only(FUNNEL) });
  save("ga_provisional_2d.json", { note: "yesterday and today: GA is still processing these (newUsers/engagement grow on re-pull); provisional only", traffic: provTraffic, events: provEvents });
  // Boot funnel of new users by city x OS: filtered school districts load the page but never the game.
  const city = await gaReport({
    dateRanges: V2,
    limit: 100000,
    dimensions: d(["city", "operatingSystem", "eventName"]),
    metrics: d(["totalUsers", "eventCount"]),
    dimensionFilter: { andGroup: { expressions: [only(["first_visit", "app_ready", "load_failed"]), { filter: { fieldName: "newVsReturning", stringFilter: { value: "new" } } }] } },
  });
  save("ga_city_funnel_v2.json", "error" in city ? city : { ...city, summary: cityFunnelSummary(city.rows as unknown as CityRow[]) });

  // ------------------------------------------------------------------ Search Console
  const siteUrl = need("GSC_SITE_URL");
  const site = encodeURIComponent(siteUrl);
  type GscResponse = { rows?: { keys: string[]; clicks: number; impressions: number; ctr: number; position: number }[]; error?: string };
  /** Rows of a Search Analytics query: one page of `rowLimit`, or every row (pages of 25,000) without it. */
  const gscRows = async (body: Record<string, unknown>, dims: string[]): Promise<{ rows: Record<string, string | number>[] } | { error: string }> => {
    const rows: Record<string, string | number>[] = [];
    const limit = Number(body.rowLimit ?? 25000);
    for (let startRow = 0; ; startRow += limit) {
      const r = (await post(`https://www.googleapis.com/webmasters/v3/sites/${site}/searchAnalytics/query`, { dataState: "all", ...body, rowLimit: limit, startRow })) as GscResponse;
      if (r.error) return { error: r.error };
      const page = r.rows ?? [];
      for (const x of page) rows.push({ ...Object.fromEntries(dims.map((k, i) => [k, x.keys[i]!])), clicks: x.clicks, impressions: x.impressions, ctr: +x.ctr.toFixed(4), position: +x.position.toFixed(2) });
      if (body.rowLimit !== undefined || page.length < limit || startRow >= 500000) return { rows };
    }
  };
  const gsc = async (name: string, dims: string[], start: string, end: string) => {
    const r = await gscRows({ startDate: start, endDate: end, dimensions: dims, rowLimit: 5000 }, dims);
    if ("error" in r) return save(name, r);
    save(name, { range: [start, end], dims, rows: r.rows });
    return r.rows;
  };
  await gsc("gsc_queries_28d.json", ["query"], isoDay(-29), isoDay(-1));
  await gsc("gsc_queries_prev28d.json", ["query"], isoDay(-57), isoDay(-30));
  await gsc("gsc_pages_28d.json", ["page"], isoDay(-29), isoDay(-1));
  await gsc("gsc_query_page_28d.json", ["query", "page"], isoDay(-29), isoDay(-1));
  const gscDaily = await gsc("gsc_daily_16mo.json", ["date"], isoDay(-480), isoDay(-1));
  await gsc("gsc_device_28d.json", ["device"], isoDay(-29), isoDay(-1));
  await gsc("gsc_country_28d.json", ["country"], isoDay(-29), isoDay(-1));
  await gsc("gsc_queries_since.json", ["query"], since, isoDay(-1));
  await gsc("gsc_pages_since.json", ["page"], since, isoDay(-1));

  // Index coverage: URL Inspection of every sitemap URL (webmasters.readonly suffices; 2,000/day quota).
  const sitemap = sitemapUrls();
  const inspected: Out[] = [];
  for (const url of sitemap.urls) {
    const r = (await post("https://searchconsole.googleapis.com/v1/urlInspection/index:inspect", { inspectionUrl: url, siteUrl })) as {
      error?: string;
      inspectionResult?: { indexStatusResult?: Record<string, unknown> };
    };
    const x = r.inspectionResult?.indexStatusResult ?? {};
    const pick = (k: string) => (typeof x[k] === "string" ? (x[k] as string) : null);
    inspected.push({
      url,
      error: r.error ?? null,
      verdict: pick("verdict"),
      coverageState: pick("coverageState"),
      indexingState: pick("indexingState"),
      robotsTxtState: pick("robotsTxtState"),
      pageFetchState: pick("pageFetchState"),
      lastCrawlTime: pick("lastCrawlTime"),
      crawledAs: pick("crawledAs"),
      googleCanonical: pick("googleCanonical"),
      userCanonical: pick("userCanonical"),
    });
  }
  save("gsc_index.json", { sitemap: sitemap.source, indexed: inspected.filter((u) => u.verdict === "PASS").length, total: inspected.length, rows: inspected });

  // Query clusters by week (final data only, so weeks compare) and the desktop head-term alert.
  const cStart = isoDay(-56);
  const cEnd = isoDay(-1);
  const dq = await gscRows({ startDate: cStart, endDate: cEnd, dimensions: ["date", "query"], dataState: "final" }, ["date", "query"]);
  const dt = await gscRows({ startDate: cStart, endDate: cEnd, dimensions: ["date"], dataState: "final" }, ["date"]);
  const head = await gscRows(
    {
      startDate: cStart,
      endDate: cEnd,
      dimensions: ["date"],
      dataState: "final",
      dimensionFilterGroups: [{ filters: [{ dimension: "query", operator: "equals", expression: "little alchemy" }, { dimension: "device", operator: "equals", expression: "DESKTOP" }] }],
    },
    ["date"],
  );
  if ("error" in dq || "error" in dt || "error" in head) save("gsc_clusters_weekly.json", { error: [dq, dt, head].map((x) => ("error" in x ? x.error : "")).join(" ").trim() });
  else {
    save("gsc_date_query_56d.json", { range: [cStart, cEnd], dims: ["date", "query"], rows: dq.rows });
    const lastDay = (dt.rows as unknown as GscRow[]).map((r) => r.date).sort().at(-1) ?? cEnd;
    save("gsc_clusters_weekly.json", {
      range: [cStart, cEnd],
      last_final_day: lastDay,
      ...clusterWeekly(dq.rows as unknown as GscRow[], dt.rows as unknown as GscRow[]),
      little_alchemy_desktop: headTermWeekly(head.rows as unknown as GscRow[], cStart, lastDay),
    });
  }

  // ------------------------------------------------------------------ Bing
  const bingCall = async (method: string, params: Record<string, string> = {}): Promise<{ d: unknown } | { error: string }> => {
    const qs = Object.entries({ siteUrl: need("BING_SITE_URL"), ...params, apikey: need("BING_WEBMASTER_API_KEY") })
      .map(([k, v]) => `${k}=${encodeURIComponent(v)}`)
      .join("&");
    const res = await fetch(`https://ssl.bing.com/webmaster/api.svc/json/${method}?${qs}`);
    const text = await res.text();
    if (!res.ok) return { error: `HTTP ${res.status} ${text.slice(0, 200)}` };
    return { d: (JSON.parse(text) as { d?: unknown }).d };
  };
  const clean = (r: Record<string, unknown>, conv: (v: unknown) => unknown) => Object.fromEntries(Object.entries(r).filter(([k]) => k !== "__type").map(([k, v]) => [k, conv(v)]));
  const bing = async (name: string, method: string) => {
    const r = await bingCall(method);
    if ("error" in r) return save(name, r);
    const rows = ((r.d as Record<string, unknown>[] | undefined) ?? []).map((x) => clean(x, bingDate));
    save(name, rows);
    return rows;
  };
  await bing("bing_query_stats.json", "GetQueryStats");
  await bing("bing_page_stats.json", "GetPageStats");
  const rank = await bing("bing_rank_traffic.json", "GetRankAndTrafficStats");
  await bing("bing_crawl_stats.json", "GetCrawlStats");
  await bing("bing_crawl_issues.json", "GetCrawlIssues");
  await bing("bing_sitemaps.json", "GetFeeds");
  // Per-URL state (DocumentSize 0 = Bing never processed a fetch) and a fixed keyword panel.
  const urlInfo: Record<string, unknown>[] = [];
  for (const url of sitemap.urls) {
    const r = await bingCall("GetUrlInfo", { url });
    urlInfo.push("error" in r ? { Url: url, error: r.error } : clean((r.d ?? {}) as Record<string, unknown>, bingTime));
  }
  save("bing_url_info.json", urlInfo);
  const PANEL = ["little alchemy", "infinite craft", "infinite craft unblocked", "alchemy game", "infinite alchemy"];
  const panel: Record<string, unknown>[] = [];
  for (const q of PANEL) {
    const r = await bingCall("GetKeywordStats", { q, country: "us", language: "en-US" });
    if ("error" in r) panel.push({ Query: q, error: r.error });
    else for (const x of (r.d as Record<string, unknown>[] | undefined) ?? []) panel.push(clean(x, bingDate));
  }
  save("bing_keyword_panel.json", panel);
  if (Array.isArray(rank) && Array.isArray(gscDaily)) {
    save(
      "bing_google_ratio.json",
      weekdayImpressionRatio(
        rank as { Date: string; Impressions: number }[],
        gscDaily as unknown as { date: string; impressions: number }[],
        ["2026-10-05", "2026-10-30"], // legacy baseline window (ANALYTICS.md "Key dates")
      ),
    );
  }
  console.log(`\nwrote ${out}`);
}

if (isMain(import.meta.url)) runMain(main);
