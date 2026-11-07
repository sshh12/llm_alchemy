import { describe, expect, it } from "vitest";
import { ROBOTS, esc, renderPage, tile } from "./pages.ts";

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
});
