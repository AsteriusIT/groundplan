# Production deployment

A single, self-contained `docker-compose.prod.yml` runs the whole platform —
frontend, API, both databases, and the Keycloak identity provider — behind a
Caddy edge that terminates TLS with automatic Let's Encrypt certificates. No
external managed services are required.

## Topology

```
                 Caddy  (:80 / :443, automatic HTTPS)
                 ├── app.groundplan.qcs.ovh
                 │     ├── /api/*  → backend:3000
                 │     └── /*      → frontend:80   (nginx, static SPA)
                 └── auth.groundplan.qcs.ovh → keycloak:8080
                                                     │
   backend:3000 ── app-postgres:5432                └── kc-postgres:5432
   (migrate one-shot applies the schema before backend starts)
```

Only Caddy publishes ports (`80`, `443`). Every other service talks over the
internal Docker network and is never exposed to the host.

| Service        | Image / build                     | Role                                   |
| -------------- | --------------------------------- | -------------------------------------- |
| `caddy`        | `caddy:2-alpine`                  | TLS termination + reverse proxy        |
| `frontend`     | `…/eidos/groundplan-frontend`     | Static Vite SPA served by nginx        |
| `backend`      | `…/eidos/groundplan-backend`      | Fastify API (`node dist/index.js`)     |
| `migrate`      | `…/eidos/groundplan-backend`      | Applies Drizzle migrations, then exits |
| `app-postgres` | `postgres:17-alpine`              | Application database                   |
| `keycloak`     | `quay.io/keycloak/keycloak:26.1`  | OIDC identity provider                 |
| `kc-postgres`  | `postgres:17-alpine`              | Keycloak's own database                |

## Prerequisites

1. **DNS** — `A`/`AAAA` records for both `APP_DOMAIN` and `AUTH_DOMAIN`
   pointing at the host's public IP.
2. **Firewall** — inbound `80` and `443` (TCP; `443/udp` too for HTTP/3) open,
   so Caddy can complete the ACME challenge and serve traffic.
3. **Docker** with the Compose plugin.

The `frontend` and `backend` images are **pulled from the container registry**
(`rg.fr-par.scw.cloud/eidos` by default) — the deploy host needs no source
checkout. `docker-compose.prod.yml` never builds; building lives in
`docker-compose.build.yml`.

## Building & pushing images

### In CI (recommended)

The `.github/workflows/build-images.yml` workflow builds and pushes the images
to `rg.fr-par.scw.cloud/eidos` **and** `ghcr.io/asteriusit` (the public registry
the Helm chart defaults to) automatically. Push a version tag to publish:

```bash
git tag v1.2.3 && git push origin v1.2.3
# -> pushes groundplan-{backend,frontend}:1.2.3, :1.2 and :latest
```

`workflow_dispatch` (Actions tab → *build-images* → *Run workflow*) makes a
one-off build tagged only `sha-<short>`, without moving `latest`. It needs one
repository secret — **`SCW_SECRET_KEY`**, a Scaleway API secret key with
Container Registry write (the login user is the literal `nologin`).

Each image is scanned with [Trivy](https://trivy.dev) **before** it is pushed;
a fixable `CRITICAL` vulnerability fails the job and nothing is published (the
full report prints to the workflow logs).

### Locally

Run this where the source lives (your machine), not on the deploy host:

```bash
docker login rg.fr-par.scw.cloud
docker compose --env-file .env.prod -f docker-compose.build.yml build
docker compose --env-file .env.prod -f docker-compose.build.yml push
```

`REGISTRY` / `IMAGE_TAG` (in `.env.prod`) control where images are tagged and
pushed. The frontend image is environment-agnostic — it reads its runtime config
from a mounted `config.json` (see [Frontend runtime config](#frontend-runtime-config)),
so it isn't rebuilt per environment.

## First deploy

On the deploy host:

```bash
cp .env.prod.example .env.prod
# fill in every CHANGE ME value — passwords + ENCRYPTION_KEY (+ REGISTRY if not Scaleway)
cp frontend-config.json.example frontend-config.json
# set "oidcIssuer" to https://<AUTH_DOMAIN>/realms/groundplan (apiUrl stays "")
docker login rg.fr-par.scw.cloud   # if the registry is private
docker compose --env-file .env.prod -f docker-compose.prod.yml pull
docker compose --env-file .env.prod -f docker-compose.prod.yml up -d
```

> Create `frontend-config.json` **before** `up`: the compose file bind-mounts it,
> and if the source is missing Docker creates a directory in its place, which
> breaks the frontend.

Startup order is handled automatically: each Postgres becomes healthy → the
`migrate` job applies the schema and exits → the backend boots → Caddy starts
routing. Watch it come up with:

```bash
docker compose --env-file .env.prod -f docker-compose.prod.yml ps
docker compose --env-file .env.prod -f docker-compose.prod.yml logs -f caddy backend
```

## Configuration

All configuration lives in `.env.prod` (see `.env.prod.example` for the full
list and generator commands). The derived values below are assembled in the
compose file from the domains — you don't set them directly:

| Derived value                | Built from                                          |
| ---------------------------- | --------------------------------------------------- |
| Backend `OIDC_ISSUER_URL`    | `https://${AUTH_DOMAIN}/realms/groundplan`          |
| Backend `CORS_ORIGIN`        | `https://${APP_DOMAIN}`                             |
| Backend `PUBLIC_BASE_URL`    | `https://${APP_DOMAIN}`                             |

### Frontend runtime config

The frontend is configured at **runtime**, not build time. It fetches
`/config.json` on startup, and `docker-compose.prod.yml` mounts your
`./frontend-config.json` (on the deploy host) over the default baked into the
image. Create it from `frontend-config.json.example` and set the OIDC issuer to
match `AUTH_DOMAIN`:

```json
{
  "apiUrl": "",
  "oidcIssuer": "https://<AUTH_DOMAIN>/realms/groundplan",
  "oidcClientId": "groundplan-frontend"
}
```

`apiUrl` stays empty — the SPA calls `/api` on its own origin, which Caddy routes
to the backend. To change the issuer later, edit `frontend-config.json` and
restart just the frontend
(`docker compose --env-file .env.prod -f docker-compose.prod.yml up -d frontend`);
no image rebuild is needed.

### Deployment mode: single-org vs SaaS (`SINGLE_ORG`)

The backend runs in one of two tenancy modes, chosen by the `SINGLE_ORG`
environment variable (GP-115):

| `SINGLE_ORG` | Mode | Behaviour |
| --- | --- | --- |
| `true` (default) | **Single-org** (self-hosted) | Every user who logs in auto-joins the seeded **Default** organization. The **first user ever** becomes its `owner`; everyone after is a `member`. `POST /orgs` is disabled (400), and the frontend hides the org switcher and the create-org flow. This is what a team self-hosting one deployment for itself wants. |
| `false` | **SaaS** (multi-tenant) | No auto-join. A new user with no membership and no pending invite lands on a **create-organization** screen and becomes the `owner` of the org they create. Users see only the orgs they belong to. Choose this to host many independent tenants on one deployment. |

Leave `SINGLE_ORG` unset (or `true`) for the ordinary self-hosted case. To run
as SaaS, set `SINGLE_ORG=false` in `.env.prod` **before the first user logs in** —
flipping it later does not retroactively move existing users between the two
models (their memberships already exist). Role management within an org is the
same in both modes (owner > admin > member).

## Keycloak realm

The `groundplan` realm is imported on first boot from
`infra/keycloak/groundplan-realm.json`. Its `groundplan-frontend` client allows
the callback `https://app.groundplan.qcs.ovh/callback`.

- **If you use a different `APP_DOMAIN`,** add `https://<your-app-domain>/*` to
  the client's redirect URIs (realm file, or the admin console at
  `https://${AUTH_DOMAIN}` after boot).
- `--import-realm` only imports when the realm doesn't yet exist. To re-apply
  edits after first boot, change it in the admin console or reset the
  `kc-postgres` volume.

## Operations

```bash
# Deploy a new image build (after build + push from source)
docker compose --env-file .env.prod -f docker-compose.prod.yml pull
docker compose --env-file .env.prod -f docker-compose.prod.yml up -d

# Run migrations manually (also runs automatically on every `up`)
docker compose --env-file .env.prod -f docker-compose.prod.yml run --rm migrate

# Back up the application database
docker compose --env-file .env.prod -f docker-compose.prod.yml exec app-postgres \
  pg_dump -U groundplan groundplan > backup.sql
```

State that must survive restarts lives in named volumes: `app_pgdata`,
`kc_pgdata` (databases) and `caddy_data` (issued certificates — keep it to
avoid hitting Let's Encrypt rate limits on redeploys).

## Notes & assumptions

- The backend reaches Keycloak over its public URL for OIDC discovery, so the
  host must be able to resolve `AUTH_DOMAIN` (normal in cloud environments;
  relies on NAT hairpinning if self-hosted behind a single public IP).
- Certificates use the HTTP/TLS-ALPN challenge (per-subdomain). A single
  wildcard cert would instead need the DNS-01 challenge and a Caddy build that
  bundles your DNS provider plugin.
- TLS terminates at Caddy; the internal network is plain HTTP by design.
