import { describe, expect, it } from "vitest";
import {
  armOf,
  artCoverageRows,
  breakdown,
  budgetSections,
  clusterBucket,
  cohortSections,
  combinesBucket,
  type CohortPlayer,
  deviceClass,
  EXPERIMENTS,
  experimentRows,
  mixWeights,
  nextSchoolDay,
  nsdClosure,
  parseBudgetRow,
  parseStatKey,
  phantomCheck,
  rates,
  refClass,
  score,
  standardized,
  startClass,
  statSections,
  weekClosure,
  weekOf,
} from "./snapshot.ts";

const DAY = 86_400_000;
const player = (over: Partial<CohortPlayer> = {}): CohortPlayer => ({
  day0: "2026-11-10",
  landing: "/",
  referrer: "www.google.com",
  utmSource: null,
  platform: "chromeos",
  csize: 1,
  activated: true,
  challengeD0: false,
  combines0: 20,
  ret: [],
  ...over,
});

describe("school calendar", () => {
  it("finds the next school day across weekends, Thanksgiving and winter break", () => {
    expect(nextSchoolDay("2026-11-09")).toBe("2026-11-10"); // Mon → Tue
    expect(nextSchoolDay("2026-11-10")).toBe("2026-11-11"); // Veterans Day is partial: still a school day
    expect(nextSchoolDay("2026-11-13")).toBe("2026-11-16"); // Fri → Mon
    expect(nextSchoolDay("2026-11-14")).toBe("2026-11-16"); // Sat → Mon
    expect(nextSchoolDay("2026-11-15")).toBe("2026-11-16"); // Sun → Mon
    expect(nextSchoolDay("2026-11-24")).toBe("2026-11-25"); // partial days count
    expect(nextSchoolDay("2026-11-25")).toBe("2026-11-30"); // skips Thanksgiving Thu/Fri
    expect(nextSchoolDay("2026-11-26")).toBe("2026-11-30");
    expect(nextSchoolDay("2026-12-18")).toBe("2027-01-04"); // winter break
  });

  it("classifies start days", () => {
    expect(startClass("2026-11-11")).toBe("mon-thu");
    expect(startClass("2026-11-20")).toBe("fri");
    expect(startClass("2026-11-21")).toBe("weekend");
    expect(startClass("2026-11-26")).toBe("holiday");
    expect(startClass("2026-12-25")).toBe("holiday");
    expect(weekOf("2026-11-22")).toBe("2026-11-16");
    expect(weekOf("2026-11-16")).toBe("2026-11-16");
  });

  it("flags weeks touched by a closure, including the NSD day of their Friday", () => {
    expect(weekClosure("2026-11-09")).toBe("partial"); // Veterans Day
    expect(weekClosure("2026-11-16")).toBe("partial"); // Fri 11-20 is judged on Mon 11-23
    expect(weekClosure("2026-11-23")).toBe("full");
    expect(weekClosure("2026-11-30")).toBeNull();
    expect(weekClosure("2026-12-14")).toBe("full"); // Fri 12-18 is judged on 01-04, across the break
    expect(nsdClosure("2026-11-25")).toBe("full"); // Wed → Mon 11-30 across Thanksgiving
    expect(nsdClosure("2026-11-19")).toBeNull();
  });
});

describe("segments", () => {
  it("buckets referrers, group sizes, combines and devices", () => {
    expect(refClass(null)).toBe("direct");
    expect(refClass("www.google.com")).toBe("google");
    expect(refClass("www.google.co.uk")).toBe("google");
    expect(refClass("www.bing.com")).toBe("other");
    expect([1, 2, 4, 5, 14, 15, 40].map(clusterBucket)).toEqual(["solo", "2-4", "2-4", "5-14", "5-14", "15+", "15+"]);
    expect([0, 1, 9, 10, 49, 50, 199, 200].map(combinesBucket)).toEqual(["0", "1-9", "1-9", "10-49", "10-49", "50-199", "50-199", "200+"]);
    expect(deviceClass("mac", true)).toBe("ipad");
    expect(deviceClass("mac", false)).toBe("mac");
    expect(deviceClass("chromeos", true)).toBe("chromeos");
    expect(deviceClass(null, null)).toBe("(unknown)");
  });

  it("assigns experiment arms by hex-digit parity (contract C6)", () => {
    expect(["0", "2", "a", "c", "e"].map(armOf)).toEqual(Array(5).fill("control"));
    expect(["1", "9", "b", "d", "f", "F"].map(armOf)).toEqual(Array(6).fill("treatment"));
    expect(() => armOf("g")).toThrow();
    // Same digit positions as the SQL substr(public_id::STRING, index + 1, 1).
    const id = "123e4567-e89b-12d3-a456-42661417400b";
    expect(EXPERIMENTS.map((e) => [e.name, armOf(id[e.index]!)])).toEqual([
      ["firstRun", "treatment"], // 'b'
      ["idleCard", "control"], // '0'
      ["goals", "control"], // '0'
    ]);
  });
});

describe("score and rates", () => {
  it("guards each horizon until its last local day is 2 UTC days old", () => {
    const thu = score(player({ day0: "2026-11-19", ret: [1] }), "2026-11-22");
    expect([thu.nsdDay, thu.nsd, thu.nsdReady, thu.d1, thu.d1Ready]).toEqual(["2026-11-20", true, true, true, true]);
    const fri = player({ day0: "2026-11-20", ret: [3] });
    expect(score(fri, "2026-11-24").nsdReady).toBe(false);
    expect(score(fri, "2026-11-25")).toMatchObject({ nsdDay: "2026-11-23", nsd: true, nsdReady: true, nsdClosure: "partial", d1: false });
    const wk = player({ day0: "2026-11-09", ret: [1, 3, 7, 9] });
    expect(score(wk, "2026-11-17").r7Ready).toBe(false);
    expect(score(wk, "2026-11-18")).toMatchObject({ r7Ready: true, ret7: 3, week2: true, week2Ready: false, d7: true });
    expect(score(wk, "2026-11-24").week2Ready).toBe(true);
    // Winter break: the NSD of a 12-18 starter is 01-04, 17 days on, inside the fetched horizon.
    expect(score(player({ day0: "2026-12-18", ret: [17] }), "2027-01-10")).toMatchObject({ nsd: true, nsdReady: true });
  });

  it("counts NSD over school-day starts only, unless the row is one start class", () => {
    const today = "2026-12-01";
    const ps = [
      player({ day0: "2026-11-10", ret: [1] }), // Tue, returned Wed
      player({ day0: "2026-11-10", ret: [], activated: false }),
      player({ day0: "2026-11-13", ret: [3] }), // Fri, returned Mon
      player({ day0: "2026-11-14", ret: [2] }), // Sat, returned Mon: not in the headline
    ].map((p) => score(p, today));
    expect(rates(ps)).toMatchObject({ players: 4, activated: 3, activated_pct: 75, nsd_n: 3, nsd_y: 2, nsd_pct: 66.7, nsd_act_n: 2, nsd_act_pct: 100 });
    expect(rates(ps, { nsdAllStarts: true })).toMatchObject({ nsd_n: 4, nsd_y: 3 });
    expect(rates(ps)).toMatchObject({ any7_n: 4, any7_pct: 75, ret2_7_pct: 0, week2_n: 4, week2_pct: 0 });
    expect(rates([])).toMatchObject({ players: 0, activated_pct: null, nsd_pct: null });
  });

  it("groups, sorts and limits breakdown rows", () => {
    const ps = [player(), player(), player({ referrer: null })].map((p) => score(p, "2026-11-30"));
    const rows = breakdown(ps, (p) => refClass(p.referrer));
    expect(rows.map((r) => [r.key, r.players])).toEqual([["google", 2], ["direct", 1]]);
    expect(breakdown(ps, (p) => refClass(p.referrer), { sort: "key", limit: 1 }).map((r) => r.key)).toEqual(["direct"]);
  });
});

describe("standardized activation", () => {
  it("reweights cell rates to the reference mix and reports coverage", () => {
    // Reference: half google solo, half direct solo.
    const ref = [player(), player({ referrer: null })];
    const w = mixWeights(ref);
    expect([...w]).toEqual([["google x solo", 0.5], ["direct x solo", 0.5]]);
    // A later week skewed to direct (activation 50%) with google at 100%: raw 60%, standardized 75%.
    const week = [player(), ...Array.from({ length: 4 }, (_, i) => player({ referrer: null, activated: i < 2 }))];
    expect(standardized(week, w, (p) => p.activated)).toEqual({ pct: 75, coverage_pct: 100 });
    // Cells missing from the group are left out and the weights renormalized.
    expect(standardized([player({ referrer: null, activated: false })], w, (p) => p.activated)).toEqual({ pct: 0, coverage_pct: 50 });
    expect(standardized([player({ csize: 20 })], w, (p) => p.activated)).toEqual({ pct: null, coverage_pct: null });
  });
});

describe("cohortSections", () => {
  const players = [
    player({ day0: "2026-11-10", ret: [1, 2] }),
    player({ day0: "2026-11-12", referrer: null, csize: 12, ret: [1] }),
    player({ day0: "2026-11-13", activated: false, challengeD0: false }),
    player({ day0: "2026-11-14", platform: "mac", touch: true, activeSecs0: 700, sessions0: 2 }),
  ];

  it("keeps the original keys and adds the new ones, with no identifiers", () => {
    const out = cohortSections(players, "2026-11-22");
    for (const k of ["cohorts_by_day", "by_landing", "by_referrer", "by_utm_source", "by_platform", "activated_by_challenge_d0"]) expect(out[k]).toBeInstanceOf(Array);
    for (const k of ["by_weekday_class", "by_ref_class", "by_cluster", "by_ref_cluster", "by_day0_combines", "cohorts_by_week", "eval_windows", "retention_excl_clusters"]) expect(out[k]).toBeInstanceOf(Array);
    expect(out.activation_standardized).toMatchObject({ weights: { "google x solo": 75, "direct x 5-14": 25 } });
    expect((out.retention_excl_clusters as { key: string; players: number }[]).map((r) => r.players)).toEqual([4, 3, 3]);
    expect((out.cohorts_by_day as { key: string; nsd_day: string }[])[0]).toMatchObject({ key: "2026-11-10", nsd_day: "2026-11-11", nsd_closure: "partial" });
    expect(out.by_device_touch).toEqual([expect.objectContaining({ key: "ipad", players: 1 })]);
    expect(out.day0_timing_summary).toMatchObject({ players: 1, activated_10min_pct: 100, activated_2plus_sessions_pct: 100 });
    // EXPERIMENTS_FROM is set (wave-2 deploy): every fixture player predates it, so arms exist but are empty.
    expect((out.experiments as { players: number }[]).every((r) => r.players === 0)).toBe(true);
    expect(JSON.stringify(out)).not.toMatch(/ip_hash|public_id|player_id/);
  });

  it("splits experiment arms for players from the start day", () => {
    const ps = [
      player({ day0: "2026-12-01", arms: { firstRun: "treatment", idleCard: "control", goals: "control" } }),
      player({ day0: "2026-12-01", activated: false, arms: { firstRun: "control", idleCard: "control", goals: "treatment" } }),
      player({ day0: "2026-11-20", arms: { firstRun: "treatment", idleCard: "treatment", goals: "treatment" } }), // before the start
    ].map((p) => score(p, "2026-12-10"));
    const rows = experimentRows(ps, "2026-11-30", mixWeights(ps));
    expect(rows.filter((r) => r.experiment === "firstRun").map((r) => [r.arm, r.players, r.activated])).toEqual([["control", 1, 0], ["treatment", 1, 1]]);
    expect(rows.filter((r) => r.experiment === "idleCard").map((r) => r.players)).toEqual([2, 0]);
  });
});

describe("budgets", () => {
  const now = Date.parse("2026-11-22T21:00:00Z");
  const day = Math.floor(now / DAY);
  const month = Math.floor(now / (30 * DAY));

  it("recovers the window from expires_at (1-min pad before contract C2, 90 days after)", () => {
    expect(parseBudgetRow(`rl:budget.image:all:${day}`, 5, (day + 1) * DAY + 60_000)).toMatchObject({ rule: "budget.image", windowMs: DAY, used: 5 });
    expect(parseBudgetRow(`rl:budget.image.month:all:${month}`, 9, (month + 1) * 30 * DAY + 90 * DAY)).toMatchObject({ windowMs: 30 * DAY, index: 692 });
    expect(parseBudgetRow(`rl:budget.new:all:${day * 24}`, 1, (day * 24 + 1) * 3_600_000 + 90 * DAY)).toMatchObject({ windowMs: 3_600_000 });
    expect(parseBudgetRow(`rl:budget.image.month:all:${month}`, 1, 123)).toMatchObject({ windowMs: 30 * DAY }); // name fallback
    expect(parseBudgetRow("once:abc", 1, 0)).toBeNull();
  });

  it("splits current windows, a 30-day daily history and earlier long windows", () => {
    const pad = 90 * DAY;
    const rows = [
      parseBudgetRow(`rl:budget.llm:all:${day}`, 100, (day + 1) * DAY + pad)!,
      parseBudgetRow(`rl:budget.llm:all:${day - 1}`, 90, day * DAY + pad)!,
      parseBudgetRow(`rl:budget.image:all:${day - 1}`, 2000, day * DAY + pad)!,
      parseBudgetRow(`rl:budget.llm:all:${day - 40}`, 1, (day - 39) * DAY + pad)!,
      parseBudgetRow(`rl:budget.image.month:all:${month}`, 30000, (month + 1) * 30 * DAY + pad)!,
      parseBudgetRow(`rl:budget.image.month:all:${month - 1}`, 40000, month * 30 * DAY + pad)!,
    ];
    const out = budgetSections(rows, now);
    expect(out.budgets.map((r) => [r.name, r.used])).toEqual([["budget.image.month", 30000], ["budget.llm", 100]]);
    expect(out.budgets_history).toEqual([
      { day: "2026-11-21", "budget.llm": 90, "budget.image": 2000 },
      { day: "2026-11-22", "budget.llm": 100 },
    ]);
    expect(out.budgets_previous_windows).toEqual([expect.objectContaining({ name: "budget.image.month", used: 40000, window_ends: "2026-11-03T00:00:00.000Z" })]);
  });

  it("checks phantom monthly charges against image attempts", () => {
    const m = parseBudgetRow(`rl:budget.image.month:all:692`, 34448, 693 * 30 * DAY + 60_000)!;
    expect(phantomCheck(m, 30159, undefined, now)).toMatchObject({ monthly_counter: 34448, phantom_in_window: 4289 });
    const prev = { generated_at: "2026-11-20T21:00:00.000Z", window_index: 692, monthly_counter: 30000, image_attempts_total: 26000 };
    expect(phantomCheck(m, 30159, prev, now)).toMatchObject({ phantom_since_previous: 289, phantom_per_day_since_previous: 144.5 });
    const next = parseBudgetRow(`rl:budget.image.month:all:693`, 10, 694 * 30 * DAY + 90 * DAY)!;
    expect(phantomCheck(next, 30200, undefined, now).phantom_in_window).toBeNull();
    expect(phantomCheck(undefined, 1)).toHaveProperty("note");
  });
});

describe("stat counters (contract C1)", () => {
  const now = Date.parse("2026-11-25T12:00:00Z");
  const d = Math.floor(now / DAY);
  it("parses names that contain colons", () => {
    expect(parseStatKey(`stat:denied:llm.player:${d}`)).toEqual({ name: "denied:llm.player", day: "2026-11-25" });
    expect(parseStatKey(`stat:boot_abandon:pow:5-10s:chromeos:${d}`)).toEqual({ name: "boot_abandon:pow:5-10s:chromeos", day: "2026-11-25" });
    expect(parseStatKey("stat:nope")).toBeNull();
  });

  it("splits families into daily rows and pivots art lanes and PoW", () => {
    const out = statSections(
      [
        { key: `stat:denied:llm.player:${d}`, count: 40 },
        { key: `stat:denied:budget.image:${d}`, count: 300 },
        { key: `stat:denied:llm.player:${d - 40}`, count: 1 }, // older than 30 days
        { key: `stat:fizzle:invalid_json:${d}`, count: 3 },
        { key: `stat:art:fresh:started:${d}`, count: 900 },
        { key: `stat:art:fresh:deferred_pace:${d}`, count: 50 },
        { key: `stat:art:backlog:deferred_player:${d}`, count: 7 },
        { key: `stat:pow:issued:chromeos:${d}`, count: 10 },
        { key: `stat:pow:redeemed:chromeos:${d}`, count: 8 },
        { key: `stat:pow:latency:2-5s:${d}`, count: 6 },
        { key: `stat:boot_abandon:pow:5-10s:ios:${d}`, count: 2 },
        { key: `stat:something:else:${d}`, count: 1 },
      ],
      now,
    );
    expect(out.stat_denials_by_day).toEqual([
      { day: "2026-11-25", rule: "budget.image", n: 300 },
      { day: "2026-11-25", rule: "llm.player", n: 40 },
    ]);
    expect(out.stat_fizzles_by_day).toEqual([{ day: "2026-11-25", reason: "invalid_json", n: 3 }]);
    expect(out.stat_art_by_day).toEqual([
      { day: "2026-11-25", lane: "backlog", deferred_player: 7 },
      { day: "2026-11-25", lane: "fresh", started: 900, deferred_pace: 50 },
    ]);
    expect(out.stat_pow_by_day).toEqual([{ day: "2026-11-25", ua: "chromeos", issued: 10, redeemed: 8, redeemed_pct: 80 }]);
    expect(out.stat_pow_latency_by_day).toEqual([{ day: "2026-11-25", band: "2-5s", n: 6 }]);
    expect(out.stat_boot_abandon_by_day).toEqual([{ day: "2026-11-25", phase: "pow", band: "5-10s", ua: "ios", n: 2 }]);
    expect(out.stat_other_by_day).toEqual([{ day: "2026-11-25", name: "something:else", n: 1 }]);
  });
});

describe("artCoverageRows", () => {
  it("pivots half-day counts into coverage per day", () => {
    const rows = artCoverageRows(
      [
        { day: "2026-11-25", half: "am", n: "10", y: "9" },
        { day: "2026-11-25", half: "pm", n: "30", y: "6" },
      ],
      [{ day: "2026-11-25", half: "pm", n: 100, y: 50 }],
    );
    expect(rows).toEqual([
      { day: "2026-11-25", wf_n: 40, wf_1h_pct: 37.5, wf_00_11_pct: 90, wf_12_23_pct: 20, disc_n: 100, disc_1h_pct: 50, disc_00_11_pct: null, disc_12_23_pct: 50 },
    ]);
  });
});
