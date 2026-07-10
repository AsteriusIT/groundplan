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
│   │   └── src/
│   │       ├── index.ts        # entry: loads env, builds app, listens, handles shutdown
│   │       ├── app.ts          # buildApp(env) factory — plugins + route registration
│   │       ├── config/env.ts   # environment parsing (single source of config truth)
│   │       └── routes/         # Fastify route plugins (one concern per file)
│   └── frontend/       # React 19 + TypeScript + Vite + Tailwind v4 + shadcn/ui
│       └── src/
│           ├── main.tsx        # React root
│           ├── App.tsx         # placeholder landing (pings backend health)
│           ├── index.css       # Tailwind v4 entry + shadcn theme tokens
│           ├── components/ui/  # shadcn/ui components (generated; edit freely)
│           └── lib/utils.ts    # cn() class-merge helper
├── packages/           # (empty) shared libraries live here, e.g. @groundplan/*
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

Filter to one package with `pnpm --filter @groundplan/backend <script>`.

### Ports & dev wiring

- Backend listens on **:3000**, routes are under **`/api/v1`** (e.g. `GET /api/v1/health`).
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

- There is **no database, auth, or plan-ingestion yet** — those are the first
  real features. When adding them, backend business logic should sit behind the
  route layer (consider `src/services/` + `src/plugins/`), not inside route handlers.
- **Never introduce cloud SDK credentials or Terraform state access.** The trust
  model is "ingest plan JSON from the user's CI." Keep it that way.
- Prefer deterministic rendering: use AI to build/annotate the semantic model,
  then render diagrams deterministically so CI output is trustworthy.
- No test runner is wired up yet — add one (e.g. `vitest`) with the first feature.
