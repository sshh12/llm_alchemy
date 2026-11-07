// GET /daily: a public, session-free page with today's three challenge targets (UTC date).
// Shows existing art only (never triggers generation), never reveals other days, and is
// cached at the CDN until the next UTC midnight, so crawlers cost almost nothing.
import type { Config } from "@netlify/functions";
import type { Tier } from "../../src/shared/api.ts";
import { utcDay } from "../../src/shared/dates.ts";
import { esc, renderPage, tile } from "../../src/shared/pages.ts";
import { q, t } from "../../server/db.ts";
import { TIERS, getChallenge } from "../../server/game/challenges.ts";
import { route } from "../../server/http.ts";

interface TargetRow {
  id: string;
  name: string;
  emoji: string | null;
  image_status: string;
  image_key: string | null;
}

const TIER_LABEL: Record<Tier, string> = { easy: "Easy", hard: "Hard", expert: "Expert" };

export default route("daily", async (req) => {
  if (req.method !== "GET" && req.method !== "HEAD") {
    return new Response(null, { status: 405, headers: { allow: "GET, HEAD", "cache-control": "no-store" } });
  }
  const now = new Date();
  const day = utcDay(now);
  const challenge = await getChallenge(day);
  const ids = challenge ? [challenge.easy_id, challenge.hard_id, challenge.expert_id] : [];
  const rows = ids.length
    ? await q<TargetRow>(`SELECT id, name, emoji, image_status, image_key FROM ${t("elements")} WHERE id = ANY($1::INT8[])`, [ids])
    : [];
  const byId = new Map(rows.map((r) => [String(r.id), r]));
  const dateLabel = new Date(`${day}T12:00:00Z`).toLocaleDateString("en-US", {
    weekday: "long",
    month: "long",
    day: "numeric",
    year: "numeric",
    timeZone: "UTC",
  });

  const targets = challenge
    ? TIERS.map((tier, i) => {
        const el = byId.get(String(ids[i]));
        if (!el) return "";
        const steps = challenge[`${tier}_steps`];
        const img = el.image_status === "ready" && el.image_key ? `/img/${el.id}/${el.image_key}` : null;
        return `        <div class="target card">${tile({ name: el.name, emoji: el.emoji, img })}<div><span class="tier ${tier}">${TIER_LABEL[tier]}</span><h3>${esc(el.name)}</h3>${
          steps ? `<p class="muted small">About ${steps} ${steps === 1 ? "combination" : "combinations"} from the starters</p>` : ""
        }</div></div>`;
      }).join("\n")
    : `        <p class="card">Today's challenge is being prepared. Check back soon, or just play: there's plenty to discover.</p>`;

  const body = `      <h1>Today's Infinite Alchemy challenge</h1>
      <p class="lede">${esc(dateLabel)} (UTC)</p>
      <div class="targets">
${targets}
      </div>
      <div class="cta"><a class="btn" href="/">Play today's challenge</a><a class="btn btn-quiet" href="/how-to-play">How to play</a></div>
      <h2>How daily challenges work</h2>
      <p>Every day there are three elements to make: easy, hard and expert. Combine elements on the workbench until you make a target, and that tier is complete. Every target can be made with two-element recipes that already exist in the game.</p>
      <p>In the game, the challenge follows your device's local date, so depending on where you are it may already be tomorrow's, or still yesterday's. This page shows the challenge for the current date in UTC. Complete at least one tier a day to build a streak.</p>
      <p>Stuck? The <a href="/recipes">recipe guide</a> shows routes to classic elements that make good stepping stones.</p>`;

  const html = renderPage({
    path: "/daily",
    title: "Today's Infinite Alchemy daily challenge",
    description: challenge
      ? `Today's Infinite Alchemy targets: ${rows.length ? TIERS.map((tier, i) => `${TIER_LABEL[tier]}: ${byId.get(String(ids[i]))?.name ?? "?"}`).join(", ") : ""}. Three new challenges every day; play free in your browser.`
      : "Three new Infinite Alchemy challenges every day: easy, hard and expert. Play free in your browser.",
    body,
  });

  // Cache until the UTC day changes (at most an hour), so the page never shows a stale day for long.
  const untilMidnight = Math.floor((Date.parse(`${day}T00:00:00Z`) + 86_400_000 - now.getTime()) / 1000);
  const ttl = Math.max(30, Math.min(3_600, untilMidnight));
  return new Response(req.method === "HEAD" ? null : html, {
    headers: {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "public, max-age=0, must-revalidate",
      "netlify-cdn-cache-control": `public, durable, s-maxage=${ttl}, stale-while-revalidate=60`,
      "x-content-type-options": "nosniff",
    },
  });
});

export const config: Config = {
  path: "/daily",
};
