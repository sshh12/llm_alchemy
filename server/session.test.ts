import { beforeAll, describe, expect, it } from "vitest";
import {
  SESSION_MAX_AGE_S,
  decodeSession,
  decodeTransferCode,
  encodeSession,
  encodeTransferCode,
  readCookie,
  sessionCookie,
} from "./session.ts";

beforeAll(() => {
  process.env.SESSION_SECRET = "test-secret-".padEnd(48, "x");
});

const ID = "1083333177628557313";

describe("session cookie", () => {
  it("round-trips claims", () => {
    const now = 1_790_000_000_000;
    expect(decodeSession(encodeSession(ID, 3, now), now)).toEqual({ p: ID, v: 3, t: now });
  });

  it("rejects tampered payloads and signatures", () => {
    const value = encodeSession(ID, 1);
    const [payload, sig] = value.split(".") as [string, string];
    const forged = Buffer.from(JSON.stringify({ p: "1", v: 1, t: Date.now() })).toString("base64url");
    expect(decodeSession(`${forged}.${sig}`)).toBeNull();
    expect(decodeSession(`${payload}.${sig.slice(0, -2)}AA`)).toBeNull();
    expect(decodeSession(payload)).toBeNull();
    expect(decodeSession("")).toBeNull();
  });

  it("rejects cookies signed with another secret", () => {
    const value = encodeSession(ID, 1);
    process.env.SESSION_SECRET = "other-secret-".padEnd(48, "y");
    try {
      expect(decodeSession(value)).toBeNull();
    } finally {
      process.env.SESSION_SECRET = "test-secret-".padEnd(48, "x");
    }
  });

  it("rejects expired and future-dated sessions", () => {
    const now = 1_790_000_000_000;
    expect(decodeSession(encodeSession(ID, 1, now - SESSION_MAX_AGE_S * 1000 - 1), now)).toBeNull();
    expect(decodeSession(encodeSession(ID, 1, now + 3_600_000), now)).toBeNull();
  });

  it("is not interchangeable with a transfer code", () => {
    const code = encodeTransferCode(ID, 1);
    expect(decodeSession(code)).toBeNull();
    expect(decodeTransferCode(encodeSession(ID, 1))).toBeNull();
  });

  it("sets the spec'd cookie attributes", () => {
    const secure = sessionCookie(new Request("https://alchemy.sshh.io/api/bootstrap"), "abc.def");
    expect(secure).toBe(`ia_session=abc.def; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=34560000`);
    const local = sessionCookie(new Request("http://localhost:8888/api/bootstrap"), "abc.def");
    expect(local).not.toContain("Secure");
    expect(local).toContain("HttpOnly");
  });

  it("parses the cookie header", () => {
    const req = new Request("https://x.test/", { headers: { cookie: "a=1; ia_session=v.s; b=2" } });
    expect(readCookie(req, "ia_session")).toBe("v.s");
    expect(readCookie(req, "missing")).toBeNull();
  });
});

describe("transfer codes", () => {
  it("round-trip and reject tampering", () => {
    const code = encodeTransferCode(ID, 7);
    expect(code.length).toBeLessThan(50);
    expect(decodeTransferCode(code)).toEqual({ p: ID, v: 7 });
    expect(decodeTransferCode(` ${code} `)).toEqual({ p: ID, v: 7 });
    expect(decodeTransferCode(code.replace(".7.", ".8."))).toBeNull();
    expect(decodeTransferCode(code.replace(ID, "1083333177628557314"))).toBeNull();
    expect(decodeTransferCode("garbage")).toBeNull();
  });
});
