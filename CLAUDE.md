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
- **Two per-repo secrets, handled differently:** `access_token` is **write-only**
  (never returned; `publicRepositoryColumns`); `webhook_token` is **shown once**
  in the create-repository response, then excluded from list responses. Never add
  either to a `.select()`/`.returning()` that leaves the API; never log an
  authenticated clone URL (tokens are redacted in errors). Compare webhook tokens
  with `safeEqual` (constant-time).
- Migrations run under a Postgres advisory lock (`runMigrations`), so parallel
  test files / concurrent app startups don't race on schema creation.
- **Never introduce cloud SDK credentials or Terraform state access.** The trust
  model is "ingest plan JSON from the user's CI." Keep it that way.
- Prefer deterministic rendering: use AI to build/annotate the semantic model,
  then render diagrams deterministically so CI output is trustworthy.
- Follow TDD: tests live beside their subject as `*.test.ts` and run via
  `pnpm --filter @groundplan/backend test` (Node's built-in runner + tsx).
