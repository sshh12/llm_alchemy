import { describe, expect, it } from "vitest";
import { z } from "zod";
import { ApiError, checkCsrf, errorResponse, errors, ipNetwork, json, readJson } from "./http.ts";

const post = (headers: Record<string, string>, body = "{}") =>
  new Request("https://alchemy.sshh.io/api/combine", { method: "POST", headers, body });
const good = { "content-type": "application/json", "x-ia-client": "1" };

const codeOf = (fn: () => unknown) => {
  try {
    fn();
  } catch (e) {
    return e instanceof ApiError ? `${e.status}:${e.code}` : "other";
  }
  return "none";
};

describe("CSRF checks", () => {
  it("accepts same-origin app requests", () => {
    expect(codeOf(() => checkCsrf(post(good)))).toBe("none");
    expect(
      codeOf(() => checkCsrf(post({ ...good, origin: "https://alchemy.sshh.io", "sec-fetch-site": "same-origin" }))),
    ).toBe("none");
    expect(codeOf(() => checkCsrf(post({ ...good, "content-type": "application/json; charset=utf-8" })))).toBe("none");
  });

  it("rejects missing header, wrong type, foreign origin and cross-site fetches", () => {
    expect(codeOf(() => checkCsrf(post({ "content-type": "application/json" })))).toBe("403:forbidden");
    expect(codeOf(() => checkCsrf(post({ ...good, "content-type": "text/plain" })))).toBe("415:bad_request");
    expect(codeOf(() => checkCsrf(post({ ...good, "content-type": "application/jsonx" })))).toBe("415:bad_request");
    expect(codeOf(() => checkCsrf(post({ ...good, origin: "https://evil.example" })))).toBe("403:forbidden");
    expect(codeOf(() => checkCsrf(post({ ...good, origin: "null" })))).toBe("403:forbidden");
    expect(codeOf(() => checkCsrf(post({ ...good, "sec-fetch-site": "cross-site" })))).toBe("403:forbidden");
    expect(codeOf(() => checkCsrf(post({ ...good, "sec-fetch-site": "same-site" })))).toBe("403:forbidden");
    expect(codeOf(() => checkCsrf(new Request("https://alchemy.sshh.io/api/combine")))).toBe("405:bad_request");
  });
});

describe("readJson", () => {
  const schema = z.object({ a: z.number() });

  it("parses and validates", async () => {
    await expect(readJson(post(good, '{"a":1}'), schema, 100)).resolves.toEqual({ a: 1 });
    await expect(readJson(post(good, '{"a":"x"}'), schema, 100)).rejects.toMatchObject({ status: 400 });
    await expect(readJson(post(good, "not json"), schema, 100)).rejects.toMatchObject({ status: 400 });
  });

  it("enforces the byte cap even without Content-Length", async () => {
    const big = JSON.stringify({ a: 1, pad: "x".repeat(500) });
    await expect(readJson(post(good, big), schema, 100)).rejects.toMatchObject({ status: 413 });
    const stream = new ReadableStream({
      start(c) {
        c.enqueue(new TextEncoder().encode(big));
        c.close();
      },
    });
    const req = new Request("https://x.test/", { method: "POST", body: stream, duplex: "half" } as RequestInit);
    await expect(readJson(req, schema, 100)).rejects.toMatchObject({ status: 413 });
  });
});

describe("responses", () => {
  it("serializes ApiErrors with Retry-After", async () => {
    const res = errorResponse(errors.rateLimited(2_500));
    expect(res.status).toBe(429);
    expect(res.headers.get("retry-after")).toBe("3");
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(await res.json()).toEqual({ error: "rate_limited", message: expect.any(String), retryAfterMs: 2_500 });
  });

  it("streams very large bodies intact", async () => {
    const body = { rows: Array.from({ length: 60_000 }, (_, i) => ({ i, s: "x".repeat(60) })) };
    expect(await json(body).json()).toEqual(body);
  });
});

describe("ipNetwork", () => {
  it("groups IPv6 by /64 and passes IPv4 through", () => {
    expect(ipNetwork("203.0.113.9")).toBe("203.0.113.9");
    expect(ipNetwork("::ffff:203.0.113.9")).toBe("203.0.113.9");
    expect(ipNetwork("2001:db8:85a3:12:8a2e:370:7334:1")).toBe("2001:db8:85a3:12::/64");
    expect(ipNetwork("2001:0db8:85a3:0012:ffff::1")).toBe("2001:db8:85a3:12::/64");
    expect(ipNetwork("2001:db8::1")).toBe("2001:db8:0:0::/64");
    expect(ipNetwork("[2001:db8::1]")).toBe("2001:db8:0:0::/64");
    expect(ipNetwork("::1")).toBe("0:0:0:0::/64");
  });
});
