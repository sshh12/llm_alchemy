// Live smoke test for the custom-sort scorer (server/ai/jev.ts) against the real TypeSafe Jev
// API: one rank sort and one groups sort over ~250 element names, plus a one-element call shaped
// like the /api/combine piggyback. No DB: names are passed in directly with fake ids. Each run
// costs well under $0.01 ($0.042 per 1M input tokens).
//
//   npx tsx scripts/jev-smoke.ts
//
// Deliberately not a *.test.ts (vitest would then call the real API on every `npm test`). Reads
// TYPESAFE_API_KEY from .env; prints timings, token usage and the top/bottom of each order, never
// the key.
import "./lib/env.ts";
import { SORT_FIT_THRESHOLD, type SortScore, type SortSpec } from "../src/shared/api.ts";
import { jevScore, type ScoreItem, type ScoreOpts } from "../server/ai/jev.ts";
import { isMain, printTable, runMain } from "./lib/cli.ts";

const NAMES = [
  "Earth", "Water", "Air", "Fire", "Time", "Steam", "Mud", "Energy", "Lava", "Brick", "Stone", "Cloud", "Geyser",
  "Storm", "Clay", "Plasma", "Metal", "Pottery", "Rain", "Lightning", "Sword", "House", "Robot", "Plant", "Tree",
  "Apple", "Isaac Newton", "Gravity", "Rocket", "Space Station", "Moon Base", "Colony", "Mars", "Galaxy", "Planet",
  "Life", "Ocean", "Fish", "Shark", "Whale", "Sand", "Glass", "Beach", "Island", "Volcano", "Mountain", "Snow", "Ice",
  "Penguin", "Igloo", "Dragon", "Wizard", "Castle", "Knight", "Princess", "Bread", "Cheese", "Pizza", "Cake", "Sugar",
  "Honey", "Bee", "Flower", "Garden", "Farmer", "Cow", "Milk", "Butter", "Egg", "Chicken", "Omelette", "Coffee", "Tea",
  "Wine", "Beer", "Kitchen", "Knife", "Spoon", "Oven", "Toaster", "Ghost", "Vampire", "Zombie", "Skeleton",
  "Graveyard", "Coffin", "Pumpkin", "Witch", "Bat", "Spider", "Web", "Internet", "Computer", "Phone", "Smartphone",
  "Electricity", "Light", "Light Bulb", "Sun", "Star", "Black Hole", "Supernova", "Comet", "Asteroid", "Dinosaur",
  "Fossil", "Oil", "Gasoline", "Car", "Train", "Airplane", "Bicycle", "Wheel", "Road", "City", "Skyscraper", "Pyramid",
  "Egypt", "Pharaoh", "Mummy", "Tornado", "Hurricane", "Desert", "Cactus", "Camel", "Oasis", "Swamp", "Frog",
  "Alligator", "Jungle", "Monkey", "Banana", "Tiger", "Lion", "Kitten", "Puppy", "Unicorn", "Rainbow", "Mona Lisa",
  "Leonardo da Vinci", "Albert Einstein", "Atom", "Bomb", "Nuclear Power", "Pokemon", "Pikachu", "Harry Potter",
  "Hogwarts", "Darth Vader", "Lightsaber", "Mickey Mouse", "Disneyland", "Hamburger", "French Fries", "Salt", "Pepper",
  "Soup", "Sushi", "Rice", "Wheat", "Flour", "Dough", "Pasta", "Spaghetti", "Meatball", "Moss", "Mushroom", "Mold",
  "Bacteria", "Virus", "Plague", "Doctor", "Hospital", "Medicine", "Pill", "Love", "Heart", "Kiss", "Wedding", "Ring",
  "Gold", "Diamond", "Treasure", "Pirate", "Ship", "Anchor", "Mermaid", "Atlantis", "Poseidon", "Zeus", "Thor",
  "Hammer", "Nail", "Wood", "Paper", "Book", "Library", "Teacher", "School", "Pencil", "Ink", "Octopus", "Squid",
  "Kraken", "Lighthouse", "Clock", "Hourglass", "Calendar", "Birthday", "Party", "Balloon", "Helium", "Bubble", "Soap",
  "Towel", "Blanket", "Pillow", "Dream", "Nightmare", "Sleep", "Bed", "Moonlight", "Wolf", "Werewolf", "Silver",
  "Mirror", "Selfie", "Camera", "Movie", "Hollywood", "Actor", "Music", "Guitar", "Piano", "Drum", "Rock",
  "Rock and Roll", "Elvis Presley", "Smoke", "Ash", "Phoenix", "Ember", "Charcoal", "Glacier", "Iceberg", "Titanic",
  "Submarine", "Snowman",
];

/** Fake INT8-shaped ids (19 digits, like production snowflake ids), stable per position. */
const ITEMS: ScoreItem[] = NAMES.map((name, i) => ({ id: String(1_083_333_177_628_557_313n + BigInt(i) * 7919n), name }));
const nameOf = new Map(ITEMS.map((it) => [it.id, it.name]));
const FULL: ScoreOpts = { deadlineMs: 20_000, retries: 1, split: true };
const PIGGYBACK: ScoreOpts = { deadlineMs: 800, retries: 0, split: false };

async function run(label: string, spec: SortSpec, items: ScoreItem[], opts: ScoreOpts) {
  const t0 = performance.now();
  const out = await jevScore(spec, items, opts);
  const ms = Math.round(performance.now() - t0);
  console.log(
    `\n${label}: ${items.length} elements, ${out.scored.size} scored, ${out.retry.length} retry, ${ms} ms, ` +
      `${out.tokens} input tokens (${(out.tokens / items.length).toFixed(0)}/element, $${((out.tokens * 0.042) / 1e6).toFixed(5)}), engine ${out.engine}`,
  );
  return out;
}

const ranked = (scored: Map<string, SortScore>) =>
  [...scored].sort((a, b) => b[1].s - a[1].s || nameOf.get(a[0])!.localeCompare(nameOf.get(b[0])!));
const label = ([id, sc]: [string, SortScore]) => `${nameOf.get(id)} ${sc.s}${sc.n != null ? `/${sc.n}` : ""}`;

async function main() {
  if (!process.env.TYPESAFE_API_KEY) throw new Error("TYPESAFE_API_KEY is not set (expected in .env)");

  const rank: SortSpec = { kind: "rank", prompt: "spookiest" };
  const r = await run(`rank "${rank.prompt}"`, rank, ITEMS, FULL);
  const order = ranked(r.scored);
  printTable(
    Array.from({ length: 8 }, (_, i) => ({ "#": i + 1, top: label(order[i]!), bottom: label(order[order.length - 8 + i]!) })),
  );
  console.log(`distinct scores: ${new Set(order.map(([, sc]) => sc.s)).size}`);

  const groups: SortSpec = { kind: "groups", groups: ["Animals", "Food & drink", "Weather"] };
  const g = await run(`groups ${groups.groups.join(" / ")}`, groups, ITEMS, FULL);
  const all = ranked(g.scored);
  const fits = (j: number) => all.filter(([, sc]) => sc.g === j && sc.n! >= SORT_FIT_THRESHOLD);
  const other = all.filter(([, sc]) => sc.n! < SORT_FIT_THRESHOLD);
  console.log(
    groups.groups.map((name, j) => `${name} ${fits(j).length}`).join(" · ") + ` · Other ${other.length} (fit < ${SORT_FIT_THRESHOLD})`,
  );
  printTable(
    Array.from({ length: 8 }, (_, i) => ({
      "#": i + 1,
      ...Object.fromEntries(groups.groups.map((name, j) => [`top ${name}`, fits(j)[i] ? label(fits(j)[i]!) : ""])),
    })),
  );
  const leastFit = [...g.scored].sort((a, b) => a[1].n! - b[1].n!).slice(0, 8);
  const mostFit = [...g.scored].sort((a, b) => b[1].n! - a[1].n!).slice(0, 8);
  printTable(
    Array.from({ length: 8 }, (_, i) => ({
      "#": i + 1,
      "best fit (s/n)": `${label(mostFit[i]!)} → ${groups.groups[mostFit[i]![1].g!]}`,
      "worst fit (s/n)": `${label(leastFit[i]!)} → closest ${groups.groups[leastFit[i]![1].g!]}`,
    })),
  );

  // The /api/combine piggyback: one element, 800 ms deadline, no retry.
  const one = ITEMS.filter((it) => it.name === "Werewolf");
  const p = await run("piggyback (1 element, 800 ms cap)", rank, one, PIGGYBACK);
  console.log(`Werewolf for "${rank.prompt}": ${p.scored.get(one[0]!.id)?.s ?? "not scored"}`);

  const tokens = r.tokens + g.tokens + p.tokens;
  console.log(`\ntotal: ${tokens} input tokens ≈ $${((tokens * 0.042) / 1e6).toFixed(5)}`);
}

if (isMain(import.meta.url)) runMain(main);
