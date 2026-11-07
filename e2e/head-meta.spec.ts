// (12) What crawlers, link previews, installs and AI agents read: the <head> (title, description,
// canonical, Open Graph/Twitter cards whose image really exists), the web manifest and every
// icon, the crawler/agent files, the content pages the sitemap lists, and the 2023 asset URLs
// old installs still request. Device-independent, so it runs on one project. A missing file can
// come back as the SPA's index.html with a 200 (Vite's dev fallback), so every asset is also
// checked for its content type and file signature, and every page for its own canonical.
import type { APIRequestContext, Page } from "@playwright/test";
import { utcDay } from "../src/shared/dates.ts";
import { expect, test } from "./support/test.ts";

const SITE = "https://alchemy.sshh.io/";

interface Head {
  lang: string;
  titles: string[];
  /** `name` or `property` -> every `content` with that key. */
  meta: Record<string, string[]>;
  links: { rel: string; href: string; sizes: string | null; type: string | null; as: string | null }[];
  jsonLd: string[];
}

interface Manifest {
  name?: string;
  short_name?: string;
  start_url?: string;
  display?: string;
  theme_color?: string;
  background_color?: string;
  icons?: { src: string; sizes: string; type?: string; purpose?: string }[];
}

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function pngSize(png: Buffer, label: string): string {
  expect(png.subarray(0, 8).equals(PNG_SIGNATURE), `${label} is a PNG`).toBe(true);
  return `${png.readUInt32BE(16)}x${png.readUInt32BE(20)}`;
}

/** The sizes listed in an .ico directory (a 0 byte means 256). */
function icoSizes(ico: Buffer, label: string): string[] {
  expect([...ico.subarray(0, 4)], `${label} is an ICO`).toEqual([0, 0, 1, 0]);
  return Array.from({ length: ico.readUInt16LE(4) }, (_, i) => {
    const w = ico[6 + i * 16] || 256;
    const h = ico[7 + i * 16] || 256;
    return `${w}x${h}`;
  });
}

/** GET a same-origin URL that must be a real file whose content type matches `type`. */
async function asset(request: APIRequestContext, url: string, type: RegExp): Promise<Buffer> {
  const res = await request.get(url);
  expect(res.status(), `${url} status`).toBe(200);
  expect(res.headers()["content-type"], `${url} content type`).toMatch(type);
  return res.body();
}

/** A production URL of this site, fetched from the server under test by its path. */
function localPath(absolute: string): string {
  const url = new URL(absolute);
  expect(url.origin, `${absolute} is on the canonical origin`).toBe(new URL(SITE).origin);
  return url.pathname;
}

/**
 * GET an HTML page and parse it exactly as served (what a crawler sees), with scripts inert.
 * Redirects are not followed: a page's own URL must answer directly.
 */
async function fetchHead(page: Page, request: APIRequestContext, path: string): Promise<{ head: Head; html: string; setCookie?: string }> {
  const res = await request.get(path, { maxRedirects: 0 });
  expect(res.status(), `${path} status`).toBe(200);
  expect(res.headers()["content-type"], `${path} content type`).toMatch(/^text\/html/);
  const html = await res.text();
  const head = await page.evaluate((source) => {
    const doc = new DOMParser().parseFromString(source, "text/html");
    const meta: Record<string, string[]> = {};
    for (const m of doc.head.querySelectorAll("meta[name], meta[property]")) {
      (meta[m.getAttribute("property") ?? m.getAttribute("name")!] ??= []).push(m.getAttribute("content") ?? "");
    }
    return {
      lang: doc.documentElement.lang,
      titles: [...doc.querySelectorAll("title")].map((t) => t.textContent ?? ""),
      meta,
      links: [...doc.head.querySelectorAll("link[rel][href]")].map((l) => ({
        rel: l.getAttribute("rel")!,
        href: l.getAttribute("href")!,
        sizes: l.getAttribute("sizes"),
        type: l.getAttribute("type"),
        as: l.getAttribute("as"),
      })),
      jsonLd: [...doc.querySelectorAll('script[type="application/ld+json"]')].map((s) => s.textContent ?? ""),
    };
  }, html);
  return { head, html, setCookie: res.headers()["set-cookie"] };
}

/** The `content` of the one <meta> with this name/property. */
function only(head: Head, key: string, label = ""): string {
  const values = head.meta[key] ?? [];
  expect(values, `${label}exactly one <meta> ${key}`).toHaveLength(1);
  return values[0]!;
}

/** One <title> naming the game, of a length search results show in full (soft: keep checking the rest). */
function expectSearchSnippet(head: Head, label = ""): { title: string; description: string } {
  expect(head.titles, `${label}exactly one <title>`).toHaveLength(1);
  const title = head.titles[0]!.trim();
  expect(title, `${label}title names the game`).toContain("Infinite Alchemy");
  // Search engines cut titles past ~60 characters and snippets past ~160.
  expect.soft(title.length, `${label}title "${title}" (${title.length} chars) fits a search result`).toBeLessThanOrEqual(60);
  const description = only(head, "description", label);
  const fits = `${label}description (${description.length} chars) fits a search snippet`;
  expect.soft(description.length, fits).toBeGreaterThanOrEqual(50);
  expect.soft(description.length, fits).toBeLessThanOrEqual(160);
  return { title, description };
}

test.describe("head and public assets", () => {
  test.skip(({ device }) => device.project !== "desktop-chrome", "server-rendered head and static files are the same on every device");

  let head: Head;
  const one = (key: string): string => only(head, key);

  test.beforeEach(async ({ page, request }) => {
    ({ head } = await fetchHead(page, request, "/"));
  });

  test("title, description, canonical and social cards", async ({ page, game }) => {
    expect(head.lang).toBe("en");
    const { title } = expectSearchSnippet(head);
    expect(one("viewport")).toContain("width=device-width");
    expect(head.meta["theme-color"]?.length, "theme-color").toBeGreaterThanOrEqual(1);
    expect(head.links.filter((l) => l.rel === "canonical").map((l) => l.href)).toEqual([SITE]);

    expect(one("og:type")).toBe("website");
    expect(one("og:url")).toBe(SITE);
    expect(one("og:title")).toContain("Infinite Alchemy");
    expect(one("og:description").length).toBeGreaterThan(0);
    expect(one("og:image:alt").length).toBeGreaterThan(0);
    expect(one("twitter:card")).toBe("summary_large_image");
    expect(one("twitter:title")).toContain("Infinite Alchemy");
    expect(one("twitter:description").length).toBeGreaterThan(0);

    for (const ld of head.jsonLd) expect(() => JSON.parse(ld), "JSON-LD parses").not.toThrow();
    expect(head.jsonLd.join("")).toContain('"VideoGame"');

    // The running app keeps that title (nothing overrides it after boot).
    await game.open();
    await expect(page).toHaveTitle(title);
  });

  test("the share image exists at the advertised URL and size", async ({ request }) => {
    const og = one("og:image");
    expect(og, "og:image is an absolute https URL").toMatch(/^https:\/\//);
    expect(one("twitter:image")).toBe(og);
    const png = await asset(request, localPath(og), /^image\/png/);
    expect(one("og:image:type")).toBe("image/png");
    expect(pngSize(png, og)).toBe(`${one("og:image:width")}x${one("og:image:height")}`);
    expect(png.length, "share image is small enough for link-preview scrapers").toBeLessThan(1_000_000);
  });

  test("manifest, icons and font preloads resolve", async ({ request }) => {
    const manifestLinks = head.links.filter((l) => l.rel === "manifest");
    expect(manifestLinks).toHaveLength(1);
    const manifest = JSON.parse((await asset(request, manifestLinks[0]!.href, /^application\/(manifest\+)?json/)).toString()) as Manifest;
    expect(manifest.name).toContain("Infinite Alchemy");
    expect(manifest.short_name?.length).toBeGreaterThan(0);
    expect(manifest.start_url).toBe("/");
    expect(manifest.display).toBe("standalone");
    expect(manifest.theme_color).toMatch(/^#[0-9a-f]{6}$/i);
    expect(manifest.background_color).toMatch(/^#[0-9a-f]{6}$/i);
    const icons = manifest.icons ?? [];
    // Installability needs 192 and 512; Android's adaptive icon needs a maskable one.
    expect(icons.map((i) => i.sizes)).toEqual(expect.arrayContaining(["192x192", "512x512"]));
    expect(icons.some((i) => i.purpose?.split(" ").includes("maskable")), "a maskable icon").toBe(true);
    for (const icon of icons) {
      const png = await asset(request, icon.src, new RegExp(`^${icon.type ?? "image/png"}`));
      expect(pngSize(png, icon.src), `${icon.src} matches its declared size`).toBe(icon.sizes);
    }

    const headIcons = head.links.filter((l) => l.rel === "icon" || l.rel === "apple-touch-icon");
    expect(headIcons.map((l) => l.rel)).toEqual(expect.arrayContaining(["icon", "apple-touch-icon"]));
    for (const link of headIcons) {
      const body = await asset(request, link.href, /^image\//);
      if (link.href.endsWith(".ico")) {
        expect(icoSizes(body, link.href).sort()).toEqual((link.sizes ?? "").split(" ").sort());
      } else if (link.sizes) {
        expect(pngSize(body, link.href), `${link.href} matches its declared size`).toBe(link.sizes);
      } else {
        const [w, h] = pngSize(body, link.href).split("x").map(Number);
        expect(w, `${link.href} is square`).toBe(h);
        expect(w, `${link.href} is at least 180px`).toBeGreaterThanOrEqual(180);
      }
    }

    for (const font of head.links.filter((l) => l.rel === "preload" && l.as === "font")) {
      await asset(request, font.href, new RegExp(`^${font.type ?? "font/"}`));
    }
  });

  test("robots.txt, llms.txt, sitemap and the agent catalog", async ({ request }) => {
    const robots = (await asset(request, "/robots.txt", /^text\/plain/)).toString();
    expect(robots).toMatch(/^User-agent: \*$/m);
    expect(robots, "nothing blanket-disallowed").not.toMatch(/^Disallow:\s*\/\s*$/m);
    const sitemapUrl = robots.match(/^Sitemap:\s*(\S+)\s*$/m)?.[1];
    expect(sitemapUrl, "robots.txt names the sitemap").toBe(`${SITE}sitemap.xml`);

    const sitemap = (await asset(request, localPath(sitemapUrl!), /xml/)).toString();
    expect(sitemap).toContain(`<loc>${SITE}</loc>`);

    // llms.txt format: an H1 with the site name, then a blockquote summary.
    const llms = (await asset(request, "/llms.txt", /^text\/plain/)).toString();
    expect(llms).toMatch(/^# Infinite Alchemy\s*$/m);
    expect(llms.split("\n")[0]).toMatch(/^# /);
    expect(llms).toMatch(/^> \S/m);
    expect(llms).toContain(SITE);

    const catalog = JSON.parse((await asset(request, "/.well-known/ai-catalog.json", /^application\/json/)).toString()) as {
      entries: { url: string }[];
    };
    for (const entry of catalog.entries) await asset(request, localPath(entry.url), /^text\//);
  });

  test("every sitemap page is indexable, session-free and has its own head", async ({ page, request }) => {
    const sitemap = (await asset(request, "/sitemap.xml", /xml/)).toString();
    const pages = [...sitemap.matchAll(/<loc>\s*(\S+?)\s*<\/loc>/g)].map((m) => m[1]!).filter((url) => url !== SITE);
    expect(pages.length, "the sitemap lists content pages besides the game").toBeGreaterThan(0);
    // Value = the page that already uses it, so a duplicate names both pages.
    const titles = new Map([[head.titles[0]!.trim(), SITE]]);
    const descriptions = new Map([[one("description"), SITE]]);
    for (const url of pages) {
      const label = `${url}: `;
      const { head: pageHead, setCookie } = await fetchHead(page, request, localPath(url));
      expect(setCookie, `${label}no session cookie`).toBeUndefined();
      expect(pageHead.lang, `${label}lang`).toBe("en");
      const { title, description } = expectSearchSnippet(pageHead, label);
      // A path with no page of its own falls back to the game's index.html, whose canonical is "/".
      expect(pageHead.links.filter((l) => l.rel === "canonical").map((l) => l.href), `${label}canonical`).toEqual([url]);
      expect(only(pageHead, "og:url", label)).toBe(url);
      expect(only(pageHead, "robots", label)).not.toMatch(/noindex/);
      expect.soft(titles.get(title), `${label}title is unique`).toBeUndefined();
      expect.soft(descriptions.get(description), `${label}description is unique`).toBeUndefined();
      titles.set(title, url);
      descriptions.set(description, url);

      await asset(request, localPath(only(pageHead, "og:image", label)), /^image\//);
      for (const link of pageHead.links) {
        if (link.rel === "stylesheet") await asset(request, link.href, /^text\/css/);
        else if (link.rel === "preload") await asset(request, link.href, new RegExp(`^${link.type ?? "font/"}`));
        else if (link.rel === "icon" || link.rel === "apple-touch-icon") await asset(request, link.href, /^image\//);
      }
    }
  });

  test("/daily names today's three targets", async ({ page, request, fx }) => {
    expect(fx.challenge.days, "the seeded challenge covers today (UTC)").toContain(utcDay());
    const { html } = await fetchHead(page, request, "/daily");
    const text = await page.evaluate((source) => new DOMParser().parseFromString(source, "text/html").body.textContent ?? "", html);
    for (const tier of ["easy", "hard", "expert"] as const) expect(text, `the ${tier} target`).toContain(fx.challenge[tier]);
  });

  test("2023 manifest and icon URLs redirect to the new files", async ({ request }) => {
    const legacy: Record<string, string> = {
      "/manifest.json": "/manifest.webmanifest",
      "/logo192.png": "/icon-192.png",
      "/logo512.png": "/icon-512.png",
      "/logo192_mask.png": "/maskable-512.png",
      "/logo512_mask.png": "/maskable-512.png",
    };
    for (const [from, to] of Object.entries(legacy)) {
      const res = await request.get(from, { maxRedirects: 0 });
      expect(res.status(), `${from} redirects permanently`).toBe(301);
      expect(new URL(res.headers()["location"]!, SITE).pathname, `${from} redirects to ${to}`).toBe(to);
      await asset(request, from, to.endsWith(".png") ? /^image\/png/ : /^application\/(manifest\+)?json/);
    }
  });
});
