# freeCodeCamp Client: Gatsby → Astro Migration Battle Plan

> **Status:** Scouting report / proposal — no code has been written. Produced from a full audit of
> `client/` (570 source files, ~64k LOC), the build/deploy pipeline, the dependency graph
> (pnpm lockfile closure analysis), the `@freecodecamp/ui` library, and July-2026 research into the
> Astro/Vite ecosystem and its alternatives — then adversarially reviewed by independent
> architecture, completeness, evidence-audit, and security passes, with corrections applied.
> Load-bearing claims carry `file:line` references into the repo as of this audit; ecosystem claims
> (versions, acquisitions, benchmarks) come from the July-2026 web research and should be re-cited
> with links in the final ADR.
>
> **Recommendation in one sentence:** Rewrite the client as a single Astro (v7, Vite, React islands)
> project in which the public/curriculum pages become prerendered `.astro` shells with near-zero JS,
> and the `/learn` challenge workspace becomes **one self-routed `client:only` React SPA island**
> that carries Redux, sagas, Monaco, and the test-runner over unchanged — cutting the runtime
> dependency closure by ~70%, deleting webpack/babel/GraphQL entirely, and dropping the 7 GB-heap
> per-locale build to minutes on default heap.

---

## Table of contents

1. [Executive summary](#1-executive-summary)
2. [Current state — what the audit found](#2-current-state--what-the-audit-found)
3. [Framework decision](#3-framework-decision)
4. [Target architecture](#4-target-architecture)
5. [Dependency cut list & attack-surface reduction](#5-dependency-cut-list--attack-surface-reduction)
6. [Security posture changes](#6-security-posture-changes)
7. [Migration strategy & phases](#7-migration-strategy--phases)
8. [Risk register](#8-risk-register)
9. [Testing & acceptance strategy](#9-testing--acceptance-strategy)
10. [Effort & sequencing estimate](#10-effort--sequencing-estimate)
11. [Open questions for the team](#11-open-questions-for-the-team)
12. [Appendix A: route-by-route migration map](#appendix-a-route-by-route-migration-map)
13. [Appendix B: contracts that must survive](#appendix-b-contracts-that-must-survive)

---

## 1. Executive summary

### Why this is more tractable than it looks

The scariest part of "rewrite the client" turns out to be already done. The audit's single most
important finding: **the Gatsby coupling is wide but shallow, and the data layer is already
framework-free.**

- Only **31 files in `client/src`** (33 including `gatsby-browser.tsx`/`gatsby-ssr.tsx`) import
  from `gatsby` at all, in four trivially-classifiable ways (12 page queries, 4 static queries,
  12 `navigate` call sites, 4 `withPrefix`, one `Link` wrapper).
- The GraphQL layer is a pass-through: challenge data originates as plain JSON
  (`curriculum/generated/curriculum.json`, built by the framework-agnostic `@freecodecamp/curriculum`
  package) and is re-projected into Gatsby nodes by one ~370-line local plugin
  (`tools/client-plugins/gatsby-source-challenges`). The page-creation logic
  (`client/utils/gatsby/challenge-page-creator.js`) is pure JS that ports nearly verbatim into an
  Astro `getStaticPaths`.
- All six client setup scripts (`create:env`, `create:i18n`, `create:trending`,
  `create:search-placeholder`, `create:external-curriculum`, `copy:scripts`) are plain `tsx`
  scripts with zero Gatsby imports. They survive unchanged.
- Unit tests are already on Vitest; the 101-spec Playwright e2e suite tests a URL, not Gatsby —
  99 of 101 specs should pass unmodified against an Astro build served the same way.
- All 24 `@freecodecamp/ui` components the client uses are verified SSR-safe for Astro islands
  with zero library changes required.

### Where the real risk lives

Two things dominate everything else:

1. **The workspace island decision.** Challenge → challenge navigation currently keeps the Redux
   store, Monaco editor, pyodide worker, and a detached preview `window.open` popup alive via
   Gatsby's SPA transitions (`completion-epic.js:318`, `preview-portal.tsx:94–107`). Astro's MPA
   model has no cross-page island persistence (its `<ClientRouter>`/`transition:persist` path is
   community-flagged as legacy and incompatible with Astro's CSP feature — treat "persist cannot
   carry Monaco + a popup handle" as a spike hypothesis to confirm, but do not build on it).
   Therefore the `/learn` workspace **must be architected from day one as one `client:only` React
   island with its own client-side router**. Built that way, Redux/sagas/Monaco move over
   unchanged. Built naively (one island per page), the migration ships a *worse* product than
   today. Free exit hatch: the island is a self-contained Vite React app that could be extracted
   into a standalone SPA later if Astro ever disappoints.
2. **Migration drift.** `client/` receives roughly 1–1.5 commits/day (maintainers + community).
   Over a 4–6 month parallel build that is 150–250 changes that must be double-ported or
   consciously frozen — a process problem as large as any technical one. §7.0 defines the
   drift-management policy; §10 costs it.

### Headline numbers

| Metric | Today (Gatsby 5) | Post-migration (Astro 7 + Vite) |
|---|---|---|
| Direct client deps | 143 | ~75–85 |
| Runtime lockfile closure (locked package instances) | 1,841 | ~400–550 incl. framework (−70%; measure exact baseline in spike) |
| Gatsby-attributable locked packages | 1,454 (69% of closure) | 0 |
| Build heap | 7 GB (`--max-old-space-size=7168`) | default heap (target; gate in spike) |
| Pages per locale build | ~16.6k unique challenges → **≈19k pages** (blocks are reused across superblocks; verify exact count against a real build in the spike) + 98 intros + ~25 pages | same page count, thin shells |
| Published comparable build times | Gatsby-era case studies: 45+ min | Astro 7 (vendor-published): 6,313 pages/73 s, 8,431 pages/261 s |
| JS on public pages | Full React + redux + Stripe + GTM boot on every page | ~0 KB baseline + opt-in islands |
| webpack/babel packages | webpack ×2 configs, 10+ babel deps, 8 node-polyfill shims | none in the client (browser-scripts keeps its own bundler initially) |
| Third-party runtime scripts | GTM + MathJax 2.7.4 (cdnjs) + Pyodide (jsdelivr) on every relevant page, zero SRI | MathJax deleted (build-time math), Pyodide self-hosted, SRI on the rest; per-route-class CSP |

---

## 2. Current state — what the audit found

### 2.1 Page inventory (per locale build)

Everything is statically generated by Gatsby today; there is **no** runtime CDN fetching of
challenge content (the only runtime-fetched challenge is the Daily Coding Challenge, which reuses
the classic template with synthesized props — `show-daily-coding-challenge.tsx:65–132`).

| Route class | Count | Mechanism |
|---|---|---|
| Challenge pages `/learn/:sb/:block/:challenge` | **≈19k** (16,641 unique challenges; blocks reused across superblocks — see §1) | `createPagesStatefully` inside the local source plugin (`gatsby-source-challenges/gatsby-node.js:334`) → `createChallengePages` → 11 templates keyed by `challengeType` |
| Superblock intros `/learn/:sb/` | 98 | `client/gatsby-node.ts:60–62` |
| Static pages (`/`, `/learn`, `/donate`, `/catalog`, …) | ~18 | File System Route API |
| Client-only shells (settings, profile `[maybeUser]`, certification, unsubscribed, report-user, update-email, daily challenge, `/status/version`) | 9 | `[param]`/`[...]` pages rendering `client-only-routes/` components; params parsed in-browser, data from the API |
| Legacy redirects (`/challenges/*`, `/certification`, `/user`) | 4 | Client-side `navigate()` React pages |

The full route-by-route disposition is in [Appendix A](#appendix-a-route-by-route-migration-map).

### 2.2 The data pipeline

```
curriculum/challenges/**/*.md  (16,644 files, 54 MB)
        │  @freecodecamp/curriculum build (tsc + challenge-parser: remark pipeline → HTML strings)
        ▼
curriculum/generated/curriculum.json   (~100 MB, single file — needs 7 GB heap downstream)
        │  client/utils/build-challenges.js  (plain JS flattener — already framework-free)
        ▼
gatsby-source-challenges plugin  → one ChallengeNode per page (each JSON.parse(JSON.stringify) cloned + md5'd)
        │  GraphQL schema inference (pinned by schema.gql snapshot) + LMDB round-trips
        ▼
16 graphql queries (12 page + 4 static)  → page-data.json × ≈19k pages  (re-emits most of curriculum.json)
```

Gatsby adds four full re-serializations of the same data and a GraphQL layer that exactly two
things consume: page templates (by slug) and four static queries. Notably:

- `gatsby-transformer-remark` and `gatsby-source-filesystem` are **confirmed dead deps** — in
  `package.json` but absent from `gatsby-config.ts` and every query (no `MarkdownRemark` type in
  `schema.gql`). Deletable today.
- Large never-queried fields ride along in page data: full `solutions` arrays, `challengeFiles.seed`
  (contents duplicated), `sourceLocation`, etc. — a big payload cut is available at derive time.
- The `super-block-intro` page query is **unparameterized** — all challenge nodes are embedded
  into the page data of each of the 98 intro pages (`super-block-intro.tsx:354`).
- `static/curriculum-data/v2/**` (one JSON per challenge) is a **public contract for the mobile
  app**, generated by a standalone script — it survives unchanged, and proves the per-challenge-JSON
  pattern the new build should use internally.

### 2.3 Runtime state architecture

- One Redux store created at module scope in `gatsby-browser.tsx`/`gatsby-ssr.tsx`, wrapping every
  page. **86 files import `connect()`**; four middleware families run simultaneously (redux-saga
  ×18 sagas, redux-observable ×6 epics on rxjs 6, RTK Query ×2 APIs, plus redux-actions reducers).
- Auth = session cookie + CSRF header; `fetch-user-saga` gates **every page render** behind a
  full-screen loader (`default.tsx:186–187`). The `csrf_token` cookie is erased on every page load
  (`gatsby-browser.tsx:45–50`) with a retry hack in RTK Query to absorb the resulting 403 race.
- Genuinely global cross-page state is exactly four small values: `sessionUser`, `theme`, `flash`,
  `examInProgress`. Everything else (challenge, curriculumMap, search, settings slices) is
  consumed by exactly one route-class subtree — but note the consumers are `connect()`-wired to
  the *global* store today (see §4.3 for the per-island store decision this forces).
- Three epics are app-level, running on every page: `failed-updates-epic` (flushes the
  `fcc-failed-updates` localStorage queue on reconnect/sign-in), `update-complete-epic`,
  `hard-go-to-epic`. Their disposition is called out explicitly in §4.3.
- Already MPA-safe via localStorage/sessionStorage: challenge code (`code-storage-epic`), failed
  submission queue, theme (pre-paint inline script), sound prefs, editor layout, current challenge
  id, and server-driven flash via `?messages=` query params (`app-mount-saga.js`).
- Monaco has **no** manual worker wiring anywhere — it is 100% `monaco-editor-webpack-plugin`.
  Vite worker wiring is net-new code (small, well-documented, but must be built and verified).
- The preview iframes, pyodide worker, `python-input-sw.js` service worker, and sass/TS workers
  are loaded **by URL from `static/js`** — built by a separate webpack config in
  `@freecodecamp/browser-scripts`. The test runner itself is `@freecodecamp/curriculum-helpers`
  (external package), injected into the **parent page** head from
  `/js/test-runner/<version>/index.js` (`frame.ts:222–258`). The client imports only types + a
  version string from browser-scripts, so that package can keep its bundler while the client moves
  to Vite.

### 2.4 i18n & deployment

- **One build = one locale.** 11 client languages; `CLIENT_LOCALE` bakes translations into the
  bundle via `babel-plugin-preval` (`i18n/config.js:29–64`), sets `pathPrefix = '/' + locale`
  (English: none), and the deploy is an 11-job GitHub Actions matrix, each tarring `client/public`
  and scp-ing over Tailscale to **2 VMs per language (22 VMs)** running `serve@13` under pm2.
- **`serve.json` (production redirects/headers) lives in the external `freeCodeCamp/client-config`
  repo** and on the VMs — the real routing table is incomplete until that file is audited.
- Non-English translations come from the `curriculum/i18n-curriculum` git submodule at setup time;
  client-UI strings round-trip through **Crowdin** on scheduled workflows
  (`crowdin-upload.client-ui.yml` / `crowdin-download.client-ui.yml`) — a hard scheduling
  dependency for any locale cutover that introduces new strings (§7 Phase 5).
- `html lang` is hardcoded `'en'` at SSR and patched client-side after mount — an SEO/FOUC wart
  the rewrite fixes for free.
- **No browserslist config exists anywhere in the repo** — the client silently inherits Gatsby's
  default (`>0.25%, not dead`) + core-js polyfills. Vite/Astro defaults target much newer
  browsers; an explicit browser-support floor must be chosen (§11 Q9).

### 2.5 Dependency & supply-chain baseline

Measured by transitive-closure walk of `pnpm-lock.yaml` from the client importer:

- 143 direct deps → **2,098 locked package instances** (1,841 runtime-only; ~1,996/1,746 after
  deduplicating peer-variants).
- The `gatsby*` subtree alone: **1,454 packages (69%)**.
- Removable **today with zero code changes**: `eslint-config-react-app`, `eslint-plugin-flowtype`,
  `gatsby-transformer-remark`, `gatsby-source-filesystem`, `react-transition-group` (0 imports),
  `react-instantsearch-core` (0 direct imports), `@redux-saga/core` (0), `@redux-devtools/extension`
  (0), `prop-types` (0 real imports), `@types/react-redux`, and both babel proposal plugins
  (function-bind / export-default-from — grep-verified no usage of either syntax).
  `babel-plugin-macros` (0 macro usages) additionally needs a one-line `.babelrc.js` edit.
  **Honest sizing:** because these subtrees overlap the still-installed Gatsby/babel/eslint
  toolchain, deleting all of them removes **~120–130 locked packages** while Gatsby remains (the
  oft-quoted 454/132 subtree figures are gross closures, not deletion deltas). The full win only
  lands when Gatsby itself goes.
- All 7 node-polyfill packages (assert, crypto-browserify, path-browserify, stream-browserify,
  process, util, url + the Buffer ProvidePlugin) exist **only** for `gatsby-node.ts:65–101`; grep
  proves no client source imports node builtins. Their last transitive consumer is `sanitize-html`
  (→ postcss needing `path`/`fs`), which should be replaced by DOMPurify anyway (already a dep of
  `@freecodecamp/ui` 6.1.0).

---

## 3. Framework decision

### 3.1 Why Astro (and which Astro)

Astro was pressure-tested against React Router 7 framework mode, TanStack Start, Next.js static
export, Vike, and a plain Vite SPA + prerender pass. Full scoring in the scouting notes (attach
sources — release notes, acquisition announcements, benchmark posts — in the ADR); the decisive
criteria for this app shape:

1. **Zero-JS public pages.** freecodecamp.org's organic-traffic pages (landing, superblock intros,
   donate, supporters, catalog) are the top of the funnel. Astro is the only candidate that
   *structurally* prevents marketing-page bundle creep — every other option ships the full React
   runtime on every page (~70–120 KB gz floor before app code). Precedent: Open UI's Gatsby→Astro
   move cut homepage JS 2 MB → 63 KB.
2. **Proven static builds at our scale.** Astro 7 publishes 6,313 pages in 73 s / 8,431 pages in
   261 s; the streaming/queued build engine was designed for 10k+ pages. RR7's prerender at
   5–10k paths has open build-hang issues; Next export at scale is a known memory complaint.
3. **Migration distance from Gatsby.** File-based `src/pages/`, `getStaticPaths` ≈ `createPages`,
   an official migrate-from-Gatsby guide, and our page-creation code being pure JS make this the
   shortest path that still deletes GraphQL/webpack.
4. **Stewardship.** Astro's team was acquired by Cloudflare (Jan 2026) with public commitments to
   MIT + platform-agnosticism; #1 meta-framework satisfaction in State of JS 2025. Watch-item, not
   blocker (see risk register). Vike is disqualified on its license-key pivot; TanStack Start is
   still an RC with a bus factor of ~1; RR7's stable mode sits mid-transition to RSC while its
   founders build a non-React Remix 3.

**Version:** target **Astro 7.x** (current stable, June 2026; Vite 8 + Rolldown + Rust compiler).
Rationale: don't eat the 6→7 bundler migration mid-project. **Fallback pin: 6.3.x** (Vite 7) if the
spike surfaces Rolldown/worker edge cases. Budget one Astro major upgrade per year.

**React:** stay on **React 18.3.1** for the migration (`@astrojs/react` peers `^17 || ^18 || ^19`).
Do not couple the rewrite to a React 19 upgrade; do it after, when it unlocks Actions/`useActionState`
if wanted.

### 3.2 The architecture that makes it work ("option f1")

A single Astro project, three tiers:

1. **Public site** — `.astro` pages, zero JS + small islands (donation form, map accordion).
2. **`/learn` challenge experience** — `getStaticPaths` (ported from `challenge-page-creator.js`)
   emits a **thin prerendered HTML shell per challenge**: correct per-URL `<title>/<meta>`/canonical
   and an SEO copy of the challenge description, mounting **one `client:only="react"` workspace
   app** that owns client-side routing between challenges (TanStack Router or React Router in
   library mode — pick in spike). Redux, sagas, Monaco, xterm, i18next, completion flow move over
   **unchanged** inside this island. The shell→island handoff is specified in §4.1.
3. **Authed client-only surfaces** (settings, profile, certification, …) — prerendered empty shells
   + `client:only` islands wrapping the existing `client-only-routes/` components (they already
   take params as props and fetch from the API). Cheap, but not free: they are `connect()`-wired
   to the global store today — see the per-island store decision in §4.3.

The explicitly-evaluated alternative "f2" (fully separate Vite SPA for `/learn` behind the same
origin) was rejected as the default: it forfeits per-challenge static HTML/SEO or forces us to
rebuild `getStaticPaths` by hand, and doubles the 11-locale deploy matrix. f1 delivers ~90% of f2's
decoupling at ~40% of its operational cost, and extracting the island into f2 later is mechanical.

**Do not** build on Astro's `<ClientRouter>` and do not rely on `transition:persist` for
editor-state survival (verify the "persist can't carry Monaco + a live popup handle" hypothesis in
the spike for the record, then move on). Native cross-document view transitions may be used for
cosmetic polish only.

---

## 4. Target architecture

### 4.1 Data pipeline: replace the GraphQL projection with a "derive" step

Keep unchanged: the entire `@freecodecamp/curriculum` build, all six setup scripts,
`@freecodecamp/shared`, `challenge-builder`, `browser-scripts` artifacts, and the
`static/curriculum-data/v2` mobile-app contract.

Add one derive step (Node script or Astro content-layer custom loader — decide in spike) that
consumes `curriculum.json` **once** and emits:

1. **`curriculum-index`** (small, few MB): per-challenge
   `{slug, id, title, block, superBlock, chapter, module, challengeType, certification, order…}`
   in curriculum order + the 98 superblock structures + certificate test ids. This single typed
   module replaces **all four static queries** (`fetch-all-curriculum-data`, `time-line`,
   `missing-prerequisites`, `seo`), the `learn.tsx` and `super-block-intro` page queries, and the
   `curriculum-data.ts` singleton's init (that service is already a clean seam — consumers don't
   change).
2. **Per-slug challenge JSON** (one file per page, mirroring today's `page-data.json` granularity):
   template-specific fields + precomputed `challengeMeta` (next/prev slugs, `isFirstStep`,
   `projectPreview`) — the existing pure helpers (`createIdToNextPathMap`,
   `getProjectPreviewConfig`, `views`/`viewTypes` mapping) port verbatim. **Strip never-queried
   fields at derive time** (full `solutions`, `challengeFiles.seed/path/id`, `sourceLocation`, …).
3. The island fetches its challenge payload as a static JSON asset (same pattern as
   `page-data.json` today, and as `curriculum-data/v2` already proves) rather than inlining large
   seeds twice into the HTML. **Version-skew policy (required):** deploys replace tarballs on the
   serve VMs non-atomically and learners keep the workspace open for hours — Gatsby has
   loader-level page-data mismatch handling today, and the replacement needs one. Version the
   derive output (build-hash path segment, mirroring the existing `/js/test-runner/<version>/`
   pattern) **or** define a stale-app rule: on JSON 404 / schema-version mismatch, hard-reload the
   current URL. Add a skew test to §9 and a deploy-window error monitor to the rollout checklist.

**Shell→island handoff (specify, don't improvise):** a `client:only` island renders nothing at
build time, so the shell's SEO copy of the description lives in a static container that the island
removes (or adopts) on mount, plus a layout skeleton that bounds CLS while Monaco loads. Note the
shell's description is prose-only fidelity: Prism highlighting and MathJax typesetting are
client-side effects today, so shells on math superblocks show raw TeX until hydration unless math
is pre-rendered at build (§6.3 plans exactly that — sequence it with this work). "Shell→island
transition CLS" is a named spike-gate measurement and a §9 parity item.

Memory rule (hard-won from Astro issue archaeology): **never import the ~100 MB `curriculum.json`
at page-module scope**; `getStaticPaths` returns params + minimal props, pages read their per-slug
JSON lazily. Keep the mega-JSON out of dev-watched content collections. Consider having the
curriculum build emit per-superblock JSON to make both derive and dev-watch incremental — that
alone likely retires the 7 GB heap requirement.

**Dev watch (designed mechanism, not hand-waving):** per-slug JSON under `public/` is *not* in
Vite's module graph, so "rewrite the file" alone produces no HMR — a naive port would silently
regress curriculum-author DX from today's live hot-replace (`gatsby-source-challenges` chokidar
watcher). Deliverable: a small Vite plugin that watches derive output and emits a custom WS event
the workspace island listens to (re-fetch current slug), or dev-only serving of per-slug JSON
through a virtual module. Acceptance test: *edit a challenge `.md` → the open challenge updates
without manual reload.* Preserve today's semantics quirks: structure-file edits are not watched
(the plugin bluntly recreates structure nodes on any md change), and `projectPreview` means one
file change can invalidate every page in its block — block-level invalidation required.

### 4.2 Routing & layouts

- `src/pages/learn/[superBlock]/[block]/[challenge].astro` (challenge shells; template component
  chosen by `challengeType` → same `views` map), `learn/[superBlock]/index.astro` (intros),
  plain `.astro` files for static pages, `[maybeUser].astro` for profiles (verify route priority:
  it must lose to every static route), rest-param shells for the client-only surfaces.
- The pathname-regex `layout-selector.tsx` disappears: Astro layouts are chosen per page file;
  challenge chrome flags (`no footer`, multifile editor) become layout props.
- Legacy redirects (`/challenges/*` → `/learn/*` via `toLearnPath`, `/certification`, `/user`)
  move out of React entirely: Astro `redirects` config for the static ones + entries in
  `serve.json` (coordinate with `freeCodeCamp/client-config`) for the parameterized rewrites.
  Deletes four React pages and improves legacy-link UX (no JS round-trip).
- `trailingSlash: 'ignore'` maps 1:1.
- Head/theme: `html.tsx` + `utils/tags.tsx` (og/twitter meta, webmanifest links, pre-paint theme
  script, conditional MathJax, RTL `dir`, `tex2jax_ignore`) collapse into ~60 lines of one base
  `.astro` layout with an `is:inline` theme script. Render `lang`/`dir` **statically and
  correctly** per locale (fixes the hardcoded `lang='en'` + post-mount Helmet patch).
- The vestigial `onPreRenderHTML` bootstrap-reorder hook (`gatsby-ssr.tsx:46–66`) targets keys
  nothing emits — do not port. Ship a self-destroying `sw.js` at the same URL to keep the legacy
  service-worker cleanup behavior (`gatsby-plugin-remove-serviceworker`'s job); do **not** touch
  `static/python-input-sw.js`.

### 4.3 State architecture

**Verdict from the audit: do not keep a global Redux Provider.** But be precise about what that
means per tier — the client-only components are `connect()`-wired to the global store today, so
"components move unchanged" requires a store to exist wherever they mount:

- **Workspace island (`/learn/**`, one `client:only` React app):** keeps Redux + redux-saga
  wholesale (challenge slice, execute/completion/code-storage/current-challenge/ask-socrates
  logic). Its internal router owns step-to-step navigation — preserving the preview portal
  (`window.open` handle in Redux), Monaco models, warm pyodide worker, and `isAdvancing` UX.
  In-block navigation is client-side; cross-superblock exits are real page loads. The 6
  redux-observable epics port to sagas/RTK listeners → **rxjs 6 and redux-observable are deleted**.
- **Authed islands (settings, profile, certification, report-user, …): per-island store factory.**
  Each mounts a small Redux store composed of exactly the slices + sagas it needs (`user`, `flash`,
  `settings`/profile fetch logic), seeded from the shared session module. This is what lets the
  existing `connect()`-ed components move with minimal edits; rewriting them against the nanostore
  bridge is the *later* cleanup (Phase 6), not a migration prerequisite. Superblock intro pages
  need the same treatment (progress checkmarks + DonateModal are store-connected).
- **App-level epics disposition (explicit, because confining Redux would silently change
  behavior):** `failed-updates-epic`'s queue-flushing moves into the shared session module so
  failed submissions still flush on *any* page, not just `/learn`; `update-complete-epic` folds
  into the same module; `hard-go-to-epic` is a one-line `window.location` helper.
- **Header/nav island (every page):** session menu, theme toggle, exam-mode nav swap, lazy search.
- **Flash/toast island (every page):** consumes the existing `?messages=` API contract (already
  MPA-friendly), plus a sessionStorage handoff for post-redirect flash, plus direct island calls.
  Must implement proper live-region semantics (§9 a11y).
- **Shared bridge:** nanostores (Astro's documented pattern, <1 KB) for the cross-island scraps.
  **Session module & cache — minimal and PII-free:** fetch `/user/session-user` once per page
  load; cache **only** `{isSignedIn, username, picture, theme, examInProgress}` in sessionStorage
  with a short TTL; keep the full session-user object (email, about, portfolio, saved code — it's
  heavy PII) in per-page memory only. Purge the cache on the `signin`/`signout` hard handoffs and
  on any API 401; revalidate on `visibilitychange`; use BroadcastChannel for cross-tab sign-out
  coherence. Rationale: web storage is readable by learner code running in the same-origin preview
  frames (§6.1) — nothing sensitive may rest there. Static pages **stop gating render on the user
  fetch** (today every page white-screens behind a loader until the session resolves); render
  static content immediately and hydrate progress/user affordances progressively.
- **CSRF:** revisit the erase-cookie-on-every-load workaround (`gatsby-browser.tsx:45–50`) with the
  API team — in an MPA it multiplies the 403-retry race. The session module is the right home for
  whatever the fix is.
- **Stripe:** `loadStripe` + `<Elements>` move from the app root to the five donation surfaces
  (donate, supporters, update-stripe-card, DonateModal, cert-challenge). Stripe.js stops loading
  on every page of the site.
- **GrowthBook:** initialize in the session module; expose via the nanostore bridge instead of a
  root React provider. **Reproduce the `trackingCallback` → GA `experiment_viewed` link**
  (`growth-book-wrapper.tsx:79–87`) and the attribute set (staff, joinDateUnix,
  completedChallengesLength, signedIn) or all experiment exposure data disappears. Enumerate the
  ~12 feature-check sites in the ADR. Experiment integrity across the staged rollout is a Phase 5
  gate (§7).
- **Settings sagas → plain async handlers + flash calls** inside the settings island (they are
  thin call/put wrappers). `danger-zone-saga`'s `take(routeUpdated)` sequencing must be redesigned
  (it depends on a Gatsby browser API).

### 4.4 Monaco / workers / test-runner (the toolchain-coupled 5%)

- Monaco 0.55 is already ESM-era (AMD deprecated since 0.53). Replace
  `monaco-editor-webpack-plugin` with the zero-plugin Vite pattern:
  `self.MonacoEnvironment = { getWorker }` + `?worker` imports of exactly the editor/html/css/json/ts
  workers we need (also trims unused language workers). The top-level `monaco-editor` imports in
  `classic/show.tsx:10` and `editor.tsx:15` (`OS` is a runtime value, not a type) are moot in this
  architecture — both files live inside a `client:only` island that is never server-rendered.
  Import `editor.main.css` explicitly in the island (known Astro + client:only CSS pitfall).
  Workers must stay same-origin.
- Swap `react-monaco-editor` (webpack-era) for `@monaco-editor/react` or a thin manual wrapper.
- `@freecodecamp/browser-scripts` (pyodide/sass/TS workers + test-runner copying) **keeps its own
  webpack build initially** — the client only consumes its dist by URL. Converting it to Vite
  worker builds is a post-migration cleanup, not a migration dependency.
- **The test runner is `@freecodecamp/curriculum-helpers` — an external package injected into the
  parent page** (`frame.ts:222–258`), not code in this repo. It is the security-critical component
  of the whole workspace: add an explicit audit task (evaluator isolation model, iframe/worker
  usage) and see §5.3 for its supply-chain quarantine exemption.
- Byte-for-byte URL contracts preserved in `public/`: `/js/test-runner/<version>/…`,
  `/js/workers/<version>/…`, `/python-input-sw.js` ([Appendix B](#appendix-b-contracts-that-must-survive)).

### 4.5 i18n & per-locale builds

Keep the proven **one-build-per-locale** model (11-job matrix, 22 VMs, tarball deploys) and change
only the build step:

- `base: clientLocale === 'english' ? undefined : '/' + clientLocale` in `astro.config.ts`
  (which is TypeScript — it reads `config/env.json` directly). `--prefix-paths` dies.
- **Skip Astro's i18n routing entirely** — it solves a problem (multi-locale in one build) we
  don't have. i18next + react-i18next run unmodified inside islands; `.astro` shells call
  `i18next.t()` at build time (init i18next in server code with the same resources).
- Replace `babel-plugin-preval` locale inlining (2 sites) with a generated
  `i18n/resources.<locale>.ts` barrel emitted by the existing `create:i18n` step, or a ~20-line
  Vite virtual module keyed on `CLIENT_LOCALE`. This is what unblocks deleting the whole babel
  chain.
- Discipline for base paths — with a critical caveat: Astro never auto-prefixes links. Keep the
  single `Link` helper (`components/helpers/link.tsx` — already the only Gatsby `Link` import
  site, ~30 consumers untouched) and a `withBase()` util, and lint against raw absolute hrefs —
  **but encode the three deliberate exceptions**: test-runner assets are locale-prefixed
  (`frame.ts:91`), the python worker URL is root-absolute with NO prefix
  (`python-worker-handler.ts:4`), and `/python-input-sw.js` must stay root-scoped for SW scope
  reasons (`xterm.tsx:13`). A uniform `withBase()` sweep would silently break python challenges on
  non-English locales.
- Render `lang`/`dir` statically; gate Japanese font preloads per locale; drop the dead
  Arabic fonts + unconditionally-imported `rtl-layout.css` unless RTL returns (161 lines +
  font files shipped to every user today for an empty `rtlLangs` array).
- **Crowdin:** point `crowdin-upload.client-ui.yml` at the new package's string sources during the
  parallel build (coordinate with the recent i18n-files-to-common-folder refactor), and treat
  translation round-trip latency as a real dependency of every non-English cutover (§7 Phase 5).

### 4.6 `@freecodecamp/ui`

Works in Astro islands and `.astro` server rendering **with zero changes** (audit verified all 24
used components; no module-scope browser access; headlessui/radix are SSR-safe). Actions, ordered:

1. **Now:** bump client 6.0.1 → 6.1.0 (removes sanitize-html/htmlparser2/postcss from the shipped
   browser bundle — ui commit `b4d871f`); move `babel-plugin-prismjs` to devDependencies (packaging
   bug — every consumer installs a babel plugin today).
2. **During migration:** mind the dual-package hazard (no `exports` map; CJS on server, ESM in
   browser) — set `vite.ssr.noExternal: ['@freecodecamp/ui']` or add an exports map that preserves
   the load-bearing `./dist/base.css` deep import. Reproduce the pre-paint theme-class script and
   CSS cascade order (`base.css` before client overrides) exactly.
3. **Post-migration:** repackage ESM-only with `exports` + `sideEffects` + `preserveModules`
   (today one `Spacer` import evaluates the whole flat bundle incl. Prism grammars); replace the 7
   fontawesome icons with inline SVGs (drops 3 runtime deps); Tailwind v4 (theme is already 100%
   CSS custom properties) — and optionally let the new client consume ui's Tailwind config as a
   real preset, retiring the hand-written Bootstrap-grid overrides in `global.css`.
4. Retire high-volume shim components opportunistically during page rewrites: `Spacer` (99 import
   sites), `Row`/`Col` (Bootstrap-3 grid re-implementation) → gap/grid utilities.

---

## 5. Dependency cut list & attack-surface reduction

### 5.1 By category (143 direct entries)

| Category | Count | Disposition |
|---|---|---|
| **A. Gatsby/webpack/babel scaffolding** (gatsby×7 plugins, gatsby, gatsby-cli, reach-router, react-helmet, loadable, babel×10, webpack, monaco-webpack-plugin, core-js, …) | 31 | Dies with the migration. 2 deletable **today** (eslint-config-react-app, eslint-plugin-flowtype — unused) |
| **B. Node-polyfill shims** (assert, crypto-browserify, path-browserify, stream-browserify, process, util, url, +Buffer) | 7 | Delete with webpack config — grep proves no source uses node builtins; last transitive consumer (sanitize-html) is being replaced anyway |
| **C. Legacy/unmaintained/duplicated** | ~50 | Replace per table below; 8 deletable today with zero code change (+1 with a one-line `.babelrc.js` edit) |
| **D. Keepers** (react, monaco, xterm, i18next family, stripe, algolia, growthbook, sandpack, tone, @freecodecamp/*, fontawesome, date-fns, vitest, …) | ~45 | Port as islands; upgrade stale majors (stripe ×2, algolia v4→v5, redux 4→RTK/redux 5) during rewrite |

### 5.2 Category-C highlights (replacement → usage sites)

| Package | Sites | Replacement |
|---|---|---|
| `store@2` (dead since ~2017; **load-bearing user data**) | 27 files | 20-line localStorage wrapper — **must keep exact key/format compatibility** (in-progress code for millions of users: challenge code keys incl. legacy `Bonfire:`/`Waypoint:` prefixes, `fcc-failed-updates`, `fcc-sound`, `challenge-layout`, `fcc-current-challenge`) |
| `redux-observable@1.2` + `rxjs@6` | 6 epics | Port to sagas/RTK listeners (app-level epics → session module, §4.3); delete both |
| `redux-actions` | 8 files | RTK `createSlice` (already installed) |
| `react-helmet` (dead) | 34 files (incl. tests) | `.astro` heads for static; `document.title`/`@unhead/react` inside islands |
| `react-hotkeys@2` (dead) | 5 | `react-hotkeys-hook` or plain keydown |
| `react-spinkit` (dead 2018) | 5 | CSS spinner (candidate for @freecodecamp/ui) |
| `react-tooltip@4` | 1 | CSS/floating-ui |
| `react-reflex` | 4 (core challenge layout) | `react-resizable-panels` |
| `react-scroll` | 8 | `scrollIntoView` + CSS `scroll-margin` |
| `react-responsive` | 6 | 10-line `matchMedia` hook |
| `final-form` + `react-final-form` | 2 | react-hook-form or controlled forms |
| `react-youtube` | 2 | lite-youtube-embed (privacy + perf win) |
| `sanitize-html` | 2 | DOMPurify **configured with the same tight allowlist** (§6.1) — kills the last node-polyfill consumer |
| `react-gtm-module` | 1 | inline GTM snippet in layout, or Partytown |
| dual `lodash` + `lodash-es` | 3 + 26 | standardize lodash-es or natives |
| one-liners: `uuid`→`crypto.randomUUID`, `nanoid`→same, `query-string`→`URLSearchParams`, `browser-cookies`→`document.cookie`, `bezier-easing`→CSS, `date-fns-tz`→`Intl`, `normalize-url`→`new URL()` | 1–3 each | natives |

### 5.3 Supply-chain wins (and one exposure to fix)

- Runtime closure **1,841 → ~243 app packages** (+ Astro/Vite baseline, estimated 150–300) ⇒
  **~400–550 total, a ~70% cut**. (Baseline is an estimate — measure with a spike install before
  putting numbers in the ADR.)
- `pnpm.onlyBuiltDependencies` allowlist shrinks 10 → 7 (drop gatsby, lmdb, msgpackr-extract).
- `babel-plugin-preval` (arbitrary node exec embedded in source files at build) and dormant
  `babel-plugin-macros` are eliminated entirely.
- Build-time code execution shrinks from the 1,454-package Gatsby subtree to the Astro/Vite
  toolchain (~1/5 the size).
- ⚠ **`minimumReleaseAge` has one exclusion, and it's the worst possible one:**
  `pnpm-workspace.yaml` quarantines all new releases for 7 days **except
  `@freecodecamp/curriculum-helpers`** — which is precisely the test-runner bundle that executes
  learner code in every user's browser on every challenge view. Treat during migration: remove the
  exclusion or pin exact versions with a human-review gate on bumps, and add a CI byte-diff check
  on the published test-runner bundle alongside the Appendix B URL contract.

---

## 6. Security posture changes

*(Summarized from the dedicated security deep-dive plus an adversarial security review of this
plan; items marked ⚠ are pre-existing issues the rewrite must not silently carry over.)*

### 6.1 Untrusted-content findings

- ⚠ **Crowdin i18n HTML injection — the highest-value finding.** Community-translated strings are
  rendered as raw HTML with no sanitization: `block-intros.tsx:7` and `super-block-intro.tsx:192`
  inject `intro:` namespace strings via `dangerouslySetInnerHTML`, i18next runs with
  `escapeValue: false` (`i18n/config.js:80–82`), and the strings legitimately contain HTML. A
  malicious or compromised Crowdin translation is an XSS vector today. Fix: sanitize i18n HTML at
  render (or at build for the static shells).
- ⚠ **The one true sanitization bug (user-code-reachable):** `classic/lower-jaw.tsx:154` injects
  hint HTML unsanitized, and the hint text interpolates `--fcc-actual--`/expected values derived
  from learner code (`execute-challenge-saga.js:217–219`) — while sibling
  `independent-lower-jaw.tsx:173–181` sanitizes the same data. Fix in Phase 0.
  *Scoping note from adversarial review:* `test-suite.tsx:62` injects curriculum-authored test
  text — same build-time trust domain as descriptions, so it's defense-in-depth, not a bug; and
  micromark in `exam/show.tsx` is safe-by-default (escapes raw HTML) — keep a lint/comment guard
  so nobody adds `allowDangerousHtml` later.
- **DOMPurify migration trap:** today's `sanitize-html` calls use a tight allowlist
  (`['b','i','em','strong','code','wbr']`). DOMPurify's *default* config allows far more
  (`<a href>`, `<img src>`, …) — a naive swap silently **widens** what user-code-derived hint text
  may render. Configure `ALLOWED_TAGS` to match, with a regression test asserting `<a>`/`<img>`
  are stripped from hint HTML.
- ⚠ **Stored click-to-XSS on profiles:** portfolio `url`/`image` are stored as arbitrary strings
  (`api update-my-portfolio` schema is plain `Type.String()`) and rendered on *other users'*
  public profiles as `<a href={url}>`/`<img src={image}>` (`portfolio-projects.tsx:95,104`) —
  React only console-warns on `javascript:` hrefs, it still renders them. Fix requires the API
  team: server-side scheme validation (https/http only) + a data-cleanup pass for existing
  records, plus client-side scheme guarding at render. Same guard for social-icon hrefs. (Also
  constrains CSP `img-src` — user-supplied image origins mean broad `img-src` or an image proxy.)
- ⚠ **Challenge preview iframes are same-origin `srcdoc` with no `sandbox` attribute**
  (`frame.ts:263–275`) — learner code can reach `window.parent` at the app origin, which also
  means *anything in web storage is readable by pasted code* (the §4.3 session-cache design
  accounts for this). The **test** execution path is different from what it looks like: frame.ts
  builds *preview* frames, while tests run via `window.FCCTestRunner` from the external
  `@freecodecamp/curriculum-helpers` bundle loaded into the parent page — that package needs its
  own isolation audit (§4.4). True runner isolation (dedicated sandbox origin + postMessage) is a
  real refactor: the current design depends on same-origin `contentDocument` access (scroll
  manager, console proxy, i18next injection — see Appendix B.1). **Decision needed:** scope
  origin-isolation in as a companion project, or explicitly out
  ([open question #2](#11-open-questions-for-the-team)). Either way the migration must preserve
  the invariants in [Appendix B.1](#b1-code-execution-sandbox-invariants-preserve-exactly) exactly.

### 6.2 CSP & script-integrity plan (per route class — not one policy)

A single strict site-wide CSP is **structurally impossible** today: `srcdoc` iframes inherit the
embedding page's CSP, and on `/learn` pages those frames must run learner-authored inline
script plus `@babel/standalone`'s `new Function` transpilation. Plan accordingly:

- **Public/static tier:** strict **hash-based** CSP (fCC serves cached static files, so
  per-request nonces are off the table; Astro ≥6's stable `security.csp` is hash-based for
  exactly this reason). Externalize or hash the pre-paint theme script (`tags.tsx:66–97`) —
  spike task: verify Astro actually hashes hand-authored `is:inline` scripts (they typically need
  manual hash entries). Delivered via path-scoped headers in serve.json.
- **`/learn/**`:** an explicitly documented permissive `script-src` (or none) until/unless
  runner-origin isolation ships. Do not pretend otherwise in the ADR.
- **GTM caps the whole exercise:** GTM's remote-config/Custom-HTML injection makes any CSP that
  allowlists it largely symbolic on pages that carry it. This is a product/analytics decision
  ([open question #3](#11-open-questions-for-the-team)): accept the cap, move analytics
  server-side, or Partytown (community-maintained fork since April 2026).
- **SRI + self-hosting:** add `integrity`/`crossorigin` to `scriptLoader` and to the legacy
  curriculum CDN scripts that `challenge-builder/builders.ts:24–27` injects into preview frames
  (pinned jQuery 3.6.0 / D3 5.7.0 / React 16.4 UMD / Bootstrap 3.3.7 from cdnjs &
  code.jquery.com); **self-host Pyodide** (today fetched from cdn.jsdelivr.net inside the
  code-execution path with no integrity check — the worker source carries a "TODO: host this
  ourselves").
- **Harden client-set cookies:** `isDonor` (`donation-saga.js:189` — no flags at all) and `gbuuid`
  (GrowthBook, no `Secure`/`SameSite`) get `Secure; SameSite=Lax`. The session JWT is already
  `httpOnly` server-set; no tokens live in localStorage (verified — only prefs + challenge code).
- **No COOP/COEP headers may be added via serve.json without testing** the preview portal
  (`window.open` handle) and pyodide worker flows — they are cross-window-communication dependent.

### 6.3 Third-party runtime script/origin inventory (today → plan)

| Origin | Purpose | Plan |
|---|---|---|
| googletagmanager.com (+GA) | analytics container = remote-config script injection | Policy decision (§6.2); load per-consent |
| cdnjs.cloudflare.com — **MathJax 2.7.4 (2018)** | math on 7 superblocks (challenge pages only) | **Delete**: pre-render math at build (KaTeX or MathJax 3 SSR) — script-surface and shell-fidelity win (§4.1) |
| cdn.jsdelivr.net — **Pyodide** | python challenges (inside worker) | **Self-host** + versioned path (existing TODO in code) |
| cdnjs / code.jquery.com | legacy curriculum `required` scripts injected into preview frame | Keep (curriculum contract) + SRI + frame-scoped policy |
| js.stripe.com | payments | Scope to donation islands only (today it loads on every page) |
| paypal.com/sdk | donations | Already lazy; keep scoped |
| YouTube iframe API | video challenges | lite-youtube nocookie embed |
| tonejs.github.io + campfire-mode.freecodecamp.org | `playTone` audio | Self-host on our CDN |
| cdn.freecodecamp.org | meta/social images, scene assets, cert images | Keep; enumerate in CSP |
| user-supplied origins | portfolio images, avatars on public profiles | scheme-guard (§6.1); broad `img-src` or image proxy — decide in ADR |
| Algolia, GrowthBook API, codesandbox CDN (sandpack) | search, flags, review-challenge editor | Keep; enumerate in CSP; evaluate replacing sandpack with in-house monaco+iframe post-migration |
| error-tracking origin (new, §7 Phase 2) | observability | add to allowlist when chosen |
| $ilp.uphold.com | Web-Monetization meta pointer | Keep (meta only) |

**Build-time inputs** (baked into every page of every locale, so they're part of the trust
surface): `create:trending` fetches YAML from cdn.freecodecamp.org — today guarded by js-yaml safe
load + a Joi schema forcing https URIs (`tools/schema/trending-schema.ts`); carry that guard
forward verbatim. The `i18n-curriculum` submodule (Crowdin-fed) becomes build-time `set:html`
under this plan — which is exactly why §6.1's sanitize-at-derive matters. `curriculum.json` is
PR-reviewed first-party content.

### 6.4 Structural improvements that come free

- ≈19k pages stop shipping a JS-bootstrapped app shell; islands make every third-party script
  opt-in per page instead of "wrapped around the root".
- `dangerouslySetInnerHTML` surface shrinks from 12 production sites to the genuinely-dynamic
  feedback paths (test output, hints) — static curriculum HTML becomes build-time-sanitized
  `set:html`.
- No more GraphQL/LMDB/webpack executing in the build; `babel-plugin-preval` (arbitrary Node
  exec at build, and the compile path by which Crowdin JSON reaches the bundle) is deleted; the
  install-script allowlist shrinks 10 → 7; lockfile closure −70%.
- **CSRF gotcha, not an improvement:** the erase-`csrf_token`-on-every-page-load workaround
  (`gatsby-browser.tsx:45–50`) has no Astro lifecycle equivalent and must be deliberately
  reimplemented (or, better, retired in agreement with the API team) — silently dropping it
  changes token-refresh behavior; keeping it naively multiplies the existing 403-retry race
  across MPA navigations.

---

## 7. Migration strategy & phases

The strategy is **parallel build, per-route-class parity, single cutover per locale** — not an
in-place strangler (Gatsby and Astro can't share a runtime, and the serving layer is a static file
server, so "both at once" would mean double builds across 11 locales for the whole migration).
The Playwright suite is the acceptance gate throughout.

### Phase 7.0 — Drift management (a standing policy, not a phase)

`client/` merges ~1–1.5 commits/day. Without a policy, every merged PR silently invalidates
already-achieved parity in the new package. Adopt from day one of Phase 2:

- **Dual-landing rule, phased in per route class:** once a route class reaches parity, any PR
  touching its behavior in `client/` must carry a counterpart change in the new package (or a
  tracked follow-up issue labeled `astro-port`). CI can enforce via path-based labeling.
- **Drift ledger:** a living document (or label query) of client/ commits since each route class
  was ported; auditing it to zero is a **Phase 5 exit criterion per locale**.
- **Freeze windows:** a hard string-and-behavior freeze for N weeks before each locale cutover
  (string freeze must also precede the Crowdin round-trip for non-English locales).
- **Contributor guidance:** a pinned discussion/`contributing` note saying which tree to PR
  against and when, updated as route classes flip. Community PRs against frozen areas get a
  standard maintainer reply + the `astro-port` label.
- **Cost:** this is a tax on the whole calendar (~10–15% of team time from Phase 3 onward),
  budgeted in §10.

### Phase 0 — Pre-migration hardening (land on Gatsby now; every item is independently shippable)

Goal: shrink the diff the real migration has to carry, and bank easy wins regardless of timeline.

1. Delete the 10 zero-code-change deps + `babel-plugin-macros` with its one-line `.babelrc.js`
   edit (§2.5). Realistic immediate win: **~120–130 locked packages** (the big number arrives when
   Gatsby goes).
2. Bump `@freecodecamp/ui` → 6.1.0; move `babel-plugin-prismjs` to devDeps in ui.
3. **Introduce the router adapter seam:** `src/utils/router.ts` wrapping `Link`/`navigate`/
   `withPrefix`; point the 31 gatsby-importing files at it (checklist = the §1 file inventory);
   swap test mocks from `vi.mock('gatsby')` to the adapter. Makes the framework swap a one-file
   change for the ~109 test files.
4. Fix the ⚠ sanitization items (§6.1): the lower-jaw hint path (real bug), the Crowdin i18n
   injection paths, and — with the API team — portfolio URL scheme validation + data cleanup.
   These are bugs today, not migration work.
5. Kill dual lodash; do the one-liner native replacements (uuid, nanoid, query-string,
   browser-cookies, bezier-easing, date-fns-tz, normalize-url).
6. Obtain and vendor a copy of `client-config/serve.json` into the migration planning docs;
   audit its redirects/headers (the real routing table).
7. Optional but high-value: have `@freecodecamp/curriculum` emit per-superblock JSON alongside
   the monolith (framework-neutral; benefits Gatsby dev too).

**Exit criteria:** CI green, e2e green, lockfile smaller by the measured ~120–130 packages, zero
user-visible change.

### Phase 1 — De-risking spike (timeboxed; go/no-go gate with a named decision owner)

Build a throwaway-quality but real-data prototype answering exactly the questions that could
change the plan:

1. Astro 7 skeleton in a new workspace package (`client-next/` — name TBD) with per-locale `base`,
   the base layout (head/theme/fonts/manifest), and `config/env.json` wiring.
2. Derive step over the **full real `curriculum.json`** → index + per-slug JSON. Measure: derive
   time, build time for all ≈19k shell pages (also settles the exact page count), peak RSS,
   dev-server start + HMR latency. **Gate: build ≤ current Gatsby time on default heap; dev
   server usable.**
3. One classic challenge end-to-end inside the workspace-island pattern: Monaco via Vite workers,
   test-runner from `public/js`, xterm + pyodide + `python-input-sw.js`, code persistence,
   completion → island-internal route to next challenge, preview portal surviving the transition.
   Measure shell→island CLS; verify keyboard/screen-reader route announcement inside the island.
   **Gate: all runner types execute; editor state survives next-challenge nav; CLS bounded.**
4. Router bake-off inside the island (TanStack Router vs React Router library mode) — pick one.
   For the record, verify the `transition:persist` hypothesis (§3.2) and document it in the ADR.
5. e2e smoke: run the relevant Playwright specs against the spike (`serve -l 8000` + serve.json).
6. Measure the real Astro dependency baseline (`pnpm install` closure count) and Vite
   `build.target` implications against the chosen browser-support floor (§11 Q9 — pull the
   browser/OS distribution for `/learn` traffic from GA first).
7. Verify Astro's CSP hashes the hand-authored theme `is:inline` script (§6.2).

**Exit criteria:** every gate green, written ADR (framework pin, router choice, derive-step
design, browser floor, page count, dependency baseline — with sources for ecosystem claims), and
a demo the team has clicked through. **A named owner (or small review group) makes the go/no-go
call.**

### Phase 2 — Foundation

- Project scaffolding graduates from spike to real package: lint/tsconfig/vitest (via
  `getViteConfig`), turbo tasks mirroring `setup → build`, CI job building English.
- Derive step productionized (typed outputs, block-level invalidation, **the dev-watch WS/virtual-
  module mechanism from §4.1 with its edit-md-see-update acceptance test**, version-skew policy).
- i18n resources module generation added to `create:i18n`; i18next init for `.astro` server code
  and for islands; **point the Crowdin upload workflow at the new string sources**.
- nanostores bridge + session module (minimal non-PII cache, purge/revalidation rules, CSRF
  strategy agreed with API team, failed-updates queue flushing).
- **Observability workstream:** the client has **no error tracking today** — choose a tool,
  instrument the islands, add its origin to §6.3/CSP, define per-locale error-rate thresholds
  that gate each cutover. Instrument the *current* Gatsby client first to get a baseline.
- Base layout complete: theme pre-paint script, webmanifest, og/twitter meta from i18n,
  `lang`/`dir` static, self-destroying legacy `sw.js`, font preloads per locale.
- Header/Footer/Flash islands working on a sample page (flash = proper live region).

### Phase 3 — Static pages & client-only shells (broad, parallelizable)

- Static tier: `/`, `/learn` (map), `/learn/archive`, `/catalog`, `/blocked`, `/404`, `/donate`,
  `/supporters`, `/email-sign-up`, `/update-stripe-card`, `/unsubscribed*`, daily-challenge
  archive page. Static copy drops React where free; donation islands mount their own `<Elements>`.
- Client-only tier — settings, profile `[maybeUser]`, certification, report-user, update-email,
  `/status/version` — using the **per-island store factory** (§4.3). Components move with minimal
  edits, but this tier is **M, not S**: store composition + saga wiring + guard/redirect flows
  per island. (The daily coding challenge is *not* in this tier — it needs the Phase 4 island.)
- Superblock intro pages with **scoped** per-superblock data (kills the ×98 all-nodes duplication)
  and their own store instance for progress + DonateModal.
- Redirect routes → Astro redirects + serve.json entries; delete the four redirect React pages.
- Landing-page GrowthBook gate redesigned so the prerendered page doesn't reintroduce a
  client-side loader wall.
- Analytics parity per route class: virtual pageviews and the `call-ga.ts` event catalog verified
  against a staging GTM container (§9).

### Phase 4 — The `/learn` workspace island (the crown jewel; longest single workstream)

- Island app shell: internal router (with route announcements + focus management — reach-router's
  built-in announcer disappears), route table for all 11 challenge view types, layout chrome
  (no-footer header variant, exam nav swap via the bridge).
- Redux store confined to the island; port the challenge epics to sagas/listeners; delete
  rxjs/redux-observable; keep localStorage keys byte-compatible.
- Completion flow: next/prev from `challengeMeta`, island-internal navigation, `isAdvancing`,
  preview portal, next-challenge JSON prefetch (parity with today's single `preloadPage` call —
  core prefetching is otherwise disabled).
- Island router emits pageview/history events so GTM triggers keyed to history changes keep
  working for challenge→challenge navigation.
- Monaco/xterm/pyodide/test-runner integration hardened from spike code; exam mode; quiz;
  fill-in-the-blank; projects; ms-trophy; codeally; exam-download.
- **Daily coding challenge** as a runtime-data route inside the island (pattern exists today).

### Phase 5 — i18n scale-out, e2e parity, cutover

- All 11 locales building in a CI matrix; visual-diff the Japanese font stack and one RTL dry-run.
- Full Playwright suite green against Astro builds per locale (rewrite the 2 `page-data.json`
  interception specs against the per-slug JSON seam; keep `serve@13 + serve.json` in CI so
  `redirect.spec.ts` stays meaningful). **The `e2e-third-party.yml` real-money donation suite
  (Stripe/PayPal/Patreon) green against the Astro build is a hard cutover gate.**
- **Translation gate:** string freeze → Crowdin round-trip → per-locale translation-coverage
  check before any non-English cutover.
- **Experiment integrity:** pause/conclude GrowthBook experiments per locale before its cutover,
  or add a `client_version` attribute so analyses can segment mixed traffic.
- Deploy pipeline: same 11-job matrix, tar `dist/` instead of `client/public`, same VM fleet —
  coordinate the output-dir rename and any serve.json changes with `client-config`.
- CI/tooling deliverable: update every workflow that builds/tests the client
  (`node.js-tests.yml`, `e2e-playwright.yml`, `i18n-validate-*`, `e2e-third-party.yml`),
  devcontainer/docker dev environments, and coordinate the **freeCodeCamp/contribute** docs repo
  update (third external repo alongside client-config and ui).
- Staged rollout: staging (`.dev`) all locales → production with **the first locale chosen for
  low traffic AND complete translations** → monitor (error rates vs. the Phase-2 baseline, Core
  Web Vitals, challenge-completion funnel, **donation conversion + donation-event volume with
  rollback thresholds**, support channels; annotate analytics dashboards at each cutover since
  session semantics change) → English last, scheduled to avoid active fundraising campaigns.
  Rollback = redeploy the previous Gatsby tarball (keep the Gatsby build runnable until English
  has soaked). Drift ledger audited to zero per locale before its cutover.
- Delete the Gatsby client + category-A/B deps; unregister-SW shim stays for several months.

### Phase 6 — Post-migration cleanups (backlog, prioritized)

- Redux modernization (redux-actions → RTK slices; redux 4 → 5 / react-redux 9; authed islands
  from store-factory to lighter state), remaining category-C swaps (reflex → resizable-panels,
  final-form → RHF, helmet leftovers, react-hotkeys…).
- `@freecodecamp/ui` repackaging (ESM-only, exports map, preserveModules) + Tailwind v4 + client
  adopts ui preset; retire Spacer/Row/Col shims page-by-page.
- `browser-scripts` webpack → Vite worker builds (completes webpack removal from the monorepo).
- KaTeX/MathJax-3 build-time math (delete cdnjs script); self-host Pyodide + tone assets;
  lite-youtube.
- CSP enablement + tightening cycle with client-config; curriculum-helpers quarantine fix if not
  already done (§5.3).
- Evaluate sandpack replacement with in-house monaco+iframe; evaluate algolia-lite navbar search.
- React 19, Astro major-upgrade cadence (budget one per year).

---

## 8. Risk register

| # | Risk | Severity | Mitigation |
|---|---|---|---|
| 1 | **Workspace island built wrong** → MPA nav between challenges resets Monaco/Redux/pyodide/preview-portal; product regresses vs today | Critical | Architecture locked in §3.2/§4.3; spike gate #3 proves it before commitment; hotkeys/completion/portal test cases in e2e |
| 2 | **Migration drift** — ~1–1.5 client commits/day × 4–6 months invalidates parity or gets lost at cutover | Critical | §7.0 policy: dual-landing rule, drift ledger as per-locale exit criterion, freeze windows, contributor guidance; costed in §10 |
| 3 | **Monaco worker wiring under Vite** (no in-repo precedent; webpack plugin does everything today) | High | Spike gate #3; zero-plugin ESM pattern documented upstream; fallback community plugin; test built output not just dev |
| 4 | **Dev-server/build memory with ~100 MB curriculum JSON** (documented Astro pain class at this scale) | High | Derive-step design (never page-module scope; per-slug JSON; per-superblock source split); spike gate #2 measures with full real data |
| 5 | **serve.json is external** (client-config repo + VM-resident) — unaudited redirects/headers could silently break | High | Phase-0 item 6: obtain/audit/vendor; keep `serve@13 + serve.json` in e2e CI so `redirect.spec.ts` guards it |
| 6 | **localStorage key compatibility** — challenge code for millions of users lives under `store@2` keys incl. legacy prefixes | High | Byte-compatible wrapper + dedicated regression tests; no key-format changes in the migration window |
| 7 | **Per-slug JSON version skew** — non-atomic VM deploys + hours-long sessions → 404s/schema drift mid-navigation | High | §4.1 versioned output or reload-on-skew policy; skew test in §9; deploy-window error monitor |
| 8 | **Per-page session fetch + loader gate** → naive port white-screens every navigation; CSRF-erase race multiplies | Medium-High | Session module (minimal cache, §4.3) + progressive hydration; CSRF strategy agreed with API team early |
| 9 | **No observability for rollout gates** — client has zero error tracking today | Medium-High | Phase-2 workstream; baseline the Gatsby client first; thresholds gate each locale cutover |
| 10 | **Analytics/experiment discontinuity** — GTM triggers, 13 GA event families, GrowthBook exposure tracking all change semantics under MPA + island routing | Medium-High | Analytics-continuity workstream (§7 Phases 3–5); island router emits history events; experiment pause/segment policy |
| 11 | **Node-polyfill removal breaks a transitive dep at runtime** (`process is not defined` class) | Medium | Bundle audit in spike; DOMPurify swap removes the known consumer; grep-verified no first-party usage |
| 12 | **Astro major cadence / Rolldown newness** (7.0 is weeks old; 6→7 was invasive) | Medium | Pin exactly; 6.3.x fallback decided at spike; budget one major/year; static HTML output keeps exit cost low |
| 13 | **Browser-support floor silently rises** (no browserslist today; Vite defaults are evergreen-modern; fCC's audience skews low-income/older devices) | Medium | §11 Q9: decide floor from GA data in spike; set `build.target`; add oldest supported browser to test matrix |
| 14 | **Curriculum-author DX regression** (bespoke chokidar hot-replace today) | Medium | §4.1 dev-watch mechanism is a named Phase-2 deliverable with an acceptance test |
| 15 | **i18n submodule / Crowdin timing** (non-English builds impossible without `i18n-curriculum`; new strings need translation round-trips) | Medium | Keep the whole `setup` chain; string freeze + coverage gate per locale (§7 Phase 5); Crowdin workflow re-pointed in Phase 2 |
| 16 | **Two-dialect friction for OSS contributors** (`.astro` + React) | Medium | Keep `.astro` files thin (shells/layouts only — all real UI stays React); contributor docs (freeCodeCamp/contribute update is a named deliverable); if it fails badly, f2/RR7 fallback documented in the ADR |
| 17 | **SEO regression on challenge pages** | Medium | Shells keep per-URL title/meta/canonical + description copy; staged rollout watches Search Console per locale |
| 18 | **Flash/exam/danger-zone flows silently depend on SPA store survival** | Medium | Enumerated in audit (5 sagas navigate-then-flash; `take(routeUpdated)`); each gets an explicit MPA-safe redesign (`?messages=`/sessionStorage/island-internal nav) |
| 19 | **Cloudflare stewardship drift** (static-build path could stagnate vs Workers) | Low-Medium | f1 keeps the island framework-portable; exit to RR7/Vite SPA is mechanical by design |
| 20 | **Mobile-app contract breakage** (`static/curriculum-data/v2`) | Low | Script is standalone; byte-compat check in CI; decouple its two client-tree imports |

---

## 9. Testing & acceptance strategy

- **Unit:** Vitest carries over (same runner Astro uses). Phase-0 router adapter makes the gatsby
  mock deletion a one-file swap for the ~109 test files. `.astro` components get Container-API
  tests only where logic exists (keep them logic-free).
- **E2E as the acceptance gate:** the 101-spec Playwright suite runs against `serve -l 8000 -c
  serve.json <dist>` exactly as today. Definition of route-class "done" = its specs green. The two
  `page-data.json` interception specs get a designed fixture seam (route-intercept the per-slug
  challenge JSON instead). Add: a version-skew test (§4.1) and preview-portal/hotkeys/completion
  island-navigation cases.
- **Accessibility (definition of done, per route class):** automated axe scans in CI;
  keyboard-only and screen-reader passes for the workspace island — including route announcement
  and focus reset on island-internal navigation (reach-router's announcer disappears with Gatsby);
  live-region semantics for the flash island; explicit no-regression checks for every §5.2
  component replacement (hotkeys, tooltips, modals, panels). Spike gate #3 includes the first
  keyboard/SR pass.
- **Analytics parity (per route class):** the 13 `call-ga.ts` event families + modal virtual
  pageviews verified against a staging GTM container; island router emits history/pageview events;
  dashboards annotated at each cutover (session semantics change under MPA).
- **Parity checklist per route class:** meta/OG tags diff, rendered-HTML spot diff, lighthouse
  (LCP/TBT/CLS budgets — set budgets *better* than Gatsby, not equal; shell→island CLS is a named
  metric), i18n string spot checks per locale.
- **Data parity:** derive-step output diffed against today's `page-data.json` for a sampled
  challenge set across all 11 view types + all locales (field-level, after the planned strips).
- **Perf gates in CI:** build wall-time + peak RSS per locale; bundle-size budget per island;
  zero-JS assertion for the static tier (fail CI if a static page grows a framework chunk).
- **Rollout monitoring:** error rates vs. Phase-2 baseline, challenge-completion funnel, donation
  conversion + event volume (rollback thresholds), Core Web Vitals field data, Search Console per
  locale.

---

## 10. Effort & sequencing estimate

Relative sizing (focused person-weeks, not calendar weeks — calendar depends on staffing):

| Workstream | Size | Notes |
|---|---|---|
| Phase 0 hardening | S–M (2–4 pw) | Parallelizable into ~8 independent PRs; portfolio-URL fix needs API-team time |
| Phase 1 spike | M (3–4 pw, timeboxed) | Two people ideal: data/build + workspace island |
| Phase 2 foundation | M–L (5–7 pw) | Derive step + i18n + layout + bridge + observability build-out |
| Phase 3 static & shells | M–L (7–11 pw) | Wide and parallelizable; per-island store work makes the authed tier M, not S |
| Phase 4 workspace island | L–XL (10–16 pw) | The crown jewel; epics port + 11 view types + exam/quiz flows + a11y |
| Phase 5 scale-out & cutover | M–L (5–8 pw) | CI/deploy/QA cycles × 11 locales; Crowdin + experiment + donation gates |
| Drift tax (§7.0) | ~10–15% of team time, Phase 3 onward | Dual-landing + ledger upkeep |
| Phase 6 backlog | ongoing | Post-cutover, non-blocking |
| **Total to cutover** | **~35–55 focused person-weeks** | Roughly 2 engineers × 5–7 months with review/QA overhead |

**What this estimate excludes** (each adds calendar latency more than person-weeks): API-team
decisions (CSRF, portfolio validation), GTM-container work owned by analytics, Crowdin translator
round-trips, client-config repo changes, and the freeCodeCamp/contribute docs update. These are
the critical-path external dependencies — attach owners and needed-by dates (§11).

Sequencing notes: Phases 0 and 1 can start immediately and in parallel. Phase 3 route classes are
independent of Phase 4 (different people). The long pole is Phase 4; start its owner in the spike.

---

## 11. Open questions for the team

Each question needs an **owner and a needed-by date** (aligned to the phase it blocks); the ADR
records who decided, what, and when.

1. **Challenge-page SEO scope** *(blocks Phase 1 spike design)* — the plan prerenders
   per-challenge shells with real meta + description copy (recommended; near-free given the
   derive step). Confirm, or consciously choose SPA-fallback-only for `/learn`.
2. **Test-runner origin isolation** *(blocks the §6.2 CSP design)* — same-origin unsandboxed
   preview frames are a deliberate current design; `/learn` CSP stays permissive until this
   ships. In or out of scope as a companion project? Include the `@freecodecamp/curriculum-helpers`
   isolation audit either way.
3. **GTM policy** *(shapes §6.2 and the analytics workstream)* — keep as-is (accepting the CSP
   cap), gate on consent, server-side GTM, or Partytown? Owned by whoever owns the GTM container.
4. **Locale build model** *(Phase 5)* — the plan keeps 11 builds/22 VMs (lowest risk). Any
   appetite to consolidate the VM fleet later once builds are minutes not hours?
5. **Workspace-island router** *(Phase 1)* — TanStack Router vs React Router library mode;
   decided by the spike, but flag preferences now.
6. **New package location/name + drift policy sign-off** *(blocks Phase 2)* — `client-next`
   workspace package alongside `client` until cutover (recommended), and does the team accept the
   §7.0 dual-landing rule?
7. **`@freecodecamp/ui` coordination** *(Phase 2/6)* — repackaging is post-migration in this
   plan; if the ui team wants to move sooner, Phase 2 can consume it behind `ssr.noExternal`
   either way.
8. **CSRF cookie strategy** *(blocks Phase 2 session module)* — the erase-on-every-load
   workaround needs an API-team decision.
9. **Browser-support floor** *(blocks Phase 1 `build.target` decision)* — no browserslist exists
   today; Gatsby's default + core-js quietly supported older browsers. Pull `/learn` browser/OS
   data from GA, pick a floor, add the oldest supported browser to the test matrix.
10. **Observability tool** *(blocks Phase 2)* — error tracking doesn't exist today and rollout
    gates depend on it. Pick the tool (and its CSP origin) early.

---

## Appendix A: route-by-route migration map

| Route(s) | Today | Astro shape | Difficulty |
|---|---|---|---|
| `/learn/:sb/:block/:challenge` (≈19k) | 11 SSG templates + page queries | `.astro` shell via `getStaticPaths` (title/meta/description copy) + workspace island (`client:only`) with specified shell→island handoff | **L** (the island); shells themselves M |
| `/learn/:sb/` ×98 | SSG template, all-nodes query | `.astro` + map/accordion island (own store instance); **scoped** per-superblock data | M |
| `/`, `/learn`, `/learn/archive`, `/catalog`, `/blocked`, `/404`, `/donate`, `/supporters`, `/email-sign-up`, `/update-stripe-card`, `/unsubscribed*`, daily archive page | SSG + full app boot | `.astro` static-first; islands only for interactive bits (donation `<Elements>` scoped) | S–M |
| `/settings(/*)`, `/:maybeUser`, `/certification/:u/:c`, `/user/:u/report-user`, `/update-email`, `/status/version` | client-only shells on the global store | prerendered shells + `client:only` islands with **per-island store factory** (§4.3) | **M** (×7) |
| `/learn/daily-coding-challenge/*` | client-only shell reusing the full classic template | route inside the Phase-4 workspace island (runtime-fetched data) | with Phase 4 |
| `/challenges(/*)`, `/certification`, `/user` | client-side redirect pages | Astro `redirects` + serve.json; delete the React pages | S |
| Head/theme/manifest/MathJax/RTL | gatsby-ssr hooks + html.tsx + tags.tsx | one base `.astro` layout (~60 lines) | S |

Route-priority checks: root-level `[maybeUser].astro` must lose to every static route and still
render 404 UI (client-side, status-200 — same semantics as today) for unknown users.

## Appendix B: contracts that must survive

Byte-for-byte / behavior-identical across the migration:

1. `public/js/test-runner/<helperVersion>/index.js` + `public/js/workers/<version>/{python,sass-compile,typescript}-worker.js` — URL scheme consumed by `frame.ts:91` and `python-worker-handler.ts` (version segment from `@freecodecamp/browser-scripts`; runner bundle is `@freecodecamp/curriculum-helpers`).
2. `/python-input-sw.js` — real service worker for synchronous python `input()` (registered in `xterm.tsx:10–19`; root-scoped).
3. `static/curriculum-data/v2/**` — public JSON API for the mobile app (`available-superblocks.json`, per-superblock + per-challenge JSON, `scene-assets.json`).
4. localStorage keys & formats: challenge code keys (incl. legacy `Bonfire:`/`Waypoint:` prefixes and daily-challenge language-suffixed keys), `fcc-failed-updates`, `fcc-sound`, `soundVolume`, `challenge-layout`, `fcc-current-challenge`, `theme`, sessionStorage counters.
5. `?messages=` flash query-param contract with the API (and hard `window.location` handoffs to `${apiLocation}/signin`, `/signout` — which must also purge the session cache, §4.3).
6. Session endpoint semantics: `GET /user/session-user` with `credentials: 'include'` + `CSRF-Token` header from cookie.
7. serve.json redirect table (client-config repo) — including `/challenges → /learn` legacy rewrites and old-cert-slug redirects covered by `e2e/redirect.spec.ts`.
8. Locale path-prefix rule: english = no prefix, else `/<locale>` — centralized in one shared helper, **with the three deliberate exceptions encoded** (test-runner assets locale-prefixed; python worker URL root-absolute; python-input SW root-scoped — see §4.5).
9. Legacy service-worker self-destruction (`sw.js` at the same URL as gatsby-plugin-remove-serviceworker emitted).
10. `manifest.webmanifest` + favicon/apple-touch link set (11 tags), og/twitter meta shape, monetization tag.
11. Build-time trending-YAML validation (js-yaml safe load + Joi https-only URI schema) carried forward verbatim.
12. **No COOP/COEP headers** introduced via serve.json without explicit testing of the preview portal and pyodide flows.

### B.1 Code-execution sandbox invariants (preserve exactly)

From the security deep-dive of `frame.ts`, `build.ts`, `python-worker.ts`, `python-input-sw.js`,
and `@freecodecamp/challenge-builder` (note: `frame.ts` builds the *preview* frames; test
execution delegates to `window.FCCTestRunner` from `@freecodecamp/curriculum-helpers`, loaded
into the parent page — audit that package separately, §4.4):

1. Preview frames are `srcdoc`, same-origin, no `sandbox` attribute (status quo — see §6.1 for
   the deliberate-hardening decision; do not change accidentally).
2. `window.onerror` cross-origin scrubbing (`frame.ts:118–125, 364–377`) — collapses "Script
   error" so raw cross-origin errors don't leak.
3. Link-click interception in the frame header script (`frame.ts:126–148`): external links
   `preventDefault` + parent alert; `#anchor` handled locally; non-http relative nav blocked.
4. Form-submit interception (`frame.ts:149–157`): external `action` blocked + alert.
5. `<base href=''>` in the frame (`frame.ts:110`) — or in-page anchors/relative assets break.
6. loop-protect timeouts (100 ms preview / 1500 ms test) + per-challenge disable flags.
7. Pyodide worker `Object.freeze(self)` after load (`python-worker.ts:59`) — learner
   sandbox-escape guard.
8. Fresh Python globals per run with `__name__='__main__'` (`python-worker.ts:121–125`).
9. Python exceptions returned as strings, never PyProxy references (`python-worker.ts:153–179`).
10. Synchronous-XHR `input()` bridge through the service worker at exactly
    `/python/intercept-input/` (`python-worker.ts:92`, `python-input-sw.js`), SW registered from
    xterm with `skipWaiting`/`clients.claim` — any path/scope change deadlocks Python `input()`.
11. Versioned worker/test-runner URLs (`/js/workers/<version>/…`, `/js/test-runner/<helperVersion>/…`).
12. `interruptCodeExecution` terminate-and-recreate worker fallback (`python-worker-handler.ts:79–99`)
    — the only hard-stop for runaway Python.
13. Test-runner bundle appended to the **parent page's** head, tests invoked via the
    `window.FCCTestRunner.getRunner(type).runAllTests(...)` global contract (`frame.ts:180–182, 222–258`).
14. `mountFrame`'s replace-iframe-by-id contract (`frame.ts:277–291`); the parent monkey-patches
    the frame window's `console.log/info/warn/error` (`updateProxyConsole`, `frame.ts:297–344`);
    the parent's live i18next instance is assigned INTO the frame window
    (`updateWindowI18next`, `frame.ts:346–352`); cross-document `__initPythonFrame`/`__runPython`
    calls (`frame.ts:210–220, 380–383`); scroll restoration via `contentDocument`
    (`frame.ts:57–84`); the preview-portal `about:blank` popup whose head/body the parent rewrites
    (`preview-portal.tsx:105–113`).
