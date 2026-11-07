// HTML shell for the public content pages (/how-to-play, /about, /recipes, /daily, 404).
// Used by scripts/build-pages.ts (static pages written to public/) and by the /daily
// function, so every page shares one head, header and footer. Pure string templates:
// the pages work without JavaScript and never touch a player session.

export const SITE = "https://alchemy.sshh.io";
export const ROBOTS = "index, follow, max-snippet:-1, max-image-preview:large, max-video-preview:-1";

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
];

const GA = `<script>
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
    <link rel="stylesheet" href="/pages.css" />
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
