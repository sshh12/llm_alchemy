// Transfer deep links (`/#transfer=<code>`): parsing, link building, and the startup capture
// that strips the code from the URL.
import { afterEach, describe, expect, it, vi } from "vitest";
import { captureTransferLink, capturedTransferLink, parseTransferHash, transferCodePlayer, transferUrl } from "./transferLink.ts";

const CODE = "1084569372401893377.3.Vh3_kQ-9xZpL2mN8aB4cDe";

describe("parseTransferHash", () => {
  it("reads a well-formed code", () => {
    expect(parseTransferHash(`#transfer=${CODE}`)).toEqual({ code: CODE, valid: true });
  });
  it("decodes a percent-encoded code (and trims it)", () => {
    expect(parseTransferHash(`#transfer=${encodeURIComponent(` ${CODE}`)}`)).toEqual({ code: CODE, valid: true });
    expect(parseTransferHash("#transfer=1084569372401893377%2E3%2EVh3_kQ-9xZpL2mN8aB4cDe")).toEqual({ code: CODE, valid: true });
  });
  it("flags an empty code as an unusable transfer link", () => {
    expect(parseTransferHash("#transfer=")).toEqual({ code: "", valid: false });
    expect(parseTransferHash("#transfer=%20%20")).toEqual({ code: "", valid: false });
  });
  it("flags garbage as an unusable transfer link", () => {
    expect(parseTransferHash("#transfer=garbage")).toEqual({ code: "garbage", valid: false });
    expect(parseTransferHash("#transfer=%E0%A4%A")).toEqual({ code: "", valid: false }); // malformed escape
    expect(parseTransferHash(`#transfer=${CODE}x`)?.valid).toBe(false); // 23-char signature
    expect(parseTransferHash(`#transfer=0${CODE}`)?.valid).toBe(false); // leading zero id
    expect(parseTransferHash(`#transfer=${CODE.replace(".3.", "..")}`)?.valid).toBe(false);
    expect(parseTransferHash(`#transfer=${CODE}&utm=1`)?.valid).toBe(false);
  });
  it("leaves every other hash alone", () => {
    for (const h of ["", "#", "#about", "#transfer", "#Transfer=abc", "#xtransfer=abc", "transfer=abc", `#/transfer=${CODE}`]) {
      expect(parseTransferHash(h), h).toBeNull();
    }
  });
});

describe("transferUrl", () => {
  it("builds a fragment link that parses back to the same code", () => {
    const url = transferUrl("https://alchemy.sshh.io", CODE);
    expect(url).toBe(`https://alchemy.sshh.io/#transfer=${CODE}`);
    expect(parseTransferHash(new URL(url).hash)).toEqual({ code: CODE, valid: true });
  });
  it("encodes the code", () => {
    expect(transferUrl("http://localhost:8940", "a b#c")).toBe("http://localhost:8940/#transfer=a%20b%23c");
  });
});

describe("transferCodePlayer", () => {
  it("is the code's player id segment", () => {
    expect(transferCodePlayer(CODE)).toBe("1084569372401893377");
    expect(transferCodePlayer("")).toBe("");
  });
});

describe("captureTransferLink", () => {
  afterEach(() => vi.unstubAllGlobals());

  function stubBrowser(href: string) {
    const url = new URL(href);
    const replaceState = vi.fn((_state: unknown, _unused: string, next: string) => {
      const u = new URL(next, url);
      url.hash = u.hash;
      url.pathname = u.pathname;
      url.search = u.search;
    });
    vi.stubGlobal("location", {
      get hash() {
        return url.hash;
      },
      get pathname() {
        return url.pathname;
      },
      get search() {
        return url.search;
      },
    });
    vi.stubGlobal("history", { state: { keep: 1 }, replaceState });
    return { url, replaceState };
  }

  it("strips a transfer link from the URL (keeping path, query and history state) and remembers it", () => {
    const { url, replaceState } = stubBrowser(`https://alchemy.sshh.io/?fake=rich#transfer=${CODE}`);
    captureTransferLink();
    expect(replaceState).toHaveBeenCalledWith({ keep: 1 }, "", "/?fake=rich");
    expect(url.href).toBe("https://alchemy.sshh.io/?fake=rich");
    expect(capturedTransferLink()).toEqual({ code: CODE, valid: true });
  });
  it("strips an unusable transfer link too", () => {
    const { url } = stubBrowser("https://alchemy.sshh.io/#transfer=garbage");
    captureTransferLink();
    expect(url.href).toBe("https://alchemy.sshh.io/");
    expect(capturedTransferLink()).toEqual({ code: "garbage", valid: false });
  });
  it("does not touch other hashes", () => {
    const { replaceState } = stubBrowser("https://alchemy.sshh.io/#about");
    captureTransferLink();
    expect(replaceState).not.toHaveBeenCalled();
  });
});
