# groundplan

> Working name for **InfraCanvas** — _See your infrastructure. Review it. Shape it._

Turn Terraform into living, interactive diagrams — so teams review infrastructure
changes visually, keep documentation permanently up to date, and see their cloud
the way they think about it: as networks, permissions, and systems, not thousands
of lines of HCL.

The platform ingests **Terraform plan JSON produced by your own CI** — it never
touches your cloud credentials or state backends. Adoption is one pipeline step.

> **Status: scaffold.** This repository currently contains empty base apps — a
> backend health endpoint and a placeholder frontend. No product features yet.

## Stack

| Layer | Tech |
| --- | --- |
| Monorepo | pnpm workspaces |
| Backend | Fastify 5 + TypeScript (ESM) |
| Frontend | React 19 + TypeScript + Vite 6 |
| UI | Tailwind CSS v4 + shadcn/ui |

## Prerequisites

- **Node.js >= 22** (a `.nvmrc` pins 24 — `nvm use`)
- **pnpm 10** (`corepack enable` will provide it)
- **Docker** (for the local Postgres database)

## Run locally

```bash
pnpm install                                 # install workspace deps
docker compose up -d                         # start Postgres on :5432
pnpm --filter @groundplan/backend migrate    # apply DB migrations
pnpm dev                                      # backend :3000 + frontend :5173
```

Open <http://localhost:5173> (the landing page shows a green dot when the API is
reachable). Verify the API + DB at <http://localhost:3000/readyz> — it returns
`{"status":"ok","db":"ok"}` (`/healthz` is the DB-free liveness probe). In dev,
migrations also auto-apply on backend startup.

### Useful commands

| Command | What it does |
| --- | --- |
| `pnpm dev` | Run backend + frontend in parallel |
| `pnpm dev:backend` | Backend only (tsx watch) |
| `pnpm dev:frontend` | Frontend only (Vite) |
| `pnpm build` | Build every package |
| `pnpm typecheck` | Type-check every package |
| `pnpm --filter @groundplan/backend test` | Run backend tests |
| `pnpm --filter @groundplan/backend migrate` | Apply DB migrations |
| `pnpm --filter @groundplan/backend db:generate` | Generate a new migration from schema |
| `pnpm start` | Run the built backend |
| `pnpm clean` | Remove build artifacts |

Target one package with `pnpm --filter @groundplan/<name> <script>`.

## Project structure

```
apps/
  backend/     @groundplan/backend  — Fastify API, routes under /api/v1
  frontend/    @groundplan/frontend — React + Vite + Tailwind + shadcn/ui
packages/      (empty) shared libraries live here
```

The frontend dev server proxies `/api` → the backend on `:3000`, so app code
always calls relative `/api/...` paths.

### Authentication (OIDC)

The backend is an OIDC **resource server**: it validates bearer tokens from an
external IdP (no passwords handled here). Auth activates when `OIDC_ISSUER_URL`
and `OIDC_AUDIENCE` are set; every route is protected except `/healthz`,
`/readyz` and `/api/v1/webhooks/*`. In production the app refuses to boot
without them.

A dockerized Keycloak (realm `groundplan`, user `dev`/`dev`) is provided:

```bash
docker compose --profile auth up -d            # start Keycloak on :8085
cp apps/backend/.env.example apps/backend/.env  # sets OIDC_* to match the realm
pnpm dev:backend                                # backend now enforces auth

# get a token and call the API as the seeded user:
TOKEN=$(curl -s -X POST http://localhost:8085/realms/groundplan/protocol/openid-connect/token \
  -d grant_type=password -d client_id=groundplan-frontend -d username=dev -d password=dev \
  | jq -r .access_token)
curl -H "Authorization: Bearer $TOKEN" http://localhost:3000/api/v1/me
```

`GET /api/v1/me` returns `{id, email, display_name}` and provisions the user on
first authenticated request (JIT).

**Frontend login** uses the Authorization Code + PKCE flow (`oidc-client-ts`)
against the same realm. With Keycloak running, just start the app:

```bash
docker compose --profile auth up -d   # Keycloak on :8085
pnpm dev                              # backend :3000 + frontend :5173
```

Open <http://localhost:5173> → you're redirected to `/login` → **Sign in** →
authenticate as `dev` / `dev` → back on the app, signed in. The OIDC client
defaults target the dockerized realm (override via `VITE_OIDC_*`, see
[`apps/frontend/.env.example`](apps/frontend/.env.example)). Access the session
anywhere via the `useAuth()` hook (`user`, `login()`, `logout()`).

### CI ingestion webhook

Each repository gets a `webhookToken` (returned **once** in the create-repository
response). CI pipelines push events to the ingestion endpoint:

```bash
curl -X POST "$GROUNDPLAN_URL/api/v1/webhooks/ci/$REPOSITORY_ID" \
  -H "X-Groundplan-Token: $GROUNDPLAN_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"ref":"refs/heads/main","commit_sha":"'"$GITHUB_SHA"'","event":"push","payload":{}}'
```

Example GitHub Actions step:

```yaml
- name: Notify Groundplan
  run: |
    curl -X POST "${{ vars.GROUNDPLAN_URL }}/api/v1/webhooks/ci/${{ vars.GROUNDPLAN_REPOSITORY_ID }}" \
      -H "X-Groundplan-Token: ${{ secrets.GROUNDPLAN_TOKEN }}" \
      -H "Content-Type: application/json" \
      -d '{"ref":"${{ github.ref }}","commit_sha":"${{ github.sha }}","event":"push","payload":{}}'
```

Recent events (without payloads): `GET /api/v1/repositories/{id}/events`.

### Configuration

Backend config is read from environment variables (see
[`apps/backend/.env.example`](apps/backend/.env.example)). Copy it to
`apps/backend/.env` to override defaults:

```bash
cp apps/backend/.env.example apps/backend/.env
```

### Adding UI components

shadcn/ui is configured (`apps/frontend/components.json`). Add components with:

```bash
cd apps/frontend
pnpm dlx shadcn@latest add <component>
```

## Contributing

See [CLAUDE.md](CLAUDE.md) for architecture notes and conventions.
