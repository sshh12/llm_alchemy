import { describe, expect, it } from "vitest";
import { COUNTDOWN_MAX_MS, localWhen, rateLimitCopy } from "./limitCopy.ts";

// Dates are built in the test machine's local time zone, so the expectations hold in any zone.
const at = (d: number, h: number, m = 0) => new Date(2026, 10, d, h, m).getTime(); // Nov 2026
const plain = (s: string) => s.replace(/ /g, " "); // ICU puts a narrow no-break space before AM/PM

describe("localWhen", () => {
  it("names the time today, tomorrow, or the weekday after that", () => {
    expect(plain(localWhen(at(26, 16), at(26, 6, 15), "en-US"))).toBe("at 4:00 PM");
    expect(plain(localWhen(at(27, 4, 5), at(26, 22), "en-US"))).toBe("tomorrow at 4:05 AM");
    expect(plain(localWhen(at(28, 9), at(26, 22), "en-US"))).toBe("on Saturday at 9:00 AM");
  });

  it("follows the locale's clock", () => {
    expect(localWhen(at(26, 16), at(26, 6), "en-GB")).toBe("at 16:00");
  });
});

describe("rateLimitCopy", () => {
  const now = at(26, 6, 17);

  it("counts down short waits", () => {
    const c = rateLimitCopy(23_000, "combine.player", now);
    expect(c.text).toBe("Easy there, alchemist. Try again in");
    expect(c.until).toBe(now + 23_000);
    expect(c.spoken).toBe("Easy there, alchemist. Try again in 23 seconds.");
  });

  it("says known mixes still work for the AI limits", () => {
    const c = rateLimitCopy(30_000, "llm.player", now);
    expect(c.text).toContain("Mixes someone has made before still work");
    expect(c.until).toBe(now + 30_000);
  });

  it("names the local end time instead of counting down hours (the 35,000 s report)", () => {
    const c = rateLimitCopy(35_000_000, "llm.player.day", now, "en-US"); // 35,000 s
    expect(c.until).toBeUndefined();
    expect(plain(c.text)).toBe(
      `You've invented a lot! Brand-new mixes are back ${plain(localWhen(now + 35_000_000, now, "en-US"))}. Mixes someone has made before still work.`,
    );
    expect(c.text).not.toMatch(/\d{4,}s/);
    expect(c.spoken).toBe(c.text);
  });

  it("uses the generic copy for long non-AI limits and the platform rule", () => {
    expect(rateLimitCopy(40 * 60_000, "combine.player.hour", now, "en-US").text).toMatch(/^Easy there, alchemist\. You can mix again at /);
    expect(rateLimitCopy(undefined, "platform", now).until).toBe(now + 20_000);
  });

  it("switches at two minutes", () => {
    expect(rateLimitCopy(COUNTDOWN_MAX_MS, "llm.player.hour", now).until).toBeDefined();
    expect(rateLimitCopy(COUNTDOWN_MAX_MS + 1_000, "llm.player.hour", now).until).toBeUndefined();
  });
});
