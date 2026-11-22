import { describe, expect, it } from "vitest";
import { bingTime, cityFunnelSummary, classifyQuery, clusterWeekly, type GscRow, headTermWeekly, parseSitemapLocs, weekdayImpressionRatio, weekOf } from "./pull.ts";

describe("parseSitemapLocs", () => {
  it("reads every <loc>", () => {
    const xml = `<?xml version="1.0"?><urlset><url><loc>https://a.example/</loc><lastmod>2026-11-07</lastmod></url>
      <url>
        <loc> https://a.example/daily?x=1&amp;y=2 </loc>
      </url></urlset>`;
    expect(parseSitemapLocs(xml)).toEqual(["https://a.example/", "https://a.example/daily?x=1&y=2"]);
  });
});

describe("classifyQuery", () => {
  it("assigns the first matching cluster", () => {
    const cases: [string, string][] = [
      ["infinite alchemy", "brand"],
      ["Infinte Alchemy game", "brand"],
      ["alchemy infinite", "brand"],
      ["infinite alchemist", "brand"],
      ["infinite alchemy unblocked", "brand"],
      ["little alchemy unblocked", "unblocked"],
      ["infinite craft unblocked", "unblocked"],
      ["little alchemy", "little-alchemy"],
      ["how to make life in little alchemy 2", "little-alchemy"],
      ["littlealchemy", "little-alchemy"],
      ["alchemy game", "alchemy-generic"],
      ["game where you combine elements", "element-generic"],
      ["mix things together game", "element-generic"],
      ["infinite craft", "other"],
    ];
    expect(cases.map(([q]) => [q, classifyQuery(q)])).toEqual(cases);
  });
});

const row = (date: string, query: string, clicks: number, impressions: number, position: number): GscRow => ({ date, query, clicks, impressions, position });

describe("clusterWeekly", () => {
  it("rolls up by week, weekday/weekend and cluster with the anonymized share", () => {
    expect(weekOf("2026-11-22")).toBe("2026-11-16");
    const rows = [
      row("2026-11-16", "infinite alchemy", 10, 20, 2), // Mon
      row("2026-11-17", "infinite alchemy", 6, 20, 4),
      row("2026-11-17", "little alchemy", 2, 10, 20),
      row("2026-11-21", "infinite alchemy", 3, 5, 1), // Sat
    ];
    const totals = [
      { date: "2026-11-16", clicks: 12, impressions: 30, position: 0 },
      { date: "2026-11-17", clicks: 10, impressions: 50, position: 0 },
      { date: "2026-11-21", clicks: 3, impressions: 5, position: 0 },
    ];
    const { clusters, anonymized } = clusterWeekly(rows, totals);
    expect(clusters).toEqual([
      { week: "2026-11-16", part: "weekday", days: 2, cluster: "brand", queries: 1, clicks: 16, impressions: 40, clicks_per_day: 8, impressions_per_day: 20, ctr_pct: 40, position: 3 },
      { week: "2026-11-16", part: "weekday", days: 2, cluster: "little-alchemy", queries: 1, clicks: 2, impressions: 10, clicks_per_day: 1, impressions_per_day: 5, ctr_pct: 20, position: 20 },
      { week: "2026-11-16", part: "weekend", days: 1, cluster: "brand", queries: 1, clicks: 3, impressions: 5, clicks_per_day: 3, impressions_per_day: 5, ctr_pct: 60, position: 1 },
    ]);
    expect(anonymized).toEqual([
      { week: "2026-11-16", part: "weekday", days: 2, total_clicks: 22, total_impressions: 80, anonymized_clicks_pct: 18.2, anonymized_impressions_pct: 37.5 },
      { week: "2026-11-16", part: "weekend", days: 1, total_clicks: 3, total_impressions: 5, anonymized_clicks_pct: 0, anonymized_impressions_pct: 0 },
    ]);
  });
});

describe("headTermWeekly", () => {
  const week = (monday: string, position: number) =>
    Array.from({ length: 7 }, (_, i) => ({ date: new Date(Date.parse(`${monday}T00:00:00Z`) + i * 864e5).toISOString().slice(0, 10), clicks: 1, impressions: 10, position }));

  it("alerts only when the last two full weeks are both past the threshold", () => {
    const rows = [...week("2026-11-02", 20), ...week("2026-11-09", 24), ...week("2026-11-16", 25), ...week("2026-11-23", 40).slice(0, 3)];
    const r = headTermWeekly(rows, "2026-11-02", "2026-11-25");
    expect(r.weeks.map((w) => [w.week, w.full, w.position])).toEqual([
      ["2026-11-02", true, 20],
      ["2026-11-09", true, 24],
      ["2026-11-16", true, 25],
      ["2026-11-23", false, 40], // partial week: ignored by the alert
    ]);
    expect(r.alert).toBe(true);
    expect(headTermWeekly([...week("2026-11-09", 24), ...week("2026-11-16", 22)], "2026-11-09", "2026-11-22").alert).toBe(false);
    expect(headTermWeekly(week("2026-11-16", 30), "2026-11-16", "2026-11-22").alert).toBe(false); // one full week is not enough
  });

  it("weights position by impressions and reports weekdays separately", () => {
    const rows = [
      { date: "2026-11-16", clicks: 2, impressions: 30, position: 10 },
      { date: "2026-11-22", clicks: 0, impressions: 10, position: 30 }, // Sunday
    ];
    expect(headTermWeekly(rows, "2026-11-16", "2026-11-22").weeks[0]).toEqual({
      week: "2026-11-16",
      full: true,
      clicks: 2,
      impressions: 40,
      position: 15,
      weekday_position: 10,
      weekday_clicks: 2,
    });
  });
});

describe("cityFunnelSummary", () => {
  const ev = (city: string, os: string, eventName: string, totalUsers: number, eventCount = totalUsers) => ({ city, operatingSystem: os, eventName, totalUsers, eventCount });

  it("flags cells that load the page but not the game, and reports funnels both ways", () => {
    const rows = [
      ev("Filterville", "Chrome OS", "first_visit", 20),
      ev("Filterville", "Chrome OS", "app_ready", 2),
      ev("Filterville", "Chrome OS", "load_failed", 1, 9),
      ev("Tiny", "Chrome OS", "first_visit", 4), // under 5 first visits: never flagged
      ev("(not set)", "Chrome OS", "first_visit", 50), // unknown city: never flagged
      ev("(not set)", "Chrome OS", "app_ready", 5),
      ev("Open", "Windows", "first_visit", 10),
      ev("Open", "Windows", "app_ready", 9, 30),
      ev("Open", "Windows", "load_failed", 1, 1),
    ];
    const s = cityFunnelSummary(rows);
    expect(s.blocked_cells).toEqual([{ city: "Filterville", operatingSystem: "Chrome OS", first_visit_users: 20, app_ready_users: 2, ready_pct: 10 }]);
    expect(s.blocked_share_of_first_visits_pct).toBe(23.8);
    expect(s.funnel_all).toEqual({ first_visit_users: 84, app_ready_users: 16, ready_pct: 19, load_failed_events: 10, load_failed_pct_of_boots: 21.28 }); // 10 / (37 + 10)
    expect(s.funnel_without_blocked).toMatchObject({ first_visit_users: 64, app_ready_users: 14, load_failed_events: 1 });
    expect(s.by_os.map((o) => [o.operatingSystem, o.all.first_visit_users, o.without_blocked.first_visit_users])).toEqual([
      ["Chrome OS", 74, 54],
      ["Windows", 10, 10],
    ]);
  });
});

describe("weekdayImpressionRatio", () => {
  it("compares weekday impressions only on days both engines cover", () => {
    // Google covers Sun 11-15..Sat 11-21; Bing (lagging) only Sun 11-15..Wed 11-18.
    const google = ["15", "16", "17", "18", "19", "20", "21"].map((d) => ({ date: `2026-11-${d}`, impressions: 100 }));
    const bing = [
      { Date: "2026-11-15", Impressions: 500 }, // weekend: ignored
      { Date: "2026-11-16", Impressions: 10 },
      { Date: "2026-11-18", Impressions: 20 }, // Tue missing inside Bing's range: 0
    ];
    const r = weekdayImpressionRatio(bing, google, ["2026-11-16", "2026-11-20"], 2);
    expect(r.baseline).toEqual({ from: "2026-11-16", to: "2026-11-20", weekdays: 3, bing_per_weekday: 10, google_per_weekday: 100, ratio_pct: 10 });
    expect(r.weeks).toEqual([{ week: "2026-11-16", weekdays: 3, bing_per_weekday: 10, google_per_weekday: 100, ratio_pct: 10 }]);
    expect(weekdayImpressionRatio([], google, ["2026-11-16", "2026-11-20"])).toEqual({ baseline: null, weeks: [] });
  });
});

describe("bingTime", () => {
  it("converts WCF dates and passes other values through", () => {
    expect(bingTime("/Date(1794177778000)/")).toBe("2026-11-08T22:42:58.000Z");
    expect(bingTime("/Date(1794177778000-0800)/")).toBe("2026-11-08T22:42:58.000Z");
    expect(bingTime(42)).toBe(42);
    expect(bingTime("https://a.example/")).toBe("https://a.example/");
  });
});
