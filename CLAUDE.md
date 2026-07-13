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
│   └── frontend/       # React 19 + TypeScript + Vite + Tailwind v4 + shadcn/ui
│       └── src/
│           ├── main.tsx        # React root
│           ├── App.tsx         # placeholder landing (pings backend health)
│           ├── index.css       # Tailwind v4 entry + shadcn theme tokens
│           ├── components/ui/  # shadcn/ui components (generated; edit freely)
│           └── lib/utils.ts    # cn() class-merge helper
├── packages/           # (empty) shared libraries live here, e.g. @groundplan/*
├── docker-compose.yml  # local Postgres for dev
├── pnpm-workspace.yaml
├── tsconfig.base.json  # shared strict TS options; each app extends this
└── package.json        # workspace root scripts
```

Workspace package names: `@groundplan/backend`, `@groundplan/frontend`.

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
  `GET /api/v1/health`); the readiness probe **`GET /healthz`** is at the root and
  returns `{"status":"ok","db":"ok"}` (200) or 503 if Postgres is unreachable.
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
  Exempt: `/healthz`, `/api/v1/health`, `/api/v1/webhooks/*`. `GET /api/v1/me`
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
- **Never introduce cloud SDK credentials or Terraform state access.** The trust
  model is "ingest plan JSON from the user's CI." Keep it that way.
- Prefer deterministic rendering: use AI to build/annotate the semantic model,
  then render diagrams deterministically so CI output is trustworthy.
- Follow TDD: tests live beside their subject as `*.test.ts` and run via
  `pnpm --filter @groundplan/backend test` (Node's built-in runner + tsx).
