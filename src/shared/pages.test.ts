import { describe, expect, it, vi } from "vitest";
import {
  CLASSROOM_URL,
  INDEXNOW_KEY,
  PUBLIC_PAGES,
  ROBOTS,
  SITE,
  classroomShareUrl,
  esc,
  indexNowLogKey,
  pageLastmod,
  renderPage,
  sitemapLastmods,
  sitemapXml,
  submitIndexNow,
  tile,
} from "./pages.ts";

describe("content page shell", () => {
  const html = renderPage({ path: "/how-to-play", title: 'How to play <"Alchemy">', description: "Learn & play.", body: "<h1>Hi</h1>" });

  it("is indexable with a canonical URL, generous previews and one H1", () => {
    expect(html).toContain('<link rel="canonical" href="https://alchemy.sshh.io/how-to-play" />');
    expect(html).toContain(`<meta name="robots" content="${ROBOTS}" />`);
    expect(ROBOTS).toContain("max-snippet:-1");
    expect(html.match(/<h1[\s>]/g)).toHaveLength(1);
    expect(html).toContain('aria-current="page"');
  });

  it("escapes text in the head", () => {
    expect(html).toContain("<title>How to play &lt;&quot;Alchemy&quot;&gt;</title>");
    expect(html).toContain('content="Learn &amp; play."');
    expect(esc(`<a href="x">'`)).toBe("&lt;a href=&quot;x&quot;&gt;&#39;");
  });

  it("keeps the 404 page out of the index", () => {
    const notFound = renderPage({ path: "/404", title: "Not found", description: "x", body: "<h1>Nope</h1>", notFound: true });
    expect(notFound).toContain('<meta name="robots" content="noindex" />');
    expect(notFound).not.toContain('rel="canonical"');
  });

  it("only links existing art, otherwise shows the emoji", () => {
    expect(tile({ name: "Steam", emoji: "♨️", img: null })).toContain("♨️");
    expect(tile({ name: "Steam", emoji: "♨️", img: "/img/1/abc.webp" })).toContain("/.netlify/images?url=%2Fimg%2F1%2Fabc.webp");
  });

  it("links the teacher and privacy pages from every footer, and every footer page is public", () => {
    const footer = html.slice(html.indexOf("<footer"));
    const links = [...footer.matchAll(/<nav[^>]*>(.*?)<\/nav>/gs)].flatMap((m) => [...m[1]!.matchAll(/href="([^"]+)"/g)].map((l) => l[1]!));
    expect(links).toEqual(expect.arrayContaining(["/teachers", "/privacy"]));
    for (const href of links) expect(PUBLIC_PAGES as readonly string[], `${href} is in the sitemap`).toContain(href);
  });

  it("inlines page-specific CSS only when given", () => {
    expect(html).not.toContain("<style>");
    const styled = renderPage({ path: "/teachers", title: "t", description: "d", body: "<h1>T</h1>", style: ".qr { width: 1in; }" });
    expect(styled).toContain("<style>.qr { width: 1in; }</style>");
    expect(styled.indexOf("<style>")).toBeLessThan(styled.indexOf("</head>"));
  });
});

describe("classroom link", () => {
  it("tags classroom visits for first-touch acquisition", () => {
    const url = new URL(CLASSROOM_URL);
    expect(url.origin).toBe(SITE);
    expect(url.pathname).toBe("/");
    expect(url.searchParams.get("utm_source")).toBe("classroom");
    expect(url.searchParams.get("utm_medium")).toBe("teacher");
  });

  it("shares through Google Classroom's plain share URL, fully encoded", () => {
    const share = new URL(classroomShareUrl(CLASSROOM_URL));
    expect(share.origin + share.pathname).toBe("https://classroom.google.com/share");
    expect(share.searchParams.get("url")).toBe(CLASSROOM_URL);
    expect(classroomShareUrl(CLASSROOM_URL)).not.toContain("&utm_medium");
  });
});

describe("sitemap", () => {
  const xml = sitemapXml([
    { path: "/", lastmod: "2026-11-08" },
    { path: "/teachers", lastmod: "2026-11-22" },
    { path: "/daily", lastmod: null },
  ]);

  it("lists absolute URLs with their lastmod", () => {
    expect(xml).toMatch(/^<\?xml version="1.0" encoding="UTF-8"\?>\n<urlset /);
    expect(xml).toContain("<loc>https://alchemy.sshh.io/</loc>\n    <lastmod>2026-11-08</lastmod>");
    expect(xml).toContain("<loc>https://alchemy.sshh.io/daily</loc>\n  </url>");
  });

  it("reads back the dates it wrote, by path", () => {
    expect(sitemapLastmods(xml)).toEqual(
      new Map([
        ["/", "2026-11-08"],
        ["/teachers", "2026-11-22"],
      ]),
    );
    expect(sitemapLastmods("")).toEqual(new Map());
    expect(sitemapLastmods(xml.replace(/\n/g, "\r\n")).get("/teachers")).toBe("2026-11-22");
  });

  it("keeps a page's date until its HTML changes", () => {
    expect(pageLastmod("<p>a</p>\n", "<p>a</p>\n", "2026-11-07", "2026-11-22")).toBe("2026-11-07");
    expect(pageLastmod("<p>a</p>\r\n", "<p>a</p>\n", "2026-11-07", "2026-11-22"), "a CRLF checkout is not a change").toBe("2026-11-07");
    expect(pageLastmod("<p>a</p>", "<p>b</p>", "2026-11-07", "2026-11-22")).toBe("2026-11-22");
    expect(pageLastmod(null, "<p>new</p>", undefined, "2026-11-22"), "a new page").toBe("2026-11-22");
    expect(pageLastmod("<p>a</p>", "<p>a</p>", undefined, "2026-11-22"), "no earlier date to keep").toBe("2026-11-22");
  });
});

describe("IndexNow", () => {
  const now = new Date("2026-11-23T00:05:00.000Z");

  it("posts absolute URLs with the key whose file proves ownership", async () => {
    const doFetch = vi.fn(async () => new Response(null, { status: 202 }));
    const sub = await submitIndexNow(["/daily"], now, doFetch as unknown as typeof fetch);
    expect(sub).toEqual({ time: "2026-11-23T00:05:00.000Z", urls: ["https://alchemy.sshh.io/daily"], status: 202 });
    const [url, init] = doFetch.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://api.indexnow.org/indexnow");
    expect(init.method).toBe("POST");
    expect(JSON.parse(init.body as string)).toEqual({
      host: "alchemy.sshh.io",
      key: INDEXNOW_KEY,
      keyLocation: `https://alchemy.sshh.io/${INDEXNOW_KEY}.txt`,
      urlList: ["https://alchemy.sshh.io/daily"],
    });
    expect(indexNowLogKey(sub)).toBe("log/2026-11-23T00:05:00.000Z");
  });

  it("reports a failed request as status 0 instead of throwing", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const doFetch = vi.fn(async () => {
      throw new TypeError("fetch failed");
    });
    const sub = await submitIndexNow(["/", "/teachers"], now, doFetch as unknown as typeof fetch);
    expect(sub.status).toBe(0);
    expect(sub.urls).toEqual(["https://alchemy.sshh.io/", "https://alchemy.sshh.io/teachers"]);
    warn.mockRestore();
  });

  it("serves the key file it names", async () => {
    const fs = await import("node:fs");
    const file = new URL(`../../public/${INDEXNOW_KEY}.txt`, import.meta.url);
    expect(fs.readFileSync(file, "utf8").trim()).toBe(INDEXNOW_KEY);
  });
});
