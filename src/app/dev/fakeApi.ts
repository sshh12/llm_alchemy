// DEV ONLY: an in-browser stand-in for the backend so the UI can be iterated on with
// `npx vite` before/without `netlify dev`. Enabled by `?fake` in development builds only
// (main.tsx guards the import with import.meta.env.DEV, so it is stripped from production).
//
//   ?fake          brand-new player (onboarding, starters only)
//   ?fake=rich     seeded mid-game player (library, firsts, pins, history, streak)
//   ?fake=huge     ~4,000 elements (virtualization / perf)
//   ?fake=pow      bootstrap demands proof-of-work first (exercises the worker)
//   ?fake=slow     combines take ~2.5 s (pending crucible state)
//   ?fake=errors   some combines fail (rate_limited / fizzled / budget_exhausted)
//
// Art: elements whose name has a sample image return img "/dev-art/<slug>.webp"; the
// Playwright screenshot script serves those paths (plain vite dev just shows placeholders).
import type {
  ApiError,
  BootstrapRequest,
  BootstrapResponse,
  ChallengeHistoryDay,
  CombineRequest,
  CombineResponse,
  ElementDTO,
  ImageResponse,
  LibraryEntry,
  PlayerAction,
  PlayerResponse,
  Tier,
} from "../../shared/api.ts";
import { addDays, localDay } from "../../shared/dates.ts";
import { rarityForDepth } from "../../shared/rarity.ts";
import { setTransport } from "../lib/api.ts";
import { recipeKey } from "../lib/ids.ts";

const mode = new URLSearchParams(location.search).get("fake") ?? "";

interface FakeEl {
  id: string;
  name: string;
  emoji: string;
  depth: number;
  notable?: boolean;
  starter?: boolean;
  art: "ready" | "missing" | "blocked";
  description?: string;
}

const ART = new Set(["steam", "fire", "mud", "dragon", "lightning", "apple", "wifi", "time-traveling-submarine", "bomb"]);
const slug = (name: string) => name.toLowerCase().replace(/[^a-z0-9]+/g, "-");

const STARTERS: [string, string][] = [
  ["Earth", "🌍"],
  ["Water", "💧"],
  ["Air", "💨"],
  ["Fire", "🔥"],
  ["Time", "⏳"],
];

/** [ingredients, result, emoji, notable?] */
const RECIPES: [string[], string, string, boolean?][] = [
  [["Water", "Fire"], "Steam", "♨️"],
  [["Earth", "Water"], "Mud", "🟫"],
  [["Air", "Fire"], "Energy", "⚡"],
  [["Earth", "Fire"], "Lava", "🌋"],
  [["Air", "Water"], "Mist", "🌫️"],
  [["Air", "Earth"], "Dust", "🏜️"],
  [["Time", "Earth"], "Fossil", "🦴"],
  [["Time", "Fire"], "Ash", "🌑"],
  [["Time", "Air"], "Wind", "🍃"],
  [["Water", "Water"], "Ocean", "🌊"],
  [["Earth", "Earth"], "Mountain", "⛰️"],
  [["Time", "Time"], "Eternity", "♾️"],
  [["Steam", "Earth"], "Geyser", "⛲"],
  [["Lava", "Water"], "Stone", "🪨"],
  [["Mud", "Fire"], "Brick", "🧱"],
  [["Energy", "Water"], "Lightning", "🌩️"],
  [["Stone", "Fire"], "Metal", "⚙️"],
  [["Metal", "Energy"], "Robot", "🤖"],
  [["Steam", "Metal"], "Steam Locomotive", "🚂"],
  [["Fossil", "Energy"], "Dragon", "🐉"],
  [["Earth", "Water", "Air"], "Plant", "🌱"],
  [["Plant", "Time"], "Tree", "🌳"],
  [["Tree", "Time"], "Apple", "🍎"],
  [["Apple", "Time"], "Isaac Newton", "🧑‍🔬", true],
  [["Robot", "Time"], "Time-Traveling Submarine", "🛸"],
  [["Lightning", "Metal"], "Wi-Fi", "📶"],
];

const INVENTED: [string, string, boolean?][] = [
  ["Glass", "🪟"],
  ["Cloud", "☁️"],
  ["Sand", "⏳"],
  ["Volcano", "🌋"],
  ["Rainbow", "🌈"],
  ["Clay", "🏺"],
  ["Obsidian", "🖤"],
  ["Golem", "🗿"],
  ["Phoenix", "🐦‍🔥"],
  ["Oasis", "🏝️"],
  ["Comet", "☄️"],
  ["Nebula", "🌌"],
  ["Lighthouse", "🗼"],
  ["Philosopher's Stone", "💎"],
  ["Thunderbird", "🦅"],
  ["Snow Globe", "🔮"],
  ["Quicksilver", "🪩"],
  ["Ancient Ruins", "🏛️"],
  ["Mount Everest", "🏔️", true],
  ["Leonardo da Vinci", "🎨", true],
  ["Cleopatra", "👑", true],
  ["Aurora Borealis", "🌠"],
  ["Hourglass", "⌛"],
  ["Kintsugi Teapot", "🫖"],
];

const PARAGRAPH: Record<string, string> = {
  Steam: "Water that got too excited and floated away.",
  Dragon: "An ancient, fire-breathing reptile of legend.",
  "Isaac Newton": "English physicist who described gravity, allegedly after an apple fell on him.",
};

let nextId = 1_000_000_000_000_000_001n;
const els = new Map<string, FakeEl>();
const byName = new Map<string, FakeEl>();
const recipes = new Map<string, string>();
const owned = new Map<string, { at: string; first: boolean }>();
const imageCalls = new Map<string, number>();

function mk(name: string, emoji: string, depth: number, extra: Partial<FakeEl> = {}): FakeEl {
  const existing = byName.get(name);
  if (existing) return existing;
  const el: FakeEl = { id: String(nextId++), name, emoji, depth, art: "missing", ...extra };
  els.set(el.id, el);
  byName.set(name, el);
  return el;
}

for (const [n, e] of STARTERS) mk(n, e, 0, { starter: true, art: n === "Fire" ? "ready" : "missing" });
for (const [ings, result, emoji, notable] of RECIPES) {
  const ingEls = ings.map((n) => byName.get(n)!);
  const depth = Math.max(...ingEls.map((e) => e.depth)) + 1;
  const r = mk(result, emoji, depth * 2 + (result === "Dragon" ? 8 : 0), { notable, description: PARAGRAPH[result] });
  recipes.set(recipeKey(ingEls.map((e) => e.id)), r.id);
}

function dto(el: FakeEl): ElementDTO {
  const img = el.art === "ready" ? `/dev-art/${slug(el.name)}.webp` : null;
  return {
    id: el.id,
    name: el.name,
    emoji: el.emoji,
    img,
    art: el.art,
    description: el.description ?? null,
    notable: !!el.notable,
    depth: el.depth,
    rarity: rarityForDepth(el.depth),
    starter: !!el.starter,
  };
}

function entry(el: FakeEl): LibraryEntry {
  const o = owned.get(el.id)!;
  return { ...dto(el), discoveredAt: o.at, first: o.first };
}

const ago = (h: number) => new Date(Date.now() - h * 3_600_000).toISOString();

function seedOwned(): void {
  for (const [n] of STARTERS) owned.set(byName.get(n)!.id, { at: ago(24 * 30), first: false });
  if (mode === "rich" || mode === "huge") {
    const names = ["Steam", "Mud", "Energy", "Lava", "Mist", "Dust", "Fossil", "Ocean", "Mountain", "Stone", "Brick", "Lightning", "Metal", "Plant", "Tree", "Apple", "Isaac Newton", "Dragon", "Steam Locomotive", "Geyser"];
    names.forEach((n, i) => {
      const el = byName.get(n)!;
      owned.set(el.id, { at: ago(i < 4 ? i * 2 + 1 : 30 + i * 10), first: n === "Dragon" || n === "Steam Locomotive" });
    });
    byName.get("Steam")!.art = "ready";
    byName.get("Mud")!.art = "ready";
    for (const [n, e, notable] of INVENTED.slice(0, 14)) {
      const el = mk(n, e, 3 + (n.length % 9), { notable });
      owned.set(el.id, { at: ago(60 + n.length * 7), first: n === "Philosopher's Stone" || n === "Kintsugi Teapot" });
    }
  }
  if (mode === "huge") {
    const words = ["Ember", "Crystal", "Shadow", "Golden", "Frost", "Storm", "Iron", "Velvet", "Ancient", "Cosmic", "Tiny", "Electric", "Hollow", "Silver", "Wild"];
    const nouns = ["Fox", "Tower", "River", "Lantern", "Garden", "Engine", "Crown", "Bell", "Forge", "Comet", "Harbor", "Bridge", "Owl", "Kettle", "Mirror"];
    const emojis = ["🦊", "🗼", "🏞️", "🏮", "🌷", "🚂", "👑", "🔔", "⚒️", "☄️", "⚓", "🌉", "🦉", "🫖", "🪞"];
    let n = 0;
    for (let i = 0; i < words.length && n < 4000; i++) {
      for (let j = 0; j < nouns.length && n < 4000; j++) {
        for (let k = 0; k < 18 && n < 4000; k++, n++) {
          const name = k === 0 ? `${words[i]} ${nouns[j]}` : `${words[i]} ${nouns[j]} ${k + 1}`;
          const el = mk(name, emojis[j]!, (i + j + k) % 16);
          owned.set(el.id, { at: ago(n), first: n % 97 === 0 });
        }
      }
    }
  }
}
seedOwned();

const today = localDay();
const challengeTargets: Record<Tier, string> = { easy: "Steam", hard: "Stone", expert: "Robot" };
const steps: Record<Tier, number> = { easy: 1, hard: 2, expert: 5 };
const completed = new Set<Tier>(mode === "rich" ? ["easy"] : []);

function history(): ChallengeHistoryDay[] {
  const names = { easy: "Steam", hard: "Stone", expert: "Robot" };
  const out: ChallengeHistoryDay[] = [];
  if (completed.size) out.push({ day: today, completed: [...completed], names });
  if (mode === "rich" || mode === "huge") {
    const past: [number, Tier[], Record<Tier, string>][] = [
      [1, ["easy", "hard"], { easy: "Rain", hard: "Pottery", expert: "Spaceship" }],
      [2, ["easy"], { easy: "Sand", hard: "Glass", expert: "Telescope" }],
      [3, ["easy", "hard", "expert"], { easy: "Cloud", hard: "Storm", expert: "Wind Turbine" }],
      [9, ["easy"], { easy: "Mud", hard: "Clay", expert: "Golem" }],
      [400, ["easy", "hard"], { easy: "Lava", hard: "Obsidian", expert: "Excalibur" }],
    ];
    for (const [d, c, n] of past) out.push({ day: addDays(today, -d), completed: c, names: n });
  }
  return out;
}

const json = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json" } });
const fail = (error: ApiError["error"], status: number, extra: Partial<ApiError> = {}) => json({ error, message: error, ...extra } satisfies ApiError, status);
const sleep = (ms: number, signal?: AbortSignal | null) =>
  new Promise<void>((resolve, reject) => {
    const t = setTimeout(resolve, ms);
    signal?.addEventListener("abort", () => {
      clearTimeout(t);
      reject(new DOMException("aborted", "AbortError"));
    });
  });

let powDone = mode !== "pow";

function bootstrap(_req: BootstrapRequest): Response {
  if (!powDone) {
    powDone = true;
    return fail("pow_required", 401, { pow: { salt: `fake.${Date.now()}`, bits: 12 } });
  }
  const library = [...owned.keys()].map((id) => entry(els.get(id)!));
  const recentNames = ["Aurora Borealis", "Hourglass", "Cleopatra", "Kintsugi Teapot", "Steam Locomotive", "Comet", "Mount Everest", "Leonardo da Vinci"];
  const recent = recentNames.map((n) => dto(mk(n, INVENTED.find((x) => x[0] === n)?.[1] ?? "✨", 9, { notable: INVENTED.find((x) => x[0] === n)?.[2] })));
  const res: BootstrapResponse = {
    player: { id: "1000000000000009999", createdAt: ago(24 * 200), legacy: false },
    library,
    stats: {
      known: 54_376,
      mine: library.length,
      firsts: [...owned.values()].filter((o) => o.first).length,
      challengesCompleted: mode === "rich" || mode === "huge" ? 23 : completed.size,
      streak: mode === "rich" || mode === "huge" ? { current: 4, best: 9 } : { current: 0, best: 0 },
    },
    challenge: {
      day: today,
      targets: (["easy", "hard", "expert"] as Tier[]).map((tier) => ({
        tier,
        element: dto(byName.get(challengeTargets[tier])!),
        steps: steps[tier],
        completed: completed.has(tier),
      })),
    },
    history: history(),
    recent,
  };
  return json(res);
}

let combineCount = 0;

function combine(req: CombineRequest): Response {
  combineCount++;
  if (mode === "errors") {
    const roll = combineCount % 4;
    if (roll === 1) return fail("rate_limited", 429, { retryAfterMs: 12_000 });
    if (roll === 2) return fail("fizzled", 422);
    if (roll === 3) return fail("budget_exhausted", 503);
  }
  if (req.ids.some((id) => !owned.has(id))) return fail("not_owned", 403);
  const key = recipeKey(req.ids);
  let resultId = recipes.get(key);
  let recipeNew = false;
  let firstEver = false;
  if (!resultId) {
    recipeNew = true;
    let h = 0;
    for (const c of key) h = (h * 31 + c.charCodeAt(0)) >>> 0;
    // Invent a world-new element (deterministic per recipe), so it's a first discovery.
    let pick: [string, string, boolean?] = [`Mystery ${combineCount}`, "✨"];
    for (let i = 0; i < INVENTED.length; i++) {
      const c = INVENTED[(h + i) % INVENTED.length]!;
      if (!byName.has(c[0])) {
        pick = c;
        break;
      }
    }
    const [name, emoji, notable] = pick;
    const depth = Math.max(...req.ids.map((id) => els.get(id)!.depth)) + 1;
    const el = mk(name, emoji, depth, { notable });
    firstEver = true;
    recipes.set(key, el.id);
    resultId = el.id;
  }
  const el = els.get(resultId)!;
  const newForPlayer = !owned.has(resultId);
  if (newForPlayer) owned.set(resultId, { at: new Date().toISOString(), first: firstEver });
  const done: Tier[] = [];
  for (const tier of ["easy", "hard", "expert"] as Tier[]) {
    if (!completed.has(tier) && challengeTargets[tier] === el.name) {
      completed.add(tier);
      done.push(tier);
    }
  }
  const res: CombineResponse = {
    result: dto(el),
    newForPlayer,
    firstEver,
    recipeNew,
    completed: done,
    ...(newForPlayer ? { entry: entry(el) } : {}),
  };
  return json(res);
}

function image(id: string): Response {
  const el = els.get(id);
  if (!el) return fail("not_found", 404);
  if (!ART.has(slug(el.name))) return json({ state: "blocked" } satisfies ImageResponse);
  const n = (imageCalls.get(id) ?? 0) + 1;
  imageCalls.set(id, n);
  if (n < 2) return json({ state: "pending", retryAfterMs: 1_200 } satisfies ImageResponse);
  el.art = "ready";
  return json({ state: "ready", img: `/dev-art/${slug(el.name)}.webp` } satisfies ImageResponse);
}

function player(action: PlayerAction): Response {
  if (action.action === "reset") {
    for (const id of [...owned.keys()]) if (!els.get(id)?.starter) owned.delete(id);
    return json({ ok: true, action: "reset" } satisfies PlayerResponse);
  }
  if (action.action === "transfer-code") return json({ ok: true, action: "transfer-code", code: "IA1.eyJwIjoiOTk5OSIsInYiOjF9.Qm9vaw" } satisfies PlayerResponse);
  return action.code.startsWith("IA1.") ? json({ ok: true, action: "redeem" } satisfies PlayerResponse) : fail("bad_request", 400);
}

export function installFakeApi(): void {
  console.info(`[fake api] enabled (mode: ${mode || "new player"})`);
  // Request log for scripted checks (e.g. "did a 3-ingredient combine go out?").
  const calls: { path: string; body: unknown }[] = [];
  (window as Window & { __fakeCalls?: typeof calls }).__fakeCalls = calls;
  setTransport(async (path, init) => {
    const body = JSON.parse(String(init.body ?? "{}")) as unknown;
    calls.push({ path, body });
    const latency = path === "/api/combine" ? (mode === "slow" ? 2_500 : 350) : path === "/api/image" ? 500 : 250;
    await sleep(latency, init.signal);
    switch (path) {
      case "/api/bootstrap":
        return bootstrap(body as BootstrapRequest);
      case "/api/combine":
        return combine(body as CombineRequest);
      case "/api/image":
        return image((body as { id: string }).id);
      case "/api/player":
        return player(body as PlayerAction);
      default:
        return fail("not_found", 404);
    }
  });
}
