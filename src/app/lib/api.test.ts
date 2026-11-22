import { afterEach, describe, expect, it } from "vitest";
import { ApiFailure, combine, setTransport } from "./api.ts";

const failWith = async (res: Response): Promise<ApiFailure> => {
  setTransport(async () => res);
  return combine({ ids: ["1", "2"], clientDate: "2026-11-23" }).then(
    () => {
      throw new Error("expected a failure");
    },
    (e: unknown) => e as ApiFailure,
  );
};

afterEach(() => setTransport((path, init) => fetch(path, init)));

describe("API failures", () => {
  it("carries the rule an app rate limit names", async () => {
    const body = { error: "rate_limited", message: "Easy there.", retryAfterMs: 30_000, limit: "llm.player" };
    const f = await failWith(new Response(JSON.stringify(body), { status: 429, headers: { "content-type": "application/json" } }));
    expect(f).toBeInstanceOf(ApiFailure);
    expect(f).toMatchObject({ code: "rate_limited", status: 429, retryAfterMs: 30_000, limit: "llm.player" });
  });

  it("tags a 429 without a JSON body as the platform rule", async () => {
    const f = await failWith(new Response("Too Many Requests", { status: 429, headers: { "retry-after": "20" } }));
    expect(f).toMatchObject({ code: "rate_limited", retryAfterMs: 20_000, limit: "platform" });
  });

  it("leaves limit unset for other failures", async () => {
    const f = await failWith(new Response("oops", { status: 502 }));
    expect(f).toMatchObject({ code: "server_error" });
    expect(f.limit).toBeUndefined();
  });
});
