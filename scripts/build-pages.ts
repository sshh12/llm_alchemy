// Build the public content pages into public/: /how-to-play, /about, /recipes, /teachers,
// /privacy and the 404 page, plus sitemap.xml. Recipes are REAL persisted recipes from the
// database (active, two-ingredient, minimal number of combinations from the starters, computed
// like elements.steps), with existing art only: this script never generates art or recipes.
//
// Run: npx tsx scripts/build-pages.ts [--schema=alchemy] [--lastmod=YYYY-MM-DD]   (re-run after
// the world or a page changes; commit the generated files). Reads the database only.
// Sitemap <lastmod>: a page keeps its previous date while its HTML is unchanged, otherwise it
// gets the build date (--lastmod overrides it); "/" uses index.html's last commit; /daily changes
// every UTC midnight, so it has no lastmod (a build date would be stale the next day; the daily
// IndexNow ping, netlify/functions/indexnow-daily.mts, announces it instead).
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { QRCodeSVG } from "qrcode.react";
import {
  CLASSROOM_URL,
  PUBLIC_PAGES,
  classroomShareUrl,
  esc,
  pageLastmod,
  renderPage,
  sitemapLastmods,
  sitemapXml,
  tile,
  type PageArt,
} from "../src/shared/pages.ts";
import { DEMO_RECIPE, STARTER_ORDER } from "../src/shared/starters.ts";
import { runMain } from "./lib/cli.ts";
import { createPool, resolveSchema } from "./lib/db.ts";
import { REPO_ROOT, loadEnv } from "./lib/env.ts";
import { knuthFixpoint, stepsOf } from "./lib/graph.ts";
import { loadWorld } from "./lib/world.ts";

/** Recognizable classics whose shortest routes only pass through clean, recognizable names. */
const GUIDE = [
  "Steam", "Mud", "Lava", "Ocean", "Obsidian", "Volcano", "Clay", "Phoenix", "Storm",
  "Cloud", "Swamp", "Desert", "Sand", "Glass", "Tree", "Rainbow", "Clock", "Dragon",
];
const MAX_ROUTE = 7;

interface Step {
  inputs: string[];
  output: string;
}

interface GuideEntry extends PageArt {
  slug: string;
  description: string | null;
  steps: Step[];
}

const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");

async function loadGuide(schema: string) {
  const pool = createPool(2);
  try {
    const { elements, recipes } = await loadWorld(pool, schema);
    const meta = new Map(
      (
        await pool.query<{ id: string; name_key: string; emoji: string | null; description: string | null; image_status: string; image_key: string | null }>(
          `SELECT id, name_key, emoji, description, image_status, image_key FROM ${schema}.elements WHERE status = 'active'`,
        )
      ).rows.map((r) => [r.id, r]),
    );
    const byId = new Map(elements.map((e) => [e.id, e]));
    const idByKey = new Map([...meta.values()].map((r) => [r.name_key, r.id]));
    const starters = elements.filter((e) => e.isStarter).map((e) => e.id);
    const best = knuthFixpoint(starters, recipes, stepsOf);

    const art = (id: string): PageArt => {
      const m = meta.get(id)!;
      return { name: byId.get(id)!.name, emoji: m.emoji, img: m.image_status === "ready" && m.image_key ? `/img/${id}/${m.image_key}` : null };
    };
    const route = (id: string, out: Step[] = [], seen = new Set<string>()): Step[] => {
      if (seen.has(id)) return out;
      seen.add(id);
      const ri = best.via.get(id);
      if (ri === undefined) return out;
      const r = recipes[ri]!;
      for (const ing of new Set(r.ingredients)) route(ing, out, seen);
      out.push({ inputs: r.ingredients.map((i) => byId.get(i)!.name), output: byId.get(id)!.name });
      return out;
    };

    const guide: GuideEntry[] = [];
    for (const name of GUIDE) {
      const id = idByKey.get(name.toLowerCase());
      if (!id) {
        console.warn(`skip ${name}: not an active element`);
        continue;
      }
      const steps = route(id);
      if (steps.length === 0 || steps.length > MAX_ROUTE) {
        console.warn(`skip ${name}: route has ${steps.length} steps`);
        continue;
      }
      guide.push({ ...art(id), slug: slug(name), description: meta.get(id)!.description, steps });
    }
    const starterArt = STARTER_ORDER.map((n) => art(idByKey.get(n.toLowerCase())!));
    return { guide, starterArt, artByName: (n: string) => art(idByKey.get(n.toLowerCase())!) };
  } finally {
    await pool.end();
  }
}

const equation = (inputs: PageArt[], output: PageArt) =>
  `<div class="equation" role="img" aria-label="${esc(inputs.map((i) => i.name).join(" plus "))} makes ${esc(output.name)}">${inputs
    .map((i) => tile(i, "sm"))
    .join('<span class="op" aria-hidden="true">+</span>')}<span class="op" aria-hidden="true">=</span>${tile(output, "sm")}</div>`;

function howToPlay(starters: PageArt[], steam: { water: PageArt; fire: PageArt; steam: PageArt }, guide: GuideEntry[]): string {
  const faq = [
    ["Is Infinite Alchemy free?", "Yes. It's free to play in your browser, with no account, download or ads."],
    ["Does it work on phones?", "Yes. It's designed for touch first: drag from the shelf, or tap to combine. It also works with a mouse and keyboard."],
    [
      "Can students play at school?",
      "Yes. Plays in the browser on school Chromebooks and iPads: no download, no account.",
      ' Teachers can find <a href="/teachers">classroom ideas, a QR code and notes for school IT</a>.',
    ],
    ["Are results the same for everyone?", "Yes. The first time anyone tries a combination, the AI decides the result and it is saved for everyone, forever."],
    ["Is this Little Alchemy?", "No. Infinite Alchemy is an independent game inspired by Little Alchemy. Instead of a fixed list of recipes, an AI invents and paints new elements as you play."],
  ];
  return `      <h1>How to play Infinite Alchemy</h1>
      <p class="lede">Start with five elements and combine them into anything. The AI decides what you made and paints it.</p>
      <div class="cta"><a class="btn" href="/">Start playing</a><a class="btn btn-quiet" href="/recipes">See starter recipes</a></div>

      <h2>The five starters</h2>
      <p>Every game begins with Earth, Water, Air, Fire and Time.</p>
      <div class="starters">${starters.map((s) => tile(s, "sm")).join("")}</div>

      <h2>Combine elements</h2>
      <p>Drag one element onto another on the workbench, or tap one and then another. You can mix two, three or four elements at once: hold your element over a second one for a moment to gather it, then drop onto a third.</p>
      ${equation([steam.water, steam.fire], steam.steam)}
      <p>Each new result joins your library on the shelf, so you can keep combining. Search the library, pin favorites, and clear or tidy the workbench any time (with undo).</p>

      <h2>Discover something new</h2>
      <p>The first time anyone in the world tries a combination, the AI decides the result and it is saved for everyone. If nobody has ever made what you just made, it's yours: you earn a <strong>first discovery</strong> seal.</p>
      <p>Everyday combinations give the answer you'd expect. Clever, specific combinations can land on famous people, places, myths, characters and brands.</p>

      <h2>Rarity</h2>
      <p>Rarity comes from depth: how many rounds of combining an element is from the starters. Elements go from common to uncommon, rare, epic and legendary as you go deeper.</p>

      <h2>Daily challenges</h2>
      <p>Every day there are three targets to make: easy, hard and expert. They change at midnight on your device's local date and can always be made with two-element recipes that already exist. Complete at least one a day to keep your streak going. <a href="/daily">See today's challenge</a>.</p>

      <h2>Saving your progress</h2>
      <p>Progress saves automatically in your browser. To continue on another device, open Settings in the game and use the transfer code. If you played the original version in the same browser, your elements and challenge history are restored on your first visit.</p>

      <h2>A few recipes to get started</h2>
      <ul>${guide
        .slice(0, 6)
        .map((g) => `<li><a href="/recipes#${g.slug}">${esc(g.name)}</a>: ${esc(g.steps.at(-1)!.inputs.join(" + "))}</li>`)
        .join("")}</ul>
      <p><a href="/recipes">More recipes</a></p>

      <h2>Questions</h2>
${faq.map(([q, a, more]) => `      <h3>${esc(q!)}</h3>\n      <p>${esc(a!)}${more ?? ""}</p>`).join("\n")}
      <div class="cta"><a class="btn" href="/">Play Infinite Alchemy</a></div>`;
}

function about(): string {
  return `      <h1>About Infinite Alchemy</h1>
      <p class="lede">The original infinite AI alchemy game: combine elements, and an AI invents and paints whatever you make.</p>

      <h2>The story</h2>
      <p>Infinite Alchemy launched in May 2023 as one of the first games to invent brand-new elements with AI on demand. In the original version, GPT-4 named each new element and DALL·E drew it, and every combination was saved so the world grew with its players.</p>
      <p>In November 2026 it was rebuilt from scratch: a new touch-first interface, a handmade clay art style, a tuned recipe model, daily challenges, and no more credits or payments. It's free. Everyone's progress from the original game carried over.</p>

      <h2>What makes it different</h2>
      <ul>
        <li><strong>Infinite, but stable.</strong> The AI decides each combination once; after that it's the same for everyone.</li>
        <li><strong>First discoveries.</strong> Be the first person to make something and it carries your seal.</li>
        <li><strong>Handmade art.</strong> Every element gets a small clay-style illustration, painted the first time someone needs it.</li>
        <li><strong>Daily challenges.</strong> Three targets a day, always reachable with recipes that already exist.</li>
      </ul>

      <h2>Inspiration</h2>
      <p>Infinite Alchemy is inspired by <a href="https://littlealchemy.com/">Little Alchemy</a> by Jakub Koziol, and is part of a long line of element-combining games. It is an independent project and is not affiliated with Little Alchemy or any other game.</p>

      <h2>Who made it</h2>
      <p>Infinite Alchemy is made by <a href="https://sshh.io/">Shrivu Shankar</a>. The code is <a href="https://github.com/sshh12/llm_alchemy">open source on GitHub</a> (MIT). Recipes come from OpenAI's gpt-6-luna and the art from gpt-image-2.5-flare.</p>

      <h2>Read more</h2>
      <ul>
        <li><a href="https://blog.sshh.io/p/infinite-alchemy">The original launch story</a> (2024 retrospective; it describes the first version, including credits that no longer exist)</li>
        <li><a href="https://github.com/sshh12/llm_alchemy/blob/main/docs/ARCHITECTURE.md">How the current version works</a></li>
        <li><a href="/llms.txt">A plain-text guide for AI assistants</a></li>
        <li><a href="/teachers">Infinite Alchemy for teachers</a>: classroom ideas, a QR code and notes for school IT</li>
        <li><a href="/privacy">Privacy</a>: what the game collects and why</li>
      </ul>
      <div class="cta"><a class="btn" href="/">Play Infinite Alchemy</a><a class="btn btn-quiet" href="/how-to-play">How to play</a></div>`;
}

function recipesPage(guide: GuideEntry[]): string {
  const entry = (g: GuideEntry) => `      <section class="recipe card" id="${g.slug}">
        <div class="recipe-head">${tile(g)}<div><h2>How to make ${esc(g.name)}</h2><p class="muted small">${g.steps.length === 1 ? "1 combination" : `${g.steps.length} combinations`} from the starters</p></div></div>
        ${g.description ? `<p>${esc(g.description)}</p>` : ""}
        <ol class="steps">${g.steps
          .map((s) => `<li>${esc(s.inputs.join(" + "))} = <span class="result">${esc(s.output)}</span></li>`)
          .join("")}</ol>
      </section>`;
  return `      <h1>Infinite Alchemy recipes</h1>
      <p class="lede">How to make ${guide.length} classic elements, step by step from the five starters.</p>
      <p>These are real recipes from the game. Every combination in Infinite Alchemy is decided once and then shared by everyone, so each step below works for you too. Each route uses the fewest combinations we know of; there are often other ways to get there.</p>
      <ul class="guide-index">${guide.map((g) => `<li><a href="#${g.slug}">${esc(g.name)}</a></li>`).join("")}</ul>
${guide.map(entry).join("\n")}
      <div class="cta"><a class="btn" href="/">Try them in the game</a><a class="btn btn-quiet" href="/how-to-play">How to play</a></div>`;
}

function notFound(): string {
  return `      <h1>This page fizzled</h1>
      <p class="lede">We couldn't find that page. Maybe it was a recipe that didn't work out.</p>
      <div class="cta"><a class="btn" href="/">Play Infinite Alchemy</a><a class="btn btn-quiet" href="/how-to-play">How to play</a></div>`;
}

/**
 * The classroom link as a printable QR code: inline SVG, black on white whatever the theme.
 * Named with aria-label (QRCodeSVG sets role="img"), not its `title` prop: an SVG <title> is a
 * second <title> in the page source, which naive crawlers and e2e/head-meta.spec.ts read as a
 * duplicate page title.
 */
function classroomQr(): string {
  return renderToStaticMarkup(
    createElement(QRCodeSVG, {
      value: CLASSROOM_URL,
      size: 192,
      level: "M",
      marginSize: 4,
      bgColor: "#FFFFFF",
      fgColor: "#000000",
      "aria-label": "QR code: play Infinite Alchemy",
    }),
  );
}

const TEACHERS_STYLE = `
      .share-card { display: flex; flex-wrap: wrap; align-items: center; gap: 16px 24px; margin: 1rem 0; }
      .qr { flex: none; width: 168px; height: 168px; border-radius: 12px; overflow: hidden; background: #fff; }
      .qr svg { display: block; width: 100%; height: 100%; }
      .share-text { flex: 1 1 15rem; min-width: 0; }
      .share-text p { margin: 0 0 0.6rem; }
      .link-text { display: block; padding: 8px 12px; border-radius: 12px; background: var(--surface-2); border: 1px solid var(--border); font: 600 0.92rem/1.4 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; overflow-wrap: anywhere; -webkit-user-select: all; user-select: all; }
      .page code { font-size: 0.92em; overflow-wrap: anywhere; }
      @media print {
        body { background: #fff; color: #000; }
        .site-header, .site-footer, .noprint { display: none; }
        .card, .link-text { background: #fff; color: #000; box-shadow: none; border-color: #888; }
        .share-card { break-inside: avoid; }
        .qr { width: 2.5in; height: 2.5in; }
        a { color: #000; }
      }
    `;

function teachers(steam: { water: PageArt; fire: PageArt; steam: PageArt }): string {
  const issues = "https://github.com/sshh12/llm_alchemy/issues";
  return `      <h1>Infinite Alchemy for teachers</h1>
      <p class="lede">A free element-combining game: students start with five elements, combine them into anything, and an AI invents and paints each new result.</p>
      <p><strong>Plays in the browser on school Chromebooks and iPads: no download, no account.</strong> Students open the link and start playing in seconds. Nobody signs up or types a name.</p>
      <div class="cta noprint"><a class="btn" href="/">Try it yourself</a><a class="btn btn-quiet" href="/how-to-play">How to play</a></div>

      <h2>What it is</h2>
      <p>Everyone starts with Earth, Water, Air, Fire and Time. Drag one element onto another, or tap two, to make something new, and keep going: volcanoes, rainbows, dragons, famous inventors.</p>
      ${equation([steam.water, steam.fire], steam.steam)}
      <p>The first time anyone in the world tries a combination, an AI decides the result, and that answer is saved for everyone. So the same combination gives the whole class the same result, and students can check each other's routes.</p>

      <h2>Three classroom ideas</h2>
      <ol>
        <li><strong>Fewest steps.</strong> "Make Volcano, then Life, in the fewest steps." Students write down every combination and compare routes: who found the shortcut, and which steps were detours? The <a href="/recipes">recipe guide</a> has routes for checking afterwards.</li>
        <li><strong>Bell-ringer.</strong> Put <a href="/daily">today's challenge</a> up as class starts: three targets (easy, hard, expert), the same for everyone on the same date, each one reachable with recipes that already exist. Who can make the easy one first?</li>
        <li><strong>Explain why A + B = C.</strong> A short writing prompt: students pick one combination from their library and explain in two or three sentences why the result makes sense, or argue for a better one. Water + Fire = Steam is states of matter; plenty of others lead into earth science, history or art.</li>
      </ol>

      <h2>Share it with your class</h2>
      <div class="card share-card">
        <div class="qr">${classroomQr()}</div>
        <div class="share-text">
          <p><strong>Scan to play</strong>, or open this link:</p>
          <p class="link-text">${esc(CLASSROOM_URL)}</p>
          <div class="cta noprint"><a class="btn" href="${esc(classroomShareUrl(CLASSROOM_URL))}">Share to Google Classroom</a></div>
        </div>
      </div>
      <p class="muted small">Print this page to hand out or post the QR code. The tags in the link only tell us a visit came from a classroom link, nothing about who is playing.</p>

      <h2>Keeping it family-friendly</h2>
      <p>Results come from AI, so we can't promise every one will suit every classroom. This is what keeps them on track:</p>
      <ul>
        <li><strong>Rules for the AI.</strong> The model that names new elements is told to keep results fun for everyone: no gore, illegal drugs, sexual content, slurs, insults or hate. When ingredients push that way, it picks a gentle, wholesome result nearby. Sacred figures of living religions and people famous mainly for cruelty are never results.</li>
        <li><strong>Moderated art.</strong> The image model that paints each element runs with its content moderation on. Art it refuses to draw never appears in the game.</li>
        <li><strong>Cleaned-up history.</strong> Elements from the original version of the game were filtered for spam and reviewed for junk, and names removed that way can't come back.</li>
        <li><strong>No contact between players.</strong> There is no chat, no profiles and no way for players to message each other or name elements themselves.</li>
      </ul>
      <p>Expect everyday grown-up things as plain nouns (a sword, wine), friendly monsters from classic tales, and famous people, places and brands. If you spot an element that shouldn't be in the game, long-press or right-click it in the game and choose <strong>Report this element</strong>. You can also tell us in a <a href="${issues}">GitHub issue</a> with the element's name (and nothing about your students).</p>

      <h2>Privacy</h2>
      <p>There are no accounts, and the game never asks for a name, email or age. Progress is tied to an anonymous player kept in a cookie, and the site uses Google Analytics with a random id to see how the game is played. The <a href="/privacy">privacy page</a> lists everything that is collected.</p>

      <h2>For school IT</h2>
      <ul>
        <li><strong>Domain:</strong> <code>alchemy.sshh.io</code>, over HTTPS.</li>
        <li><strong>Needed, all on alchemy.sshh.io:</strong> the pages and their files (such as <code>/assets/*</code> and <code>/fonts/*</code>), HTTPS POST requests to <code>/api/*</code>, and element images from <code>/img/*</code> and <code>/.netlify/images</code>. It needs JavaScript, including a Web Worker for a short anti-bot check on a student's first visit, and one first-party cookie (<code>ia_session</code>) keeps each student's progress.</li>
        <li><strong>Optional:</strong> Google Analytics (<code>www.googletagmanager.com</code>, <code>*.google-analytics.com</code>). Blocking it doesn't break the game.</li>
        <li><strong>Not used:</strong> no third-party frames, ads, plugins or downloads. The game also can't be embedded in other sites.</li>
      </ul>
      <div class="cta noprint"><a class="btn" href="/">Play Infinite Alchemy</a><a class="btn btn-quiet" href="/daily">Today's challenge</a></div>`;
}

/** Shown on /privacy. Update it whenever the page's text changes. */
const PRIVACY_UPDATED = "November 22, 2026";

function privacy(): string {
  const issues = "https://github.com/sshh12/llm_alchemy/issues";
  return `      <h1>Privacy</h1>
      <p class="lede">Infinite Alchemy has no accounts and never asks for your name, email or age. This is what it does collect, and why.</p>
      <p class="muted small">Last updated ${PRIVACY_UPDATED}.</p>

      <h2>Your anonymous player</h2>
      <p>The first time you play, the game creates an anonymous player for you and keeps it in a cookie (<code>ia_session</code>) that only this site can read. The cookie is signed so it can't be forged, lasts up to 400 days, and is how the game finds your library when you come back. Your player also has a separate random id, used for analytics and for trying out changes to the game with some players.</p>

      <h2>What the game stores</h2>
      <ul>
        <li><strong>Gameplay:</strong> the elements you discover and when, the new recipes and first discoveries you make, your daily challenge completions, how you play each day (how many times you open the game and how many combinations you make, roughly when you start and stop playing, how many separate sessions and about how long you're active), and any element reports you send.</li>
        <li><strong>How you found the game</strong>, saved once when your player is created: the website that sent you (its domain only, like google.com), the first page you opened, and any <code>utm_</code> tags in that link, such as a teacher's classroom link. Each day the game also notes what kind of visit you first opened it from that day: a search engine, a direct visit, the installed app or another site (the kind only, never the page or link).</li>
        <li><strong>Your kind of device:</strong> a coarse platform from your browser (like Chrome OS, iOS, Android, Windows or Mac), never the full browser details, plus a few coarse hints such as whether it has a touch screen, whether the game was opened as an installed app, which layout it showed, and whether this browser already had saved game data when your player was created.</li>
        <li><strong>A scrambled network address, against abuse.</strong> The game never stores your IP address. To stop bots and runaway costs, the server counts requests against a keyed hash of your network address, which can't be turned back into the address without our secret key; those counters expire on their own. The hash from when your player was created stays with your player, and we use it to count, in aggregate, players who start on the same network, like a school.</li>
      </ul>
      <p>The server also keeps anonymous daily counts with nothing that says who they came from, such as how many page loads ended before the game was ready to play (by loading step, rough time and coarse platform) and how many anti-bot checks were started and finished.</p>
      <p>New elements you create join the shared world and can show up in other players' list of recent discoveries, with nothing that says who made them. Game data is stored in a CockroachDB database, and the site runs on Netlify.</p>

      <h2>Google Analytics</h2>
      <p>On alchemy.sshh.io the game uses Google Analytics 4 to understand how it's played: page views and game events such as a combination, a discovery or a completed challenge, tied to your player's random analytics id. Events never include element names or anything you type. Google also receives the usual details a browser sends, like the browser and device type, and works out an approximate location. Blocking Google Analytics, for example with an ad blocker, doesn't affect the game.</p>

      <h2>AI</h2>
      <ul>
        <li>New elements are named by an AI model (OpenAI's gpt-6-luna) and drawn by an image model (OpenAI's gpt-image-2.5-flare) with its moderation on. OpenAI receives the names of the elements being combined or drawn and a scrambled id for your player, which helps it spot abuse; never your IP address or anything else about you.</li>
        <li>If you use "Sort by anything" in your library, the sort you type and the names of your elements are sent to an AI scoring service (TypeSafe Jev), which answers with numbers only. The text you type isn't saved on our server.</li>
      </ul>

      <h2>In your browser</h2>
      <p>The game keeps your settings, pinned elements, workbench layout, recent sorts, a cache of recipes and a few small notes (tips you've finished, the day the "Today in your lab" card last showed, which of the game's trial changes your player gets) in this browser's storage so it loads fast. They stay on your device. The one thing the server learns about them is whether any game data was already there, and it keeps that only when it creates a new player. If you played the original version of the game in this browser, the game reads what that version saved to bring your progress over.</p>

      <h2>Your choices</h2>
      <ul>
        <li><strong>Start over:</strong> in the game, open Settings and choose Reset progress. Your library goes back to the five starters; your first discoveries and challenge history stay.</li>
        <li><strong>Disconnect this browser:</strong> clearing this site's cookies and storage unlinks the browser from your player. Save a transfer code in Settings first if you want to keep playing as that player.</li>
        <li><strong>Questions or requests:</strong> contact the developer by opening an issue on <a href="${issues}">GitHub</a>. Issues are public, so don't include personal information.</li>
      </ul>
      <p>There are no ads in the game. For teachers, the <a href="/teachers">teachers page</a> covers classroom use and school networks.</p>
      <div class="cta"><a class="btn" href="/">Play Infinite Alchemy</a><a class="btn btn-quiet" href="/about">About</a></div>`;
}

/** Date (UTC) index.html, the homepage's crawlable HTML, last changed: build date if it has uncommitted edits. */
function homeLastmod(previous: string | undefined, buildDate: string): string {
  try {
    const git = (...args: string[]) => execFileSync("git", args, { cwd: REPO_ROOT, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
    if (git("status", "--porcelain", "--", "index.html")) return buildDate;
    const committed = git("log", "-1", "--format=%cI", "--", "index.html");
    if (committed) return new Date(committed).toISOString().slice(0, 10);
  } catch {
    // No git (e.g. a source archive): keep the previous date.
  }
  return previous ?? buildDate;
}

async function main() {
  loadEnv();
  const flag = (name: string) => process.argv.find((a) => a.startsWith(`--${name}=`))?.split("=")[1];
  const schema = resolveSchema(flag("schema"));
  const buildDate = flag("lastmod") ?? new Date().toISOString().slice(0, 10);
  const { guide, starterArt, artByName } = await loadGuide(schema);
  const out = path.join(REPO_ROOT, "public");
  const sitemapFile = path.join(out, "sitemap.xml");
  const previous = sitemapLastmods(fs.existsSync(sitemapFile) ? fs.readFileSync(sitemapFile, "utf8") : "");
  const lastmod = new Map<string, string | null>([
    ["/", homeLastmod(previous.get("/"), buildDate)],
    ["/daily", null],
  ]);
  /** Write a page; `page` = its public path, for the sitemap's lastmod. */
  const write = (file: string, html: string, page?: string) => {
    // Never on our pages (2026-11 growth review): school web filters file sites that use that
    // word under filter-evasion tools, which would block the classrooms that already play.
    if (/unblocked/i.test(html)) throw new Error(`public/${file} contains the word "unblocked"`);
    const target = path.join(out, file);
    const before = fs.existsSync(target) ? fs.readFileSync(target, "utf8") : null;
    if (page) lastmod.set(page, pageLastmod(before, html, previous.get(page), buildDate));
    fs.writeFileSync(target, html);
    console.log(`wrote public/${file} (${html.length.toLocaleString()} bytes${before === html ? ", unchanged" : ""})`);
  };
  const steam = { water: artByName(DEMO_RECIPE.a), fire: artByName(DEMO_RECIPE.b), steam: artByName(DEMO_RECIPE.result) };

  write(
    "how-to-play.html",
    renderPage({
      path: "/how-to-play",
      title: "How to play Infinite Alchemy",
      description: "Combine Earth, Water, Air, Fire and Time to discover anything. Learn the controls, first discoveries, rarity, daily challenges and how your progress is saved.",
      body: howToPlay(starterArt, steam, guide),
    }),
    "/how-to-play",
  );
  write(
    "about.html",
    renderPage({
      path: "/about",
      title: "About Infinite Alchemy: the original AI alchemy game",
      description: "Infinite Alchemy launched in May 2023 as one of the first games to invent new elements with AI. Rebuilt in 2026, inspired by Little Alchemy.",
      body: about(),
    }),
    "/about",
  );
  write(
    "recipes.html",
    renderPage({
      path: "/recipes",
      title: "Infinite Alchemy recipes: Steam, Lava, Dragon and more",
      description: `Step-by-step routes from the five starters to ${guide.length} classic elements in Infinite Alchemy, including ${guide
        .slice(-3)
        .map((g) => g.name)
        .join(", ")}. Real recipes from the game.`,
      body: recipesPage(guide),
      jsonLd: [
        {
          "@context": "https://schema.org",
          "@type": "ItemList",
          name: "Infinite Alchemy recipes",
          itemListElement: guide.map((g, i) => ({
            "@type": "ListItem",
            position: i + 1,
            name: `How to make ${g.name}`,
            url: `https://alchemy.sshh.io/recipes#${g.slug}`,
          })),
        },
      ],
    }),
    "/recipes",
  );
  write(
    "teachers.html",
    renderPage({
      path: "/teachers",
      title: "Infinite Alchemy for teachers: classroom guide",
      description: "Use Infinite Alchemy in class: three activity ideas, a printable QR code, a Google Classroom link and notes for school IT. Free, no download, no account.",
      body: teachers(steam),
      style: TEACHERS_STYLE,
    }),
    "/teachers",
  );
  write(
    "privacy.html",
    renderPage({
      path: "/privacy",
      title: "Infinite Alchemy privacy: what the game collects",
      description: "What Infinite Alchemy collects and why: an anonymous player id, gameplay data, a hashed network address for abuse limits, and Google Analytics. No accounts.",
      body: privacy(),
    }),
    "/privacy",
  );
  write("404.html", renderPage({ path: "/404", title: "Page not found · Infinite Alchemy", description: "This page doesn't exist.", body: notFound(), notFound: true }));
  const entries = PUBLIC_PAGES.map((p) => ({ path: p, lastmod: lastmod.has(p) ? lastmod.get(p)! : buildDate }));
  fs.writeFileSync(sitemapFile, sitemapXml(entries));
  console.log(`wrote public/sitemap.xml (${entries.map((e) => `${e.path} ${e.lastmod ?? "-"}`).join(", ")}); guide has ${guide.length} recipes`);
}

runMain(main);
