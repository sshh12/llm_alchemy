import { describe, expect, it } from "vitest";
import { shareUrl } from "./share.ts";

describe("shareUrl", () => {
  it("tags shared links so the visits they bring are attributable", () => {
    const u = new URL(shareUrl("celebration"));
    expect(u.origin + u.pathname).toBe("https://alchemy.sshh.io/");
    expect(Object.fromEntries(u.searchParams)).toEqual({ utm_source: "share", utm_medium: "social", utm_campaign: "share_celebration" });
  });
});
