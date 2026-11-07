# End-to-end tests (Playwright)

The suite drives the real stack: `netlify dev` (Vite SPA + Functions) on port 8888 with
`AI_MODE=mock`, `DB_SCHEMA=alchemy_e2e` and `POW_BITS=8`, against the small deterministic world
that `scripts/seed-e2e.ts` writes into the `alchemy_e2e` schema. It never touches the production
schema `alchemy` (see "Safety").

```
npm run e2e                                   # everything, all projects (~4 min, 3 workers)
npx playwright test --project=desktop-chrome  # one device
npx playwright test e2e/legacy-player.spec.ts # the returning-legacy-player journey
npx playwright show-report e2e/.artifacts/report
```

Environment knobs:

| Var | Effect |
|---|---|
| `E2E_REUSE_SERVER=1` | Use a `netlify dev` already listening on 8888 instead of starting one. It must run the E2E env; the safety guard checks. |
| `E2E_SKIP_SEED=1` | Skip the reseed (fast reruns of tests that don't need a pristine world; "first discovery" tests need a reseed). |
| `E2E_WORKERS=n` | Parallel workers (default 3). |

To run against a server you start yourself:

```
AI_MODE=mock DB_SCHEMA=alchemy_e2e POW_BITS=8 BROWSER=none npx -y netlify-cli@27.16.2 dev --port 8888
E2E_REUSE_SERVER=1 npm run e2e
```

## Projects

| Project | Engine | Emulation | Runs |
|---|---|---|---|
| `desktop-chrome` | Chromium | 1440x900, mouse | everything |
| `pixel-7` | Chromium | Pixel 7 (touch, DPR 2.625) | everything; drags are real CDP touch events |
| `iphone-15` | Chromium | iPhone 15 viewport/DPR/UA, `hasTouch`, `isMobile` | everything; CDP touch drags |
| `ipad` | Chromium | iPad (gen 7) 810x1080, touch | everything; CDP touch drags |
| `webkit-iphone` | WebKit | iPhone 15 viewport/DPR/UA, no touch (WebKit on Windows cannot emulate it) | only tests tagged `@layout` |

## Suites

| Spec | Journey |
|---|---|
| `first-visit` | onboarding, 401 `pow_required` then 200 (PoW in a worker), five starters, dismissal persists across reload |
| `combine-drag` | drag Water to the canvas and Fire onto it: Steam, inputs consumed, "new" toast, library +1; an unknown combo (mock AI): first-ever card |
| `tap-select` | tap to place, tap to select/deselect, tap another to combine (WCAG 2.5.7 alternative) |
| `daily-challenge` | today's easy target from known recipes: tier complete, celebration, persists after reload |
| `library` | search, long-press (touch) / right-click (mouse) quick actions, pin moves to front and persists, unpin |
| `canvas` | clear, undo from the snackbar and the toolbar, tiles back in the same places |
| `reset-progress` | a quick tap does nothing; a 2 s hold resets to the starters; firsts and challenge history kept |
| `legacy-player` | the returning 2023 player (below) |
| `legacy-claim` | (desktop-chrome only; its own seeded legacy user) adopt-once: browser A adopts the legacy player and keeps its claim token (`ia:legacyClaim`, sent before the response); browser B with the same id and inventory gets a new player with a copy of the elements only (no firsts, no history, one `legacy-claimed` notice, no onboarding, nothing dated `now()`); a purge-quarantined (`review`) inventory element stays hidden but is kept in the library (read-only DB check); A with its cookie cleared re-adopts the same player with its token |
| `resilience` | injected `rate_limited` / `budget_exhausted` combines and a rate-limited bootstrap: friendly copy, nothing lost, game recovers |
| `layout` | no horizontal scroll, finger-sized key controls (44 px touch, 24 px mouse), canvas tiles in bounds and uncovered after rotate/resize |
| `custom-sort` | "Sort by anything" with the mock scorer (weather words score 850+): rank "weather" puts Cloud/Storm/Rain first, every tile weighed, the details line, and a reload restores the order from the session mirror with no `/api/sort`; a discovery (Water + Earth = Mud) is scored inside `/api/combine` (`sortScore`, no `/api/sort`), or, with `sortScore` stripped, by exactly one batched `/api/sort {ids:[Mud]}`; an injected 503 shows the calm error (after the silent retry) with the Recent order kept and Retry recovers, a 429 shows the countdown; groups Weather/Space: bucket chip counts, a chip filters, starters in Other, the Other switch is "Done" with no request; reverse/clear/re-select make no request (every tile keeps a numeric score, and the order really inverts); a search that finds nothing offers "Rank everything by …" (Matches bucket on, search cleared, the `library-empty` Matches state says so); `@layout`: the sheet and bar fit, 44 px targets, the ✦ peek button on phones |
| `head-meta` | (desktop-chrome only) one title/description of search-friendly length, canonical, Open Graph/Twitter cards; the og:image exists at its advertised URL and size; manifest + every icon resolves as a real image of its declared size; font preloads; `robots.txt`, `llms.txt`, sitemap, `.well-known/ai-catalog.json`; every other sitemap page is a real, indexable, cookie-free page with its own canonical, a unique title/description and resolving og:image, stylesheet, fonts and icons; `/daily` names today's seeded targets; the 2023 `/manifest.json` and `/logo*.png` URLs 301 to the new files |
| `transfer-qr` | (desktop-chrome + iphone-15) Settings shows the code as a QR `/#transfer=<code>` link (~200 px, whole-pixel modules) and Copy link copies it; a fresh device opening it bootstraps, sees the confirm (no onboarding), switches and has player A's library; the hash is gone at once; Cancel keeps the device's player; garbage gets the friendly error with no request; a forged code is refused after Switch; your own link only says you're already that player |

Every test also fails on any uncaught page error.

### The returning legacy player

`legacy-player.spec.ts` controls its own origin (`localhost:8890 + project index`):

1. **2023:** `e2e/legacy-fixture/server.ts` serves a fake Create React App build: a precached shell
   whose bundle writes `alchemy:userId` / `elements` / `infomodal:closed` like the old hooks and
   registers a Workbox-like `service-worker.js` (precache `/`, `/index.html`, bundle; cache-first app
   shell for navigations; `clients.claim()`). The test waits until the worker controls the page and
   closes the browser (persistent profile).
2. **v2 goes live:** the fixture server stops and a transparent proxy (HTTP + WebSocket, Host header
   preserved) binds the same port in front of the suite's `netlify dev`, so the browser sees one
   origin switch deployments. The reopened profile navigates as the player would: the first response
   comes from the old worker's cache; the kill-switch `public/service-worker.js` must take over and
   land the tab on v2 with at most one automatic reload, leaving no registrations and no caches.
3. Asserts the legacy payload was sent and adopted, mapped elements present, quarantined ones absent,
   no duplicates, legacy first discovery still credited, legacy history rows in the challenges sheet,
   exactly one non-blocking welcome-back notice (the board is usable without dismissing it), no
   onboarding, and that a second reload sends no legacy payload, imports nothing and keeps the legacy
   keys untouched.
4. The adopted player keeps playing on that origin: a combine through the proxy succeeds, and the
   result is still in the library after a reload.

## Layout

```
playwright.config.ts          projects, webServer (netlify dev), reporters
e2e/global-setup.ts           reseeds alchemy_e2e (npm run db:seed-e2e) + safety guard against the server
e2e/fixtures.json             written by scripts/seed-e2e.ts; consumed, never edited here
e2e/support/env.ts            ports, E2E env, project order
e2e/support/fixtures.ts       zod-validated loader for fixtures.json + recipe-path / unknown-combo helpers
e2e/support/gestures.ts       CDP touch drag / long-press, mouse drag, tap
e2e/support/game.ts           page object: selectors + game flows (incl. custom sort: openSortControls, openCustomSort, applyCustomSort, nextSort, recordSorts)
e2e/support/test.ts           `test` with game/fixtures/device fixtures, screenshots, page-error guard
e2e/support/node-api.ts       Node API client (PoW + bootstrap) used by the guard
e2e/legacy-fixture/           fake 2023 app (index.html, main.legacy.js, service-worker.js) + server/proxy
e2e/*.spec.ts                 the suites
e2e/.artifacts/               screens/<project>/<test>--<step>.png (taken once short animations settle), test-results (traces), report (gitignored)
```

## Safety

- Global setup reseeds with `DB_SCHEMA=alchemy_e2e` forced (the seed itself refuses any other schema),
  then calls the running server's `/api/bootstrap` without a cookie and **aborts the run** unless
  the PoW challenge asks for exactly 8 bits (the server got the E2E env) and the world it reports is
  the small seeded one (it reads `alchemy_e2e`, not the production world).
- Each test is a fresh browser context, i.e. a fresh anonymous player (about 92 players per full
  run). The E2E env raises the per-IP hourly creation limit (`CREATE_IP_HOURLY=1000`); the daily
  one (`create.ip.day`, 300) still applies, and the reseed clears the e2e counters. A new suite
  that creates players must stay inside that budget: past it, the last tests to run get `429` on
  bootstrap ("Lots of alchemists right now").
- Tests that need a "first discovery" claim a distinct `unknownCombos` entry per project, so projects
  never race. Retries are off: a retried first discovery would no longer be first. The same goes
  for legacy players: one can be adopted once per reseed (adopt-once), so a rerun of
  `legacy-player` or `legacy-claim` needs a reseed. Adoption attempts are limited to 10/hour per IP
  (`adopt.ip`); a run uses 8 (one per project in `legacy-player`, four in `legacy-claim`, whose
  second browser also creates one player).
- One run at a time per machine, even against different servers: every run reseeds the shared
  `alchemy_e2e` schema (deleting the other run's players, so their sessions answer `pow_required`),
  the per-IP creation limit is shared, and the legacy journey binds ports 8890-8893.

## Contract with the app: `data-testid`s

Implemented by the frontend; `e2e/support/game.ts` is the single place that uses them.

| test id | element | attributes / notes |
|---|---|---|
| `app` | app root | `data-ready="true"` once bootstrap succeeded |
| `onboarding` | first-run onboarding | dismiss button `onboarding-dismiss`; never again after dismissal |
| `welcome-back` | one-time notice after a legacy import | non-blocking |
| `legacy-claimed` | one-time notice: the legacy player is bound to another browser, elements were copied | non-blocking toast |
| `toast` | each toast | `data-kind` = `new` \| `error` \| `undo` \| `info`; actions are buttons ("Undo") |
| `discovery-card` | first-ever discovery card (dialog) | element name + "first" wording |
| `challenge-complete` | challenge-completed card (dialog) | `data-tier` |
| `challenge-chip`, `challenges-sheet` | top bar button and its sheet | |
| `challenge-target` | today's target card | `data-tier`, `data-completed="true\|false"` |
| `challenge-history`, `challenge-history-day` | full history (incl. legacy days) and its rows | `data-day`, `data-completed="easy,hard"` |
| `stats-chip`, `library-count` | top bar stats button; my element count | `data-count="<n>"` |
| `library`, `library-search` | library scroller, search input | `data-sort-state` = `idle` \| `scoring` \| `ready` \| `error` while a custom sort is on (absent otherwise). When a new custom order lands (epoch) while a tile has focus, focus moves to the first tile (`data-index="0"`) |
| `library-empty` | the library's empty state (grid or phone peek row) | `data-state` = `matches` \| `group` (a custom-sort bucket emptied it) \| `search` \| `pinned` \| `new` \| `firsts` \| `empty`; in the peek row the bucket copy says "Open the library to see everything." |
| `library-tile` | library element | `data-element-id`, `data-name`, `data-pinned`; with a custom sort on: `data-cs` = `pending` \| `rank` \| `group` \| `other`, `data-score` = `0..1000` \| `pending`, `data-group` = `0..7` \| `other` (absent while unscored) |
| `sort-select` | the library sort `<select>` (rail; on phones in the expanded shelf; DOM id `library-sort`) | values `recent`, `az`, `rarity`, `custom` (only once a spec is stored; text `✦ {short}`), `__edit` ("Custom…": opens the sheet, never a sort). A pick (`selectOption`, mouse, touch, the option list) of `__edit` opens the sheet at once; stepping onto it, or onto `custom` while another sort is active, with Arrow/Page/Home/End or type-ahead ("c") only arms it: `data-armed` = `__edit` \| `custom`, the value shows that option, Enter/Space applies it (opens the sheet / applies the stored sort), Escape or blur snaps back to the real sort; nothing is sent to `/api/sort` while armed. Focus lands here after `custom-sort-clear` (keyboard or mouse; a tap leaves focus alone so iOS never pops the picker) |
| `custom-sort-sheet` | "Sort by anything" sheet | on a fine pointer, closing it (Escape, Cancel, Apply) puts focus back on the control it was opened from (`sort-select` or `custom-sort-edit`) |
| `custom-sort-mode` | Rank / Groups radiogroup | child buttons carry `data-mode` = `rank` \| `groups` |
| `custom-sort-input` | rank prompt field | `maxLength` 80; Enter applies |
| `custom-sort-use-groups` | "Looks like a list" hint button | |
| `custom-sort-group`, `custom-sort-remove-group`, `custom-sort-add-group` | group fields (3 empty rows to start; blank rows are dropped), their remove buttons (more than 2 rows only), "+ Add group" (hidden at 8) | |
| `custom-sort-other` | "Put weak fits in Other" switch | `role="switch"`, `aria-checked` |
| `custom-sort-example` | example chips (fill the form, never apply) | `data-example` = `spookiest`, `biggest`, `cutest`, `hottest`, `kitchen`, `ocean`, `dangerous`, `oldest` (rank); `animals-food-weather`, `classical`, `land-sea-sky-space`, `living-nature-made-ideas`, `heroes-villains` (groups; the first and last turn Other on) |
| `custom-sort-recent` | recent sorts (apply and close) | `data-kind` = `rank` \| `groups` |
| `custom-sort-error` | validation message | `role="alert"`; "Describe an order first." / "Add at least two groups." appear after an apply attempt (Apply or Enter), which also focuses the field to fix |
| `custom-sort-loading` | "Loading your library…" (role `status`) while the game is still booting | Apply is disabled and its label has no count meanwhile |
| `custom-sort-apply`, `custom-sort-cancel` | footer buttons | apply: `data-action` = `apply` \| `done` ("Done": only the Other switch changed, no request); enabled for an incomplete form (a tap shows `custom-sort-error`); disabled only while budget-blocked and not cached, or while the library loads |
| `custom-sort-bar` | the active custom sort under the library controls | `data-status` = `idle` \| `scoring` \| `ready` \| `error`, `data-kind` = `rank` \| `groups` |
| `custom-sort-edit` | the lens chip (opens the sheet; DOM id `custom-sort-lens`) | 44 px tall hit area; focus lands here after `custom-sort-retry` (Retry) and after `custom-sort-from-search` (keyboard or mouse only) |
| `custom-sort-matches` | "Matches n" bucket chip (rank) | `aria-pressed` |
| `custom-sort-reverse`, `custom-sort-clear` | reverse (rank only) and turn off | reverse: `aria-pressed` |
| `custom-sort-bucket` | group bucket chips (groups) | `data-bucket` = `all` \| `0..7` \| `other`, `aria-pressed` |
| `custom-sort-message`, `custom-sort-retry` | the bar's one message line and its Retry / Reload / Edit button | `role="alert"` for failures, `role="status"` otherwise |
| `custom-sort-peek` | ✦ button in the phone shelf's peek row (custom sort on) | opens the shelf to half |
| `custom-sort-from-search` | "Rank everything by “q”" in an empty search result | non-compact empty state, query 2–80 chars |
| `quick-actions-custom-sort` | the custom-sort line in the details popover | `#r of n for “label” · Level`, `In {group}`, `In Other · closest: …`, `Weighing for “label”…` |
| `quick-actions`, `quick-action-pin` | long-press / right-click menu and its Pin/Unpin item | |
| `canvas`, `canvas-tile` | play surface; element on it | `data-name`, `data-selected="true\|false"`, `data-pending="true"` |
| `canvas-undo`, `canvas-tidy`, `canvas-clear` | toolbar | |
| `menu-button`, `settings-sheet`, `reset-progress`, `reset-confirm` | settings and the hold-to-confirm reset | |
| `transfer-share`, `transfer-qr`, `transfer-code` | Settings transfer block once a code is shown: the QR card (an `<svg>`) and the code text | |
| `transfer-confirm`, `transfer-switch`, `transfer-cancel` | confirm dialog after opening a `/#transfer=<code>` link | |

## Contract with the seed: `e2e/fixtures.json`

Validated by `e2e/support/fixtures.ts` (the schema there is authoritative): `starters`, `recipes`
(pairs, incl. Water + Fire = Steam), `unknownCombos` (no recipe yet, distinct mock answers),
`challenge` (`easy`/`hard`/`expert` for local today ±3, `easyPath`), and `legacyUsers` (one per
Chromium project: `userId`, legacy-shaped `elements`, `expectPresent`, `expectAbsent`,
`firstDiscovery`, `history`; a sixth entry is the adopt-once user of `legacy-claim`), plus
`reviewQuarantined` (a purge-quarantined element that only that sixth user's inventory holds).
