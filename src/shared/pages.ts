// HTML shell for the public content pages (/how-to-play, /about, /recipes, /teachers, /privacy,
// /daily, 404), plus the sitemap and IndexNow helpers that announce them.
// Used by scripts/build-pages.ts (static pages written to public/), the /daily function and the
// IndexNow functions, so every page shares one head, header and footer and one list of public
// URLs. Pure string templates: the pages work without JavaScript and never touch a player session.

export const SITE = "https://alchemy.sshh.io";
export const ROBOTS = "index, follow, max-snippet:-1, max-image-preview:large, max-video-preview:-1";

/**
 * Every public, indexable URL: the sitemap lists them (scripts/build-pages.ts) and
 * deploy-succeeded.mts tells IndexNow when one of them changes. "/" is index.html, "/daily" the
 * daily function, the rest are static files the build script writes.
 */
export const PUBLIC_PAGES = ["/", "/how-to-play", "/recipes", "/daily", "/about", "/teachers", "/privacy"] as const;

/**
 * The link teachers share (QR code, Google Classroom). The UTM tags land in players.acq_utm_*
 * through the page head's first-touch capture, so classroom-link players can be counted.
 */
export const CLASSROOM_URL = `${SITE}/?utm_source=classroom&utm_medium=teacher`;

/** Google Classroom's share page for a link: a plain URL, so no Google script runs on our page. */
export function classroomShareUrl(url: string): string {
  return `https://classroom.google.com/share?url=${encodeURIComponent(url)}`;
}

export function esc(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}

export interface PageArt {
  name: string;
  emoji: string | null;
  /** Ready art path like "/img/123/abc.webp", or null to show the emoji. */
  img: string | null;
}

/** A clay tile like the game's: art on a soft plate, name underneath. */
export function tile(el: PageArt, size: "md" | "sm" = "md"): string {
  const px = size === "sm" ? 76 : 116;
  const art = el.img
    ? `<img src="/.netlify/images?url=${encodeURIComponent(el.img)}&amp;w=${px}&amp;h=${px}&amp;fit=contain" alt="" width="${px / 2}" height="${px / 2}" loading="lazy" decoding="async" />`
    : esc(el.emoji ?? "✨");
  return `<span class="tile${size === "sm" ? " sm" : ""}" role="img" aria-label="${esc(el.name)}"><span class="art" aria-hidden="true">${art}</span><span class="name" aria-hidden="true">${esc(el.name)}</span></span>`;
}

const NAV: [string, string][] = [
  ["/", "Play"],
  ["/how-to-play", "How to play"],
  ["/daily", "Today's challenge"],
  ["/recipes", "Recipes"],
  ["/about", "About"],
  ["/teachers", "For teachers"],
  ["/privacy", "Privacy"],
];

const GA = `<script>
      // First-touch acquisition, stored once per browser for players.acq_* (sent when the player
      // is created): external referrer host, landing path and UTM tags of the visit's first page.
      (function () {
        try {
          if (localStorage.getItem("ia:acq")) return;
          var ref = document.referrer ? new URL(document.referrer).hostname : "";
          if (ref === location.hostname) return;
          var utm = new URLSearchParams(location.search);
          localStorage.setItem("ia:acq", JSON.stringify({ ref: ref, path: location.pathname, src: utm.get("utm_source"), med: utm.get("utm_medium"), cmp: utm.get("utm_campaign") }));
        } catch (e) {}
      })();
      if (location.hostname === "alchemy.sshh.io") {
        window.dataLayer = window.dataLayer || [];
        window.gtag = function () { dataLayer.push(arguments); };
        gtag("js", new Date());
        gtag("config", "G-PYCZGBX322");
        addEventListener("load", function () {
          var ga = document.createElement("script");
          ga.async = true;
          ga.src = "https://www.googletagmanager.com/gtag/js?id=G-PYCZGBX322";
          document.head.appendChild(ga);
        });
      }
    </script>`;

export interface PageOptions {
  /** Canonical path, e.g. "/how-to-play". */
  path: string;
  title: string;
  description: string;
  /** Inner HTML of <main>, including its <h1>. */
  body: string;
  /** Extra JSON-LD objects for this page. */
  jsonLd?: object[];
  /** Missing pages must not be indexed or canonicalized. */
  notFound?: boolean;
  /** Page-specific CSS, inlined in the head (shared rules belong in public/pages.css). */
  style?: string;
}

export function renderPage(o: PageOptions): string {
  const url = `${SITE}${o.path}`;
  const ld = [
    {
      "@context": "https://schema.org",
      "@type": "WebPage",
      "@id": `${url}#webpage`,
      url,
      name: o.title,
      description: o.description,
      inLanguage: "en",
      isPartOf: { "@id": `${SITE}/#website` },
      about: { "@id": `${SITE}/#game` },
    },
    ...(o.jsonLd ?? []),
  ];
  const head = o.notFound
    ? `<meta name="robots" content="noindex" />`
    : `<meta name="robots" content="${ROBOTS}" />
    <link rel="canonical" href="${url}" />
    <meta property="og:type" content="website" />
    <meta property="og:site_name" content="Infinite Alchemy" />
    <meta property="og:url" content="${url}" />
    <meta property="og:title" content="${esc(o.title)}" />
    <meta property="og:description" content="${esc(o.description)}" />
    <meta property="og:image" content="${SITE}/og-image.png" />
    <meta property="og:image:width" content="1200" />
    <meta property="og:image:height" content="630" />
    <meta name="twitter:card" content="summary_large_image" />
    <meta name="twitter:site" content="@ShrivuShankar" />
    <meta name="twitter:title" content="${esc(o.title)}" />
    <meta name="twitter:description" content="${esc(o.description)}" />
    <meta name="twitter:image" content="${SITE}/og-image.png" />
    <script type="application/ld+json">${JSON.stringify(ld).replace(/</g, "\\u003c")}</script>`;
  const nav = NAV.map(([href, label]) => `<a href="${href}"${href === o.path ? ' aria-current="page"' : ""}>${label}</a>`).join("");
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />
    <title>${esc(o.title)}</title>
    <meta name="description" content="${esc(o.description)}" />
    <meta name="color-scheme" content="light dark" />
    <meta name="theme-color" content="#F6F1E7" media="(prefers-color-scheme: light)" />
    <meta name="theme-color" content="#16120E" media="(prefers-color-scheme: dark)" />
    ${head}
    <link rel="icon" href="/favicon.ico" sizes="16x16 32x32 48x48" />
    <link rel="icon" href="/icon-192.png" type="image/png" sizes="192x192" />
    <link rel="apple-touch-icon" href="/apple-touch-icon.png" />
    <link rel="preload" href="/fonts/fraunces.woff2" as="font" type="font/woff2" crossorigin />
    <link rel="stylesheet" href="/pages.css" />${o.style ? `\n    <style>${o.style}</style>` : ""}
    ${GA}
  </head>
  <body>
    <header class="site-header">
      <a class="brand" href="/" aria-label="Infinite Alchemy: play">
        <img src="/icon-192.png" alt="" width="36" height="36" />
        <span class="brand-text"><span class="brand-eyebrow">The original</span><span class="brand-name">Infinite Alchemy</span></span>
      </a>
      <a class="btn" href="/">Play free</a>
    </header>
    <main class="page">
${o.body}
    </main>
    <footer class="site-footer">
      <nav aria-label="Site">${nav}</nav>
      <p>Free in your browser, no account needed. Made by <a href="https://sshh.io/">Shrivu Shankar</a> · <a href="https://github.com/sshh12/llm_alchemy">Open source</a></p>
    </footer>
  </body>
</html>
`;
}

// ---------------------------------------------------------------- sitemap

export interface SitemapEntry {
  /** Path from PUBLIC_PAGES, e.g. "/teachers". */
  path: string;
  /** YYYY-MM-DD the page's content last changed, or null to omit <lastmod>. */
  lastmod: string | null;
}

export function sitemapXml(entries: readonly SitemapEntry[]): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${entries.map((e) => `  <url>\n    <loc>${SITE}${e.path}</loc>${e.lastmod ? `\n    <lastmod>${e.lastmod}</lastmod>` : ""}\n  </url>`).join("\n")}
</urlset>
`;
}

/** The <lastmod> of each URL in a sitemap this module wrote, by path. */
export function sitemapLastmods(xml: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const m of xml.matchAll(/<url>\s*<loc>([^<]+)<\/loc>\s*<lastmod>(\d{4}-\d{2}-\d{2})<\/lastmod>/g)) {
    const loc = m[1]!.trim();
    if (loc.startsWith(SITE)) out.set(loc.slice(SITE.length) || "/", m[2]!);
  }
  return out;
}

/**
 * A rebuilt page's <lastmod>: its previous date while the HTML is byte-for-byte unchanged
 * (line endings aside), otherwise the build date. Bing leans on lastmod to decide what to
 * recrawl, so a date that moves on every build would teach it to ignore ours.
 */
export function pageLastmod(before: string | null, after: string, previous: string | undefined, buildDate: string): string {
  const lf = (s: string) => s.replace(/\r\n/g, "\n");
  const same = before !== null && lf(before) === lf(after);
  return same && previous ? previous : buildDate;
}

// ---------------------------------------------------------------- IndexNow

/** IndexNow key: the same value is served as /<key>.txt (public/), which proves we own the host. */
export const INDEXNOW_KEY = "7fc8fe186af1a871241cd282c69fea92";
const INDEXNOW_ENDPOINT = "https://api.indexnow.org/indexnow";

/** One IndexNow POST, as logged in the "indexnow" blob store (see indexNowLogKey). */
export interface IndexNowSubmission {
  /** ISO time the request was sent. */
  time: string;
  /** Absolute URLs submitted. */
  urls: string[];
  /** HTTP status (200/202 = accepted; 0 = the request itself failed). */
  status: number;
}

/** Blob key of a submission's record in the "indexnow" store: list the "log/" prefix to inspect them. */
export const indexNowLogKey = (s: Pick<IndexNowSubmission, "time">) => `log/${s.time}`;

/**
 * Tell IndexNow (Bing and the other participating engines share submissions) that these
 * paths changed. Never throws: a network failure or timeout comes back as status 0.
 */
export async function submitIndexNow(paths: readonly string[], now = new Date(), doFetch: typeof fetch = fetch): Promise<IndexNowSubmission> {
  const urls = paths.map((p) => `${SITE}${p}`);
  const res = await doFetch(INDEXNOW_ENDPOINT, {
    method: "POST",
    headers: { "content-type": "application/json; charset=utf-8" },
    body: JSON.stringify({ host: new URL(SITE).host, key: INDEXNOW_KEY, keyLocation: `${SITE}/${INDEXNOW_KEY}.txt`, urlList: urls }),
    signal: AbortSignal.timeout(10_000),
  }).catch((e: unknown) => {
    console.warn("[indexnow] request failed:", (e as Error)?.name, (e as Error)?.message);
    return null;
  });
  return { time: now.toISOString(), urls, status: res?.status ?? 0 };
}
