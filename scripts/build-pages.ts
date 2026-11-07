// Build the public content pages into public/: /how-to-play, /about, /recipes and the 404 page,
// plus sitemap.xml. Recipes are REAL persisted recipes from the database (active, two-ingredient,
// minimal number of combinations from the starters, computed like elements.steps), with
// existing art only: this script never generates art or recipes.
//
// Run: npx tsx scripts/build-pages.ts [--schema=alchemy]   (re-run after the world changes;
// commit the generated files). Reads the database only.
import fs from "node:fs";
import path from "node:path";
import { esc, renderPage, tile, type PageArt } from "../src/shared/pages.ts";
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
const STARTERS = ["Earth", "Water", "Air", "Fire", "Time"];
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
    const starterArt = STARTERS.map((n) => art(idByKey.get(n.toLowerCase())!));
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
${faq.map(([q, a]) => `      <h3>${esc(q!)}</h3>\n      <p>${esc(a!)}</p>`).join("\n")}
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

function sitemap(lastmod: string): string {
  const urls: [string, string | null][] = [
    ["/", lastmod],
    ["/how-to-play", lastmod],
    ["/recipes", lastmod],
    ["/daily", null],
    ["/about", lastmod],
  ];
  return `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${urls.map(([p, d]) => `  <url>\n    <loc>https://alchemy.sshh.io${p}</loc>${d ? `\n    <lastmod>${d}</lastmod>` : ""}\n  </url>`).join("\n")}
</urlset>
`;
}

async function main() {
  loadEnv();
  const flag = (name: string) => process.argv.find((a) => a.startsWith(`--${name}=`))?.split("=")[1];
  const schema = resolveSchema(flag("schema"));
  const lastmod = flag("lastmod") ?? new Date().toISOString().slice(0, 10);
  const { guide, starterArt, artByName } = await loadGuide(schema);
  const out = path.join(REPO_ROOT, "public");
  const write = (file: string, html: string) => {
    fs.writeFileSync(path.join(out, file), html);
    console.log(`wrote public/${file} (${html.length.toLocaleString()} bytes)`);
  };

  write(
    "how-to-play.html",
    renderPage({
      path: "/how-to-play",
      title: "How to play Infinite Alchemy",
      description: "Combine Earth, Water, Air, Fire and Time to discover anything. Learn the controls, first discoveries, rarity, daily challenges and how your progress is saved.",
      body: howToPlay(starterArt, { water: artByName("Water"), fire: artByName("Fire"), steam: artByName("Steam") }, guide),
    }),
  );
  write(
    "about.html",
    renderPage({
      path: "/about",
      title: "About Infinite Alchemy: the original AI alchemy game",
      description: "Infinite Alchemy launched in May 2023 as one of the first games to invent new elements with AI. Rebuilt in 2026, inspired by Little Alchemy.",
      body: about(),
    }),
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
  );
  write("404.html", renderPage({ path: "/404", title: "Page not found · Infinite Alchemy", description: "This page doesn't exist.", body: notFound(), notFound: true }));
  fs.writeFileSync(path.join(out, "sitemap.xml"), sitemap(lastmod));
  console.log(`wrote public/sitemap.xml (lastmod ${lastmod}); guide has ${guide.length} recipes`);
}

runMain(main);
