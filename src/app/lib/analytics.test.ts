import { describe, expect, it } from "vitest";
import { safeParams } from "./analytics.ts";

describe("safeParams", () => {
  it("drops params GA4 reads as traffic source, page or identity", () => {
    const out = safeParams({
      kind: "rank",
      source: "example",
      medium: "x",
      campaign: "y",
      campaign_id: "z",
      page_location: "/",
      user_id: "u",
      ga_session_id: 1,
      google_x: 1,
      from: "example",
    });
    expect(out).toEqual({ kind: "rank", from: "example" });
  });

  it("keeps ordinary params, including ones that merely contain a reserved word", () => {
    const params = { surface: "details", outcome: "shared", resource: "a", sources: 2, first: true };
    expect(safeParams(params)).toEqual(params);
    expect(safeParams(undefined)).toBeUndefined();
  });
});
