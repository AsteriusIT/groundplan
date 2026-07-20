# CLAUDE.md

Guidance for Claude Code (and humans) working in this repository.

## What this is

**groundplan** (product working name: _InfraCanvas_) turns Terraform into living,
interactive, reviewable diagrams. The goal: teams review infrastructure changes
visually, keep documentation permanently in sync with code, and see their cloud
as networks / permissions / systems instead of thousands of lines of HCL.

The platform ingests **Terraform plan JSON produced by the user's own CI** — it
never touches cloud credentials or state backends. We ingest data, not access.

> Status: **scaffold only.** Both apps are empty base apps (a health endpoint on
> the backend, a placeholder landing page on the frontend). No product features
> are implemented yet.

### Roadmap context (so new code lands in the right place)

- **v1 — See:** repo connection, semantic model, interactive network view, visual PR diffs, auto-updated docs on merge.
- **v2 — Understand:** IAM view, AI change summaries and risk highlights on PRs.
- **v3 — Shape:** annotation layer + diagram editor, C4 view, cross-repo catalog.

## Repository layout

```
groundplan/
├── apps/
│   ├── backend/        # Fastify + TypeScript API (ESM, NodeNext)
│   │   ├── drizzle/            # generated SQL migrations + meta (do not hand-edit)
│   │   ├── drizzle.config.ts   # drizzle-kit config (schema path, out dir, DATABASE_URL)
│   │   └── src/
│   │       ├── index.ts        # entry: migrate (dev) → build app → listen → shutdown
│   │       ├── app.ts          # buildApp(env, opts) factory — plugins + route registration
│   │       ├── config/env.ts   # environment parsing (single source of config truth)
│   │       ├── db/             # schema.ts, index/drizzle, migrate.ts + migrate.cli.ts
│   │       ├── plugins/        # Fastify plugins (e.g. db.ts decorates app.pool / app.db)
│   │       └── routes/         # route plugins; *.test.ts live next to their route
│   ├── frontend/       # React 19 + TypeScript + Vite + Tailwind v4 + shadcn/ui
│       └── src/
│           ├── main.tsx        # React root
│           ├── App.tsx         # placeholder landing (pings backend health)
│           ├── index.css       # Tailwind v4 entry + shadcn theme tokens
│           ├── components/ui/  # shadcn/ui components (generated; edit freely)
│           └── lib/utils.ts    # cn() class-merge helper
│   └── vscode/         # groundplan-vscode — VS Code extension (GP-147..150): live
│                       #   Terraform preview; host bundled by esbuild, webview by Vite
├── packages/
│   ├── cli/            # @asteriusit/cli — `groundplan push-plan` for CI
│   ├── canvas/         # @groundplan/canvas — the diagram canvas as a reusable React
│   │                   #   package (GP-146); app + VS Code webview consume it; the old
│   │                   #   frontend paths are one-line re-export shims
│   └── graph-parser/   # @groundplan/graph-parser — Producer B (HCL → GraphSnapshot)
│                       #   as a pure shared package + the graph types/validator (GP-145)
├── deploy/
│   └── chart/          # Helm chart (GP-167 epic) + golden-file tests — see
│                       #   deploy/chart/groundplan and docs/install-kubernetes.md
├── keycloak/           # Keycloakify carbon theme (login/account/email) — see keycloak/README.md
├── docker-compose.yml  # local Postgres + (auth profile) Keycloak, which mounts the theme jar
├── pnpm-workspace.yaml
├── tsconfig.base.json  # shared strict TS options; each app extends this
└── package.json        # workspace root scripts
```

Workspace package names: `@groundplan/backend`, `@groundplan/frontend`,
`@groundplan/keycloak-theme` (the Keycloak theme; `pnpm keycloak:build` builds
its provider jar — see `keycloak/README.md`).

## Commands

Run from the repo root unless noted. Package manager is **pnpm** (v10, see
`packageManager`). Node **>= 22** required (`.nvmrc` pins 24).

| Command | What it does |
| --- | --- |
| `pnpm install` | Install all workspace deps |
| `pnpm dev` | Run backend + frontend together (parallel) |
| `pnpm dev:backend` | Backend only (tsx watch, port 3000) |
| `pnpm dev:frontend` | Frontend only (Vite, port 5173) |
| `pnpm build` | Build every package |
| `pnpm typecheck` | Type-check every package |
| `pnpm start` | Run the built backend (`node dist/index.js`) |
| `pnpm clean` | Remove build artifacts |

Backend-only (via `pnpm --filter @groundplan/backend <script>`):

| Command | What it does |
| --- | --- |
| `test` | Run tests (`node --test` + tsx, files: `src/**/*.test.ts`) |
| `migrate` | Apply pending migrations (`tsx src/db/migrate.cli.ts`) |
| `db:generate` | Generate a new migration from schema diff (drizzle-kit) |

Local dev needs Postgres up first: `docker compose up -d`.

### Ports & dev wiring

- Backend listens on **:3000**. API routes are under **`/api/v1`** (e.g.
  `GET /api/v1/health`); at the root live the probe pair (GP-168): liveness
  **`GET /healthz`** (200 whenever the process is up, no DB) and readiness
  **`GET /readyz`**, which returns `{"status":"ok","db":"ok"}` (200) or 503 if
  Postgres is unreachable.
- Postgres runs on **:5432** via `docker compose up -d` (`DATABASE_URL` defaults
  to `postgres://groundplan:groundplan@localhost:5432/groundplan`).
- Frontend dev server runs on **:5173** and **proxies `/api` → `http://localhost:3000`**
  (see `apps/frontend/vite.config.ts`). So in-app, always call `/api/...` — do
  not hardcode the backend origin.

## Conventions

**General**
- TypeScript `strict` everywhere, plus `noUncheckedIndexedAccess` and
  `noUnusedLocals/Parameters`. Don't loosen these to make code compile — fix the code.
- Config extends `tsconfig.base.json`; add shared options there, app-specific in the app.

**Backend**
- ESM + `NodeNext` module resolution ⇒ **relative imports must use `.js`
  extensions** (e.g. `import { buildApp } from "./app.js"`), even though the
  source files are `.ts`. This is required, not a mistake.
- Keep app construction (`buildApp`) separate from `listen()` so the app is testable.
- Read all environment access through `config/env.ts` — don't sprinkle
  `process.env` across the codebase.
- Each route is a `FastifyPluginAsync` in `src/routes/`, registered in `app.ts`.

**Backend — database**
- Data layer is **Drizzle ORM** over **node-postgres** (`pg`). The `db` plugin
  (`src/plugins/db.ts`) owns the pool lifecycle and decorates `app.pool` (raw)
  and `app.db` (Drizzle). Access the DB through those decorations.
- `buildApp(env, { pool })` accepts an injected pool so routes can be tested
  against a stub without a live database (see `routes/healthz.test.ts`).
- Migrations are **generated** (never hand-written): edit `src/db/schema.ts`,
  then `pnpm --filter @groundplan/backend db:generate`. Files land in `drizzle/`.
  `runMigrations()` (`src/db/migrate.ts`) applies them — on startup in dev and
  via `pnpm migrate`. One `DATABASE_URL` is the only DB config (KISS).

**Frontend**
- Import via the `@/` alias (maps to `src/`), configured in both
  `tsconfig.json` and `vite.config.ts`.
- Styling is **Tailwind CSS v4** (no `tailwind.config.js` — theme lives in
  `src/index.css` via `@theme`). Design tokens are CSS variables (oklch).
- **shadcn/ui**: add components with `pnpm dlx shadcn@latest add <component>`
  (run inside `apps/frontend`). Config is `components.json` (style: new-york,
  base color: neutral). Generated components go in `src/components/ui/` and are
  yours to edit.
- Use the `cn()` helper from `@/lib/utils` for conditional class names.
- **API access (GP-7):** all HTTP goes through `src/api/client.ts` — never call
  `fetch` for the API directly from components. Types in `src/api/types.ts`
  mirror the backend responses field-for-field (note `User.display_name` is
  snake_case, matching `/me`). Non-2xx throws `ApiError` (status + message);
  the login story wires `setAuthTokenProvider` / `setOnUnauthorized`. Base URL is
  `import.meta.env.VITE_API_URL` + `/api/v1` (empty in dev → hits the proxy).
- Frontend tests use **vitest** + Testing Library in a **jsdom** environment
  (`src/test-setup.ts`, which also polyfills Radix's jsdom needs); mock `fetch`
  for client tests, and assert accessibility with `vitest-axe`.
- **Design system (GP-9, extended GP-28):** a "blueprint" light theme. All tokens
  (the full mockup palette — surfaces, ink scale, `create`/`update`/`delete`/
  `impacted` status + soft tints, `cat-*` category hues — plus Space Grotesk /
  Inter / IBM Plex Mono fonts + `.blueprint-grid` canvas) live in `src/index.css`
  and are the single source of colour truth. **Never hardcode a colour** in a
  component (no `#hex`, no raw `bg-emerald-500`) — use the semantic Tailwind
  utilities the tokens generate (`bg-create-soft`, `text-impacted`, …); the
  `design-tokens.test.ts` guard enforces this for the design-v3 surface. Shared
  primitives live in `components/ui/`: `Chip`, `StatusBadge` (circular +/~/−/!),
  `SidePanel` (+ Header/Body/Section); change/status metadata is centralised in
  `lib/status.ts`. Fonts: `font-display` (headings/wordmark), default sans (body),
  `font-mono` (data — addresses, types, shas). A dev-only `/styleguide` route
  (registered only when `import.meta.env.DEV`) renders every token + primitive.
  Add shadcn components with `pnpm dlx shadcn@latest add <name>` (run in
  `apps/frontend`).
- **App shell (GP-9):** `AppLayout` (sidebar + flat `<Outlet>` canvas — the
  `.blueprint-grid` paper is opt-in per diagram view, currently the PR and docs
  pages; every other view sits on a plain `bg-background`) wraps
  the authenticated routes under `<RequireAuth>` in `App.tsx`. New authenticated
  pages: add a `pages/*.tsx`, a `<Route>` inside the layout, and a `NAV` entry in
  `components/sidebar.tsx`. Reuse `PageHeader` for the title block.
- **Dashboard & Settings (GP-68/GP-69):** `/dashboard` is the index route and the
  only caller of `GET /dashboard` (GP-67) — stat cards, recent PRs (change chips +
  `Exposed`/`Privileged` risk badges), recent docs; a fresh user gets one CTA, not
  empty tables. `/settings` is deliberately thin: account (read-only, from the
  token), appearance (the `ThemeSwitcher` — Settings is its _only_ home; the
  sidebar is navigation, nothing else), and a **read-only** AI
  status card. That card is the one AI surface that still renders when the layer
  is off — it is a readout of server config, not AI content, and "why is there no
  AI anywhere?" is exactly what Settings should answer. Never add a key input:
  `AI_API_KEY` is env-only by design (GP-62).
- **Login (GP-8):** Authorization Code + PKCE via `oidc-client-ts`. `src/auth/`
  holds the `UserManager` config (`user-manager.ts`, defaults to the dockerized
  Keycloak), `AuthProvider` (wires the GP-7 client hooks: token provider +
  `onUnauthorized`, fetches `/me`), and the `useAuth()` hook (`user`, `login`,
  `logout`, `isAuthenticated`, `isLoading`). Routes: `/login`, `/callback`, and
  everything else behind `<RequireAuth>` (redirects to `/login`). New protected
  pages just render inside the guarded route — don't re-check auth per page.

## Things to know before extending

- Postgres is wired up (GP-2). The schema (GP-3) has **`projects`** and
  **`repositories`** (a project has many repos; delete cascades). There is still
  **no auth or plan-ingestion yet** — route protection is a later auth story.
- CRUD API lives under **`/api/v1`**: `projects` (list/create/get/delete),
  `projects/:id/repositories` (list/create), `repositories/:id` (delete). No
  PATCH/pagination yet (out of scope for GP-3).
- Read-only repo file access (GP-4): `GET /repositories/:id/files?ref=` and
  `GET /repositories/:id/files/*?ref=`. Backed by `services/repo-files.ts`,
  which **shallow-clones** the repo to a temp dir per request (no caching yet),
  reads from disk, and always cleans up. Path traversal is blocked; only `https`
  repo URLs are allowed by the routes.
- CI ingestion (GP-5): `POST /api/v1/webhooks/ci/:repositoryId` (auth via the
  `X-Groundplan-Token` header; 10 MB body limit → 413; 202 with the event id)
  stores rows in `ingestion_events` (JSONB `payload`, no processing yet).
  `GET /api/v1/repositories/:id/events` lists the last 20 (no payload).
- **Two per-repo secrets, handled differently:** `access_token` (the PAT) is
  **encrypted at rest** (AES-256-GCM, `lib/encryption.ts`, key from
  `ENCRYPTION_KEY`) and **write-only** — responses mask it as `"***"` via
  `toPublicRepository` (never omit-vs-mask by hand; always map rows through it).
  `webhook_token` is **shown once** in the create response, then excluded. Never
  log an authenticated clone URL (tokens are redacted in errors). Compare webhook
  tokens with `safeEqual` (constant-time).
- **Repository connection (GP-11):** `services/repo-files.verifyConnection`
  (`git ls-remote`) checks reachability; `verifyAndStore` decrypts the PAT, runs
  it, and persists `connection_status` (`unverified`|`ok`|`failed`) + `verified_at`.
  Auto-runs on create/update when a PAT is set; also `POST /repositories/:id/verify`.
  The verifier is injectable via `buildApp(env, { verifyConnection })` so tests
  stay offline (real verifier works against `file://` fixtures). `ENCRYPTION_KEY`
  follows the same dev/test-default, prod-fail-closed pattern as OIDC.
- **Terraform path:** `repositories.terraform_path` ("" = the repository root) is
  the directory a repo's Terraform lives in. It moves the **entrypoint** of the
  HCL parse — `parseHclRepo(files, { rootDir })`, the way `terraform -chdir` does:
  every `.tf` in the clone is still handed to the parser, so a module sourced from
  _above_ the root (`../modules/shared`) resolves, while stacks the entrypoint
  never reaches stay out of the graph. A root holding no `.tf` warns rather than
  storing a silently empty graph. Plan snapshots come from CI as JSON and ignore
  it entirely; so does the raw file API (GP-4), which stays whole-repo. Always
  store through `lib/repo-path.normalizeTerraformPath` — a path that escapes the
  repository is a 422, never something to clamp.
- **Dashboard (GP-67):** `GET /api/v1/dashboard` — the one call the home page
  makes: four counts, the last 10 pull requests (with their latest plan
  snapshot's stats and its `internetExposed` / `privileged` risk flags), the last
  5 docs snapshots, and the repositories holding orphaned annotations (so the
  orphan card can link into GP-59 review). Read-only, no new tables, no cache.
  The risk flags are derived in SQL (jsonb containment on `graph->'nodes'`) —
  never load a graph body to compute them. It reads the **whole estate**: there
  is no per-user ownership model yet, so every authenticated user sees the same
  projects. When ownership lands, `routes/dashboard.ts` is the place to scope.
- Migrations run under a Postgres advisory lock (`runMigrations`), so parallel
  test files / concurrent app startups don't race on schema creation.
- **Auth (GP-6):** OIDC resource server. `plugins/auth.ts` is an `fp` global
  `onRequest` hook that validates bearer JWTs with `jose` (sig/iss/aud/exp),
  JIT-upserts a `users` row (by `oidc_subject`), and sets `request.authUser`.
  Exempt: `/healthz`, `/readyz`, `/api/v1/health`, `/api/v1/webhooks/*`. `GET /api/v1/me`
  returns `{id, email, display_name}`.
  - Enforced only when `OIDC_ISSUER_URL` + `OIDC_AUDIENCE` are set; **production
    refuses to boot without them** (fail-closed); unconfigured dev/test runs open
    (keeps route tests simple). So new route tests that need an authed request
    use `buildTestApp()` + `authHeader()` from `src/test-support.ts` (local
    JWKS, no network); tests that don't care run unauthenticated via `buildApp`.
  - Local IdP: `docker compose --profile auth up -d` (Keycloak on :8085, realm
    in `infra/keycloak/`). New protected routes need no wiring — the global hook
    already covers them; add to the exempt list only for genuinely public ones.
- **AI layer (GP-62..GP-65):** prose _about a snapshot_, and never a substitute
  for the deterministic view it sits beside.
  - **`AI_API_KEY` is the feature flag.** Unset ⇒ `app.ai.model` is null, so
    `GET /api/v1/ai/status` reports disabled, the generation routes 404, and the
    frontend renders no AI surface at all. There is no dev default — generating
    costs money. `AI_MODEL` defaults to `claude-opus-4-8`.
  - Routes are uniform for both features: `GET|POST /snapshots/:id/ai/:kind`
    (`kind` = `pr_summary` for a plan snapshot, `docs_explain` for an hcl one).
    POST streams plain text (the AI SDK `text` protocol that `useCompletion`
    reads); a cache hit replays the stored text with no provider call.
  - **The model never sees a plan.json.** It sees a Markdown brief rendered from
    our own deterministic outputs by `services/ai-input.ts` — pure functions,
    golden-tested. Ground new generations there, not in raw payloads.
  - Prompts are versioned **files** (`apps/backend/prompts/*.md`), never string
    literals, and the file's content hash _is_ the prompt version — editing a
    prompt invalidates the `ai_generations` cache with nothing to remember to
    bump. Cache key: `(kind, target, prompt version, model)`. Failures are never
    cached. One generation in flight per target (409 otherwise).
  - The provider is injectable — `buildApp(env, { ai })` — so the whole layer is
    tested offline against a stub. Never write a test that calls a real model.
  - Frontend: one `AiPanel` serves both features; generation is always
    user-triggered (no auto-generation on mount), always labelled AI-generated
    with the model name, and absent entirely when the flag is off. Model Markdown
    renders through `AiResponse` (react-markdown, no `rehype-raw`) — treat model
    output as untrusted input, never as HTML. Share links never show AI content.
- **Annotation layer & adapted diagrams (GP-56..GP-59, GP-71..GP-77):** what a
  human (or the proposer) says about the estate, stored strictly _beside_ the
  generated snapshot and never inside it (ADR #4).
  - **Five types**, all in one `annotations` table, anchored to Terraform
    addresses: `note` (1 anchor + markdown body), `link` (2 anchors + optional
    label — this _is_ the epic's "logical_edge"; an anchor may be a **group's id**
    instead of an address, which is how a group→group edge is said), `group` (1+
    anchors + label; nests **one level** via `parent_group_id`, which is what makes
    the C4 mapping honest), `hide` (1 anchor), `rename` (1 anchor + label).
  - `status`: `resolved` (= accepted/live), `orphaned` (an anchor's address
    vanished — GP-57 reconciliation owns this; it is a status flip, never a
    delete, and it reverses itself), `proposed` (an AI suggestion, GP-75).
    `provenance` (`human` | `ai`) is permanent — an accepted AI annotation still
    says where it came from. **Nothing but an explicit PATCH moves a proposal to
    `resolved`**; reconciliation skips proposals entirely, by design.
  - **The projection is the whole point (GP-72).** `graph/adapted.ts` is a pure
    fold: `projectAdapted(graph, annotations) → Graph`, exposed as
    `GET /snapshots/:id/adapted`. It returns an **ordinary GraphSnapshot**, so the
    renderer draws an adapted diagram knowing nothing about annotations (ADR #2).
    Only `resolved` annotations participate. Nothing dangles: a hidden node takes
    its edges with it, and a group whose last member is hidden is dropped.
  - **C4 (GP-77):** `?granularity=group` collapses it to one node per top-level
    group, aggregating inter-group edges (with a count) and dropping intra-group
    ones; `?expandGroup=<annotation id>` opens one in place. Module containers are
    dropped at that altitude, and ungrouped resources collapse into an
    "Ungrouped (n)" bucket past 5.
  - Graph schema **v5** carries the additions (`logical` edge kind, edge
    `label`/`count`, node `display_label`/`notes`/`annotation_group`/
    `member_count`) — all optional, so v1..v4 stay valid.
  - Frontend: `?view=` switches `infra` (raw) / `adapted` / `c4` / `network` /
    `iam`. **You annotate on the raw view only** — editing through a lens that
    already hides and renames things is how you annotate your own annotations.
    Proposals are never drawn on the canvas (`renderableAnnotations` filters them);
    they live in the `ProposalInbox` until a human answers them.
- **AI proposer (GP-75):** `POST /snapshots/:id/annotation-proposals` (docs
  snapshots only). Same rails as the rest of the AI layer — versioned prompt file,
  `ai_generations` cache (so a second ask costs nothing), injectable provider, and
  `AI_API_KEY` as the only flag (404 when off). Every anchor it returns must exist
  in the snapshot or the proposal is dropped; a response that is not JSON is a 502
  and stores **nothing**, cache included. Proposals never duplicate an existing
  annotation in any status. Each carries a one-sentence `reason`, shown to the
  reviewer — a suggestion you judge without knowing why it was made is one you
  rubber-stamp.
- **Live clusters are top-level (GP-95..GP-99):** a `clusters` row belongs to **no
  project**, and the sidebar says so — Dashboard / Projects / **Clusters** /
  Settings. A project is a unit of code review (repositories, their PRs, the main
  branch we document); a live cluster has no PR to diff and no commit to document,
  so filing it under one bought nothing and cost a cascade that deleted somebody's
  clusters along with the project. The API is flat (`GET|POST /clusters`,
  `/clusters/:id`, `/clusters/:id/namespaces/...`) and the list is the whole estate
  — when an ownership model lands, `routes/clusters.ts` scopes beside
  `routes/dashboard.ts`. Kubernetes **manifests repositories** are a different
  thing and stay inside their project: they are Git repos, and PR review is what a
  project is _for_. The kubeconfig follows the repository-PAT rules exactly —
  encrypted at rest, write-only, masked through `toPublicCluster`, never logged.
- **Kubernetes Git flow (GP-100..GP-105):** a repository declares what it holds —
  `repositories.iac_type` is `terraform` (default, unchanged) or `kubernetes` —
  and every producer choice branches on it. Set at attach time, immutable.
  - `terraform_path` does double duty: for a kubernetes repo it is the manifests
    directory (the UI calls it "Manifests path"). Not renamed, deliberately.
  - **One Kubernetes mapper.** `graph/k8s-mapper.mapK8sObjects(objects)` maps a
    _set of objects_, whatever their source: a live namespace read (GP-97),
    a repo's YAML (GP-102), or CI-rendered output (GP-103). `mapNamespace` is now
    a thin adapter over it. Node ids are **namespace-qualified**
    (`prod/Deployment/api`) because a manifests repo holds many namespaces, and
    references resolve _within_ a namespace, as Kubernetes resolves them.
    Every well-formed object is a node (CRDs included); edges are drawn only for
    the shapes we understand.
  - **Snapshot sources mirror the Terraform pair:** `k8s_manifest` = docs of main
    (the HCL of Kubernetes), `k8s_rendered` = a PR head (its plan.json),
    `k8s_namespace` = a live cluster. `services/graph-snapshots` owns the mapping
    (`docsSourceFor`/`prSourceFor`, `DOCS_SOURCES`/`PR_SOURCES`) — never re-derive
    it in a `where` clause.
  - **No plan means diff-by-comparison.** Graph v7 adds node `attributes` (the
    object flattened to `path → value`), and `graph/change-diff.changesFromBase`
    colours a head graph against the repo's latest docs snapshot of main. It is
    _not_ `graph/diff.ts` (GP-40), which answers a different question and would
    mispair a cross-namespace delete+create as a "move". A snapshot records the
    base it used (`stats.base`, `"none"` when main has no diagram yet).
  - **We never run `helm`/`kustomize`.** They are Go binaries; rendering happens in
    the user's CI, which POSTs the YAML as `payload.manifests` to the same webhook
    (on a `pull_request` → the PR snapshot; on a `push` → the docs of main, which
    is the _only_ way a chart or an overlay is ever documented). Raw-YAML repos are
    parsed from the clone instead. A body we cannot read is a 422 that stores
    nothing.
  - A Secret's _values_ never reach a graph, even from a manifest that hands them
    over in the clear — so a rotated value is invisible to the diff, while a new
    key is not. That is the price of never holding it, and it is the right way round.
  - Frontend: a Kubernetes snapshot gets the **diagram and nothing else** —
    `viewsFor()` (view-switcher) is the one place that decides; annotate, AI, tours
    and share links are absent, and the deterministic summary carries the review.
- **Kubernetes install (GP-167 epic, GP-168..GP-172):** `deploy/chart/groundplan`
  deploys api + frontend + ingress. Database and IdP are **external by default**
  (`externalDatabase.*`, `oidc.*`); `postgresql.enabled` / `keycloak.enabled` are
  eval-only embedded alternatives, each mutually exclusive with its external
  counterpart — impossible combinations `fail` template rendering with a
  sentence. Migrations run as a hook Job (always pre-upgrade; pre-install only
  when DB + secret pre-exist the release) sharing the api's one templated
  `DATABASE_URL`. After any chart edit run `deploy/chart/tests/run.sh --update`
  (golden files are committed); `helm-chart.yml` lints, goldens and kind-smokes
  chart changes (`tests/smoke.sh` = install eval mode, login via the imported
  realm, POST a fixture plan, assert the snapshot). Images go to GHCR (public,
  chart default) + Scaleway on `v*` tags. See `docs/install-kubernetes.md`.
- **VS Code extension (GP-144 epic, GP-145..GP-150):** `apps/vscode` renders a
  live architecture preview of the workspace's Terraform — parse via
  `@groundplan/graph-parser` in the extension host, draw via `@groundplan/canvas`
  in a strict-CSP webview (Vite-built: Tailwind + `import.meta.glob` icons need
  it; the host bundles with esbuild). Live loop: debounced re-parse of dirty
  buffers, last-good graph on parse errors (out-of-sync chip), Problems-panel
  diagnostics. Node↔code navigation works off `node.source` ranges only. It is
  fully offline and bundles everything — never add a network call or telemetry
  to it. Packaging/publishing: `.github/workflows/vscode-extension.yml` +
  `docs/vscode-publishing.md` (tag `vscode-v<version>`, version from the
  manifest).
- **Never introduce cloud SDK credentials or Terraform state access.** The trust
  model is "ingest plan JSON from the user's CI." Keep it that way.
- Prefer deterministic rendering: use AI to build/annotate the semantic model,
  then render diagrams deterministically so CI output is trustworthy.
- Follow TDD: tests live beside their subject as `*.test.ts` and run via
  `pnpm --filter @groundplan/backend test` (Node's built-in runner + tsx).
