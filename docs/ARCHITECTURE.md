# Infinite Alchemy v2 — Architecture

Infinite Alchemy (est. May 2023) is an AI-powered element-combining game: drag two or
more elements together and an LLM decides what you made; an image model paints it.
v2 is a ground-up rewrite. This document is the source of truth for how it fits together.

## Stack

| Layer | Choice | Why |
|---|---|---|
| Frontend | Vite 8 + React 19 SPA, TypeScript, Tailwind CSS v4, `motion` (pinned), `@tanstack/react-virtual`, `radix-ui` (Dialog/Popover only), `zustand`, `qrcode.react` (transfer QR; lazy Settings chunk only) | The game is one interactive screen; a static SPA costs zero function invocations to serve. |
| Backend | Netlify Functions v2 (`netlify/functions/*.mts`, web-standard `Request`/`Response`, path routing, `config.rateLimit`) | Small per-endpoint bundles, fast cold starts, and native platform rate limiting (Next.js route handlers can't declare Netlify rate limits and run as one large function). |
| DB | Existing CockroachDB Cloud (Basic, us-east1) via `pg` + raw SQL | New tables live in SQL schema `alchemy` next to the untouched legacy `public."Alchemy*"` tables. |
| Image storage | Netlify Blobs store `element-art`, served by `/img/:id/:key.webp` with immutable CDN caching; resized through Netlify Image CDN | No native deps; one function call per image per CDN, then free. |
| LLM | OpenAI `gpt-6-luna`, Responses API, strict JSON schema, `reasoning.effort: "none"`, temperature 0, prompt in `server/ai/prompts.ts` | ~1.5 s, ~$0.0001 per new recipe. |
| Images | OpenAI `gpt-image-2.5-flare-2026-09-08`, 816×816, `quality: "low"`, transparent webp | ~$0.005 and ~8 s per image; generated lazily on first need. |
| Sort AI | TypeSafe Jev `jev-1.14.0` (System One `score`/`choice`/`noul` questions), raw `fetch` in `server/ai/jev.ts` | ~$0.004 per 1k-element rank sort (measured 92 input tokens per element for rank, ~153 for 3 groups, ~256 for 8 groups ≈ $0.011 per 1k; output is free); numbers only, never text. |

Hosting constraints that shape the design (Netlify legacy **Starter** plan): 125k function
calls/site/month, 100 function-hours/month, 100 GB bandwidth, **2 platform rate-limit rules**,
and the whole account pauses at 100% of a limit. So: static pages, one bootstrap call per
session, client-side recipe cache, CDN-cached images, and rate limits in front of the costly paths.

## Repository layout (ownership in parentheses)

```
db/migrations/*.sql          versioned idempotent SQL ({{schema}} placeholder)          (db)
scripts/                     migrate, backfill-legacy, repair-legacy, generate-challenges, enrich-elements, classify-recognizable, purge-elements, recompute-depth, seed-e2e (db); jev-smoke (manual live Jev check)
server/                      backend modules shared by functions                       (server)
  env.ts db.ts http.ts session.ts ratelimit.ts pow.ts blobs.ts
  ai/llm.ts ai/image.ts ai/jev.ts ai/mock.ts ai/prompts.ts
  game/*.ts                  bootstrap, combine, sort (+ sortSpec.ts zod schemas), legacy import, challenges, images, DTO mapping
netlify/functions/*.mts      thin HTTP handlers: bootstrap, combine, sort, image, img, player (server)
src/shared/                  contracts + pure logic used by both sides (api.ts, names.ts, rarity.ts, dates.ts, pow.ts, sortSpec.ts, mockSort.ts, hash.ts)
src/app/                     the React app                                             (frontend)
public/                      static assets, manifest, icons, llms.txt, robots.txt, service-worker.js kill switch (web-meta)
index.html                   head/meta/OG                                              (web-meta + frontend)
e2e/, playwright.config.ts   Playwright suites (mock AI, isolated DB schema)           (e2e)
```

## Data model

See `db/migrations/0001_init.sql`. Key rules:

- **Elements** are unique by `name_key` (see `src/shared/names.ts`). `name` is display text
  (title-cased for legacy rows; LLM casing for new rows, e.g. "Isaac Newton"). `fold_key`
  lets a new LLM answer like "time-travel" reuse an existing "time travel".
- `status = 'quarantined'` elements (legacy spam) are kept so every legacy id still maps,
  but they are never shown, never combinable, and never challenge targets.
  `quarantine_reason` says why: `legacy-filter` (backfill), `review` (purged junk) or
  `orphaned` (cut off by a purge; see "Element purge").
- **Recipes** are keyed by `ingredient_ids` = the ingredient multiset sorted ascending
  **numerically** (BigInt compare; duplicates kept). Once active, a recipe's result never
  changes — this guarantees daily challenges stay solvable. A recipe whose stored result is
  quarantined (and that is not `protected`) is "healed": the next combine re-rolls it with the
  LLM and updates the row.
- `depth` = generations from the starters (min over recipes of 1 + max ingredient depth);
  `steps` = min number of combinations (min over recipes of 1 + Σ steps of distinct
  ingredients). Both are only ever lowered; new recipes update them incrementally.
  Combine lowers only the result's row, so descendants drift high: run `npm run db:depth`
  (`scripts/recompute-depth.ts`, dry run unless `--run`; lowers only, never while `db:purge`
  apply/restore runs) periodically. Increases (after a purge) belong to `db:purge`.
  Rarity is derived from depth at read time (`src/shared/rarity.ts`).
- **Discoveries** = a player's library (`player_id, element_id`). Starters are inserted on
  player creation.
- **Challenges**: one row per day with easy/hard/expert targets. Days before
  `CHALLENGE_CUTOVER_DAY` (2026-11-06) are legacy history; days from the cutover for 5 years
  are produced by `scripts/generate-challenges.ts`.
- **Recognizable targets**: `elements.recognizable` (set by `npm run db:classify` with gpt-6-luna, run before `db:challenges`) marks real, widely known names; each generated tier draws only recognizable candidates ("Geyser", not "Temporaplasm"), falling back to all eligible ones, recognizable first, if fewer than 40 exist.
- **Counters** power rate limits, global daily budgets and PoW replay protection
  (single-statement UPSERT increments; row-level TTL cleans up).

All ids are INT8 and travel as decimal strings (they exceed JS safe integers).
`pg` type parsers: INT8 → string (default), DATE (1082) → string, TIMESTAMP (1114) → treat as UTC.

## Game rules

- Starters: Earth, Water, Air, Fire, Time.
- Combine 2–4 owned elements (duplicates allowed). Order never matters.
- Known recipe → result immediately. Unknown → LLM proposes `{name, emoji, description, notable}`;
  the server validates with `checkName` (retry once with feedback, then `fizzled`, nothing saved).
  The LLM must never return an ingredient unchanged.
- `ruleViolations` (`server/ai/common.ts`) also rejects the old model's naming ladders that the
  purge removed, each with retry feedback: counted/multiplied forms (Double/Quadruple Flag,
  Doublejar, Twin X, X Trio, Pair of X, N-fold), spelled-out sums (Sixty-Four), hype prefixes
  spaced or glued (Mega Mountain, Megageyser) and meme suffixes (Cakeception, Smogzilla), plus
  ingredients glued with a shared letter (Dreamachine). An allowlist keeps established terms
  (Double Rainbow, Twins, Supernova, Steampunk, Tornado); proper nouns skip all but the
  multiplier check. Prompt rule 8 asks for the same up front.
- The first player to create an element is its discoverer ("First discovery").
- Daily challenge: producing a target via any combine on that day completes the tier.
  Tiers from the legacy generator: easy = BFS tier 2, hard = tier 4, expert = tier 6
  (BFS over active 2-ingredient recipes from the starters).
- Reset progress: library back to starters; firsts and challenge history are kept.
- Free. No credits, no payments.

## API (contract: `src/shared/api.ts`)

| Endpoint | Function | Notes |
|---|---|---|
| `POST /api/bootstrap` | `bootstrap.mts` | Session + library + stats + today's challenge + history + recent. Creates the player (PoW-gated) or adopts a legacy player. One call per page load. |
| `POST /api/combine` | `combine.mts` | Platform rate rule #1. Ownership-checked. |
| `POST /api/image` | `image.mts` | Platform rate rule #2. Lazily generates art (sync, ≤ ~25 s) under a DB lease. |
| `GET /img/:id/:key.webp` | `img.mts` | Serves Blobs bytes with `Cache-Control: public, max-age=31536000, immutable` and `Netlify-CDN-Cache-Control: public, durable, max-age=31536000, immutable`. |
| `POST /api/player` | `player.mts` | `reset`, `transfer-code`, `redeem`. |
| `POST /api/sort` | `sort.mts` | No platform rule (both are used). Ownership-checked; names from the DB; app limits + `JEV_DAILY_CAP`. Combine piggybacks `sortScore` for a new discovery. See "Custom sort". |

Every POST requires `content-type: application/json` and header `x-ia-client: 1`, a body
under the per-route size cap, and (when present) a same-origin `Origin`/`Sec-Fetch-Site`.
Errors use `ApiError` with the right HTTP status (400/401/403/404/429/503/422).

## Sessions & identity

- Cookie `ia_session` = `base64url(JSON{p: playerId, v: sessionVersion, t: issuedAt}).hmacSha256`
  with `SESSION_SECRET`. `HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=34560000` (400 days,
  refreshed on every bootstrap).
- No cookie → bootstrap answers `401 pow_required` with a signed PoW challenge
  (`salt = ts.rand.hmac`, ~18 bits). The client solves it in a Web Worker and retries.
  Salts are single-use (counters) and expire after 10 minutes.
- **Legacy players**: the old app stored `localStorage['alchemy:userId'] = {"value":"alchemy:<uuid>"}`
  and the discovered list in `localStorage['elements']` (array of legacy element objects).
  The backfill pre-creates a player for every valid legacy user id. On first visit the client
  sends `legacy` in bootstrap; the server adopts that player (sets the cookie), then imports
  the element ids (mapped via `legacy_element_map`, capped at 20k, max 3 imports per player).
  Only a request whose legacy user id belongs to a backfilled player imports; without one (or
  with an unknown one) nothing is written and the response says `imported: 0`, so a fresh
  player cannot fill its library with caller-chosen elements.
  The client remembers `ia:legacyImported` and never deletes the legacy keys.
- **Adopt-once** (migration 0005): legacy user ids are not secret (the 2023 API returned every
  element's creator id), so a legacy player is adopted by the first browser only. With a user id
  the client sends `legacy.claim`, a random 32-hex token it keeps in `ia:legacyClaim` and writes
  *before* the request; the server stores `sha256(claim)` in `players.legacy_claim_hash` and sets
  `legacy_claimed_at` in one atomic UPDATE (`claimLegacyPlayer`). Only a request carrying the same
  token adopts that player again (a lost response, or the same browser after its cookie was
  cleared). A player that is already claimed, or already played v2 (`last_seen_at`), is never
  adopted by anyone else: that browser falls through to normal PoW player creation and only gets
  a copy of the inventory (no firsts, no challenge history); the response says
  `legacyImport.claimed`, and the app shows a notice pointing at transfer codes from the bound
  device. `adopt.ip` (10/h) only slows mass claiming.
- Imported rows are dated when the element was made (for a legacy player: no earlier than the
  player's `created_at`), starters added on adoption at `created_at`, never `now()`. Elements a
  purge quarantined (`review`) or cut off (`orphaned`) are imported too, hidden like every
  non-active element, so a purge restore or a revival brings them back; `legacy-filter` spam is
  skipped. `imported`/`skipped` count active elements only.
- Transfer codes = signed `{p, v}`; redeem switches this browser to that player.
  Bumping `session_version` revokes all cookies/codes for a player.
  Settings also shows the code as a QR deep link `/#transfer=<code>` (`src/app/lib/transferLink.ts`):
  a fragment, so the bearer code never reaches the server, logs or referrers. On startup `main.tsx`
  strips it from the URL (`history.replaceState`) before anything else runs; after bootstrap (onboarding
  suppressed on that load) a confirm dialog redeems it and reloads. Malformed codes get the invalid-code
  toast without a request; your own code gets "You're already playing as this player" (compared by
  issuing a fresh code, since bootstrap only exposes the public id).

## Abuse & cost defenses

1. Netlify platform rate limits (per IP): `/api/combine` and `/api/image` — rejected
   requests never invoke a function. `/api/sort` has no platform rule (the Starter plan's two
   are used), so its app limits below are the only gate.
2. App-level fixed-window limits (counters): per player and per IP for bootstrap, player
   creation, combine, new recipes (LLM), images, reset, transfer, and sort (requests, plus
   items counted in Jev questions).
3. Global budgets: `JEV_DAILY_CAP` (default 2,500,000 Jev questions/day ≈ $10-13; when it runs
   out only custom sort stops, everything else keeps working), `LLM_DAILY_CAP` (default 100,000 new recipes/day ≈ $10),
   `IMAGE_DAILY_CAP` (default 17,000 images/day ≈ $90), and `IMAGE_MONTHLY_CAP` (default 20,000
   generations per 30 days, which keeps image work inside the Netlify Starter plan's 100
   function-hours/month; raise it after a plan upgrade). Over budget → combine of *known*
   recipes still works; new recipes return `budget_exhausted`; images return `deferred`.
   Budgets are charged only after the per-player/per-IP limits pass (and, for new players,
   after the PoW salt is spent), so rejected requests never consume them.
4. PoW on player creation; per-IP creation limits; global daily player cap.
5. Ingredient ownership is enforced, so automation must play legitimately to reach new recipes.
   Custom sort scores only the player's own active elements, with names read from the DB (the
   client sends ids), so it can't be used as a free scoring proxy.
6. Images are only generated for elements the player owns or today's challenge targets,
   for tiles actually on screen, with per-player hourly/daily caps.
7. Input validation with zod; strict body-size caps; LLM output re-validated; ingredient
   names are passed as JSON-quoted data, never as instructions. Custom-sort prompts and group
   labels are cleaned (control/format characters, length) and passed to Jev only as JSON data
   fields; Jev answers with numbers, never text.
8. `AI_MODE=mock` is refused when `CONTEXT=production`.

## Images

`/api/image {id}`: if ready → path. Else, if eligible and within budget, claim a lease
(`UPDATE … SET image_status='pending', image_lease_until=now()+'45s', image_attempts=image_attempts+1
WHERE id=$1 AND (image_status IN ('none','failed') OR (image_status='pending' AND image_lease_until<now())) AND image_attempts<3`).
The winner calls the image model, stores `el/<id>/<key>.webp` in Blobs, and marks `ready`.
Others get `pending` with a retry hint. `moderation_blocked` → one retry without the name (the
element's hint, or for hint-less legacy rows a generic "a stylized <name>, the everyday thing …"
phrase); a second refusal → `blocked` permanently.
The client shows the procedural placeholder (emoji on a name-hashed gradient) until art is ready, then
fades it in. Tiles use `/.netlify/images?url=<img>&w=192&h=192&fit=contain` and fall back to the raw path.

## Legacy migration (idempotent)

`npm run db:migrate && npm run db:backfill && npm run db:challenges && npm run db:enrich`

- Reads legacy tables read-only (`AS OF SYSTEM TIME follower_read_timestamp()`), keyset-paged.
- Elements: apply `checkName` (+ protection for challenge targets and their shortest paths)
  → active or quarantined; whitespace twins alias to the active row, which takes its date and
  first-discovery credit from the group's earliest spelling (an anonymous earliest spelling: no
  credit). Every legacy id lands in `legacy_element_map`. Legacy image URLs are ignored (all art
  is regenerated lazily).
- Recipes: ingredient list parsed from the legacy recipe `name` (authoritative, multiset),
  mapped through the element map, re-sorted numerically. Collisions: protected first, then
  oldest legacy id. Recipes referencing purged elements are dropped.
- Players: one per valid legacy user id (`^alchemy:<uuid v4 shape>$`), `legacy_user_id` set,
  `created_at` = the earlier of their credits row and their first element (only ever lowered on a
  re-run). Starters + elements they discovered first are seeded into their library.
- `npm run db:repair-legacy` (`scripts/repair-legacy.ts`; dry run unless `--run`) brings rows
  written before those fixes to the same state (player and twin dates, twin credit where it still
  equals what the backfill wrote, starter/import dates, one image retry); a re-run is a no-op.
- Challenge completions: OR-merged per (user, day), only rows with a completion.
- Challenges: legacy days before the cutover copied as-is.
- Emails, credits, and visit-only rows are not migrated.

## Element purge (`npm run db:purge`, `scripts/purge-elements.ts`)

Soft delete of junk names the 2023-2025 model produced ("Doublepanoramajungle"), decided by
two review passes of small models and never by the script itself:

1. `export --out <dir>` writes `batch-NNN.jsonl` (`{id, name, depth, made_from}`, every active
   non-starter outside the never-purge set) and `manifest.json`.
2. Reviewers run `stage --pass review --batch <n> --file <verdicts.json> --manifest <dir>/manifest.json`
   (`[{"id":"…","verdict":"purge"|"keep","reason":"…"}]`, all-or-nothing, idempotent) into
   `purge_review`; a second `verify` pass (`export --pass verify`) re-judges the review's purges.
3. `plan` (read-only) = review purge AND verify purge, minus the never-purge set (starters, every
   challenge target, the shortest derivations of the targets of every day that is "today"
   somewhere, protected recipes' elements), plus the cascade: active elements that were reachable
   from the starters and are not any more become `orphaned` (already-unreachable ones are left
   alone; never-purge ones are kept and reported). `--no-cascade` keeps those survivors active but
   unreachable instead (used for the first production run: most "orphans" were real names that
   only junk happened to lead to). Recipes whose result is removed are quarantined
   unless protected (the next combine heals them); recipes using a removed element are quarantined.
4. `apply --plan` re-validates, quarantines in batched transactions (run id `purge-YYYYMMDD-HHMMSS`
   in `elements/recipes.purge_run`, summary in meta `purge:<id>`), recomputes depth/steps, and
   re-picks generated days after the live window whose targets the purge made inactive or moved
   out of their BFS-tier pool. `restore --run <id>` reverses a run (re-picked days stay).

Combine reactivates an `orphaned` element when the model names it again; any other quarantined
name still fizzles.

## Custom sort ("Sort by anything")

The library can be ordered by the player's own words: **rank** (`{kind: "rank", prompt}`,
e.g. "spookiest") or **groups** (`{kind: "groups", groups}`, 2–8 labels plus an implicit Other).

- **Server.** `POST /api/sort {spec, ids?}` (`server/game/sort.ts`) charges the request limits
  (alongside the session lookup) and only then loads the player's owned, active elements (all of
  them, newest first, capped at `SORT_MAX_ELEMENTS` = 25,000; or just `ids`, unowned ones dropped
  silently): the whole-library read scans every discovery, and `/api/sort` has no platform rule,
  so a rejected request must not start it. It then charges the item limits and `BUDGETS.jev` by
  cost = elements × questions (rank 1, groups 2), and scores them in one response.
- **Questions** (`server/ai/jev.ts`, rubric `SORT_RUBRIC` = `r2`). Rank: one `score` question per
  element over 5 generic levels, in requests whose `state` names the player's goal and says to
  read each name as the real thing it names (without it, "oldest" put Earth and Fire first and
  "heaviest"/"smallest" ranked by association). Groups: a `choice` over the groups (options
  rotated per element against first-option bias) plus a last, never-rotated "None of these
  groups" option, and a companion `noul` ("clearly belongs in one of these groups?"). When Jev
  picks None (about 45% of elements) `g` is the most likely real group; the fit is
  `n = noul × (1 − P(None))`, so weak fits sink inside their group and fall to Other below
  `SORT_FIT_THRESHOLD` (500). Rank scores at or above `SORT_MATCH_THRESHOLD` (600) are
  "Matches". Requests pack ≤ 400 questions / ~40k estimated tokens, 8 run at a time, transient
  errors are retried once (honouring `retry-after`), a chunk is split on `max_tokens_exceeded`,
  and what couldn't be scored comes back in `retry`. The response is parallel integer arrays
  (`ids`, `s` 0..1000, and for groups `g` and `n` 0..1000). Model pinned (`SORT_MODEL`); any
  change to a question string, the levels or the parse bumps `SORT_RUBRIC` (client score mirrors
  are keyed by it) and should be re-measured first with `npm run eval:sort` (tune split, then
  holdout once). The key, prompt and group text are never logged.
- **Piggyback.** With an active custom sort, `/api/combine` carries `sort`; a result that is new
  for the player is scored alongside the challenge check (`scoreDiscovery`, capped at 800 ms,
  never fails the combine) and returned as `sortScore`, so a discovery usually costs no extra
  call. It charges `BUDGETS.jev` first and calls Jev only once that passes, with what is left of
  the 800 ms, so `JEV_DAILY_CAP` bounds piggyback spend too.
- **Client engine** (`src/app/state/customSort.ts`, pure helpers in `lib/customSort.ts` and the
  ordering in `lib/librarySort.ts`). `reconcile()` is the only scheduler: on owned/status/sort
  changes it starts one full run when little is known, or queues the missing ids for a batched
  `{ids}` request (2.5 s debounce, 8 s cap, at once at 100 ids; one in flight). Failures never
  clear the order on screen; rate limits and the budget wait out their `until` (with more than
  30 s left, queued ids sort as unscored rather than pulsing as pending until the last 30 s).
  Reverse, Other, the Matches/group buckets and pins are display options that never call the
  server. Scores are cached per spec (LRU of 4) and keyed by player; a player switch or library
  reset drops every cache and aborts everything in flight. A spec counts as cached only when its
  entry is complete (a whole-library run, or the session mirror of one): piggybacked or batched
  scores alone never skip the full run. Picking ✦ in the sort select for a spec that isn't
  cached waits 400 ms (and for as long as the sheet is open) before any request, so arrowing
  through a native select costs nothing; responses for an older generation, key or player are
  dropped on arrival.
- **Storage.** `ia:customSort` (localStorage, ~1 KB: spec, view, 5 recents, previous sort,
  seen) and `ia:customSortScores` (sessionStorage: the active spec's scores tagged with player,
  key and rubric, plus the owned ids the server ruled out and the truncated flag, so a reload in
  the same tab re-sorts with no request, even for a library over 25,000). Nothing in the DB.

## Testing

- Unit: Vitest (`*.test.ts`) for names, rarity, dates, PoW, recipe keys, rate-limit math.
- E2E: Playwright against `netlify dev` with `AI_MODE=mock` and `DB_SCHEMA=alchemy_e2e`
  (seeded by `scripts/seed-e2e.ts`; never the production schema). Projects: desktop Chrome,
  Pixel 7, iPhone 15 and iPad (Chromium device emulation with real CDP touch drags), plus
  WebKit iPhone for layout screenshots. Includes a returning-legacy-player journey that
  first installs a CRA-style service worker and legacy localStorage on the same origin. The
  adopt-once journey (`e2e/legacy-claim.spec.ts`) binds a legacy player in one browser, gets a
  copy of the elements only in another, and re-adopts with the first browser's claim token.
- Mock sort hooks (`server/ai/mock.ts`, AI_MODE=mock): a rank prompt or a group containing
  `mock unavailable` throws `AiUnavailable` (503), `mock slow` answers after 2.5 s, and
  `mock partial` sends every third element to `retry`. Live Jev is checked only by the manual
  `npx tsx scripts/jev-smoke.ts` and the sort eval `npm run eval:sort` (labelled rank and groups
  cases, cached, with a spend cap; never `*.test.ts`, so `npm test` never spends money).

## Environment

| Var | Purpose |
|---|---|
| `DATABASE_URL` | CockroachDB connection string (`sslmode=verify-full`). |
| `OPENAI_API_KEY` | LLM + images. |
| `TYPESAFE_API_KEY` | Jev (custom library sort). Set it in the Netlify site environment with Functions scope. |
| `SESSION_SECRET` | ≥32 random bytes (hex/base64) for cookies, PoW salts, transfer codes, IP hashing. |
| `DB_SCHEMA` | `alchemy` (default) or `alchemy_e2e`. |
| `AI_MODE` | `live` (default) or `mock` (forbidden in production). |
| `LLM_DAILY_CAP`, `IMAGE_DAILY_CAP`, `IMAGE_MONTHLY_CAP`, `PLAYER_DAILY_CAP`, `JEV_DAILY_CAP`, `POW_BITS` | Optional overrides. |
