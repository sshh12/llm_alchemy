import type pg from "pg";
import { describe, expect, it } from "vitest";
import { Fizzled, type ElementProposal } from "../ai/index.ts";
import { resolveElement } from "./combine.ts";

const proposal: ElementProposal = {
  name: "Rain Forest",
  key: "rain forest",
  foldKey: "rain forest",
  emoji: "🌳",
  description: "A wet, green forest.",
  notable: false,
  artHint: null,
};

const row = (over: Record<string, unknown> = {}) => ({
  id: "1083333177628557313",
  name: "Rain Forest",
  emoji: "🌳",
  description: "A wet, green forest.",
  notable: false,
  depth: null,
  steps: null,
  is_starter: false,
  status: "quarantined",
  image_status: "none",
  image_key: null,
  discovered_by: "77",
  ...over,
});

/** A fake client: each handler answers the first query whose SQL matches its pattern. */
function fakeClient(handlers: [RegExp, (params: unknown[]) => unknown[] | Error][]) {
  const seen: string[] = [];
  const client = {
    query: async (text: string, params: unknown[] = []) => {
      seen.push(text);
      const h = handlers.find(([re]) => re.test(text));
      if (!h) throw new Error(`unexpected query: ${text}`);
      const out = h[1](params);
      if (out instanceof Error) throw out;
      return { rows: out };
    },
  };
  return { client: client as unknown as pg.PoolClient, seen };
}

const byKey = /WHERE e\.name_key = \$1/;
const revive = /SET status = 'active', quarantine_reason = NULL/;
const lower = /SET depth = CASE/;

describe("resolveElement and purged names", () => {
  it("reactivates an element quarantined as 'orphaned' and lowers its depth/steps", async () => {
    const { client, seen } = fakeClient([
      [byKey, () => [row()]],
      [revive, (p) => (p[0] === "1083333177628557313" ? [row({ status: "active" })] : [])],
      [lower, () => [{ depth: 3, steps: 4 }]],
    ]);
    const out = await resolveElement(client, proposal, { depth: 3, steps: 4 }, "99");
    expect(out.inserted).toBe(false);
    expect(out.element).toMatchObject({ id: "1083333177628557313", status: "active", depth: 3, steps: 4, discovered_by: "77" });
    expect(seen.some((q) => revive.test(q) && /quarantine_reason = 'orphaned'/.test(q))).toBe(true);
  });

  it("fizzles for any other quarantined name (legacy filter, review purge)", async () => {
    const { client, seen } = fakeClient([
      [byKey, () => [row()]],
      [revive, () => []], // the UPDATE matches only reason 'orphaned'
    ]);
    await expect(resolveElement(client, proposal, { depth: 1, steps: 1 }, "99")).rejects.toBeInstanceOf(Fizzled);
    expect(seen.some((q) => lower.test(q) || /INSERT/.test(q))).toBe(false);
  });

  it("fizzles (instead of failing) before migration 0004 adds quarantine_reason", async () => {
    const { client } = fakeClient([
      [byKey, () => [row()]],
      [revive, () => Object.assign(new Error('column "quarantine_reason" does not exist'), { code: "42703" })],
    ]);
    await expect(resolveElement(client, proposal, { depth: 1, steps: 1 }, "99")).rejects.toBeInstanceOf(Fizzled);
  });

  it("uses an active element as before without touching quarantine columns", async () => {
    const { client, seen } = fakeClient([
      [byKey, () => [row({ status: "active", depth: 2, steps: 2 })]],
      [lower, () => []],
    ]);
    const out = await resolveElement(client, proposal, { depth: 3, steps: 4 }, "99");
    expect(out.element).toMatchObject({ status: "active", depth: 2, steps: 2 });
    expect(seen.some((q) => revive.test(q))).toBe(false);
  });
});
