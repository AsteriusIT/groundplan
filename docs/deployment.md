# Production deployment

> Deploying on **Kubernetes**? Use the Helm chart instead —
> see [install-kubernetes.md](install-kubernetes.md).

A single, self-contained `docker-compose.prod.yml` runs the whole platform —
frontend, API, both databases, and the Keycloak identity provider — behind a
Caddy edge that terminates TLS with automatic Let's Encrypt certificates. No
external managed services are required.

## Topology

```text
                 Caddy  (:80 / :443, automatic HTTPS)
                 ├── ${APP_DOMAIN}
                 │     ├── /api/*  → backend:3000
                 │     └── /*      → frontend:80   (nginx, static SPA)
                 ├── ${WWW_DOMAIN}  → website:80   (nginx, marketing site)
                 ├── ${DOCS_DOMAIN} → docs:80      (nginx, documentation site)
                 └── ${AUTH_DOMAIN} → keycloak:8080
                                                     │
   backend:3000 ── app-postgres:5432                └── kc-postgres:5432
   (migrate one-shot applies the schema before backend starts)
```

Only Caddy publishes ports (`80`, `443`). Every other service talks over the
internal Docker network and is never exposed to the host.

| Service        | Image / build                      | Role                                      |
| -------------- | ---------------------------------- | ----------------------------------------- |
| `caddy`        | `caddy:2-alpine`                   | TLS termination + reverse proxy           |
| `frontend`     | `…/asteriusit/groundplan-frontend` | Static Vite SPA served by nginx           |
| `website`      | `…/asteriusit/groundplan-website`  | Static marketing site (`WWW_DOMAIN`)      |
| `docs`         | `…/asteriusit/groundplan-docs`     | Static documentation site (`DOCS_DOMAIN`) |
| `backend`      | `…/asteriusit/groundplan-backend`  | Fastify API (`node dist/index.js`)        |
| `migrate`      | `…/asteriusit/groundplan-backend`  | Applies Drizzle migrations, then exits    |
| `app-postgres` | `postgres:17-alpine`               | Application database                      |
| `keycloak`     | `…/asteriusit/groundplan-keycloak` | OIDC identity provider (pre-built)        |
| `kc-postgres`  | `postgres:17-alpine`               | Keycloak's own database                   |

## Prerequisites

1. **DNS** — `A`/`AAAA` records for `APP_DOMAIN` and `AUTH_DOMAIN` (and, if you
   serve them, `WWW_DOMAIN` and `DOCS_DOMAIN`) pointing at the host's public IP.
2. **Firewall** — inbound `80` and `443` (TCP; `443/udp` too for HTTP/3) open,
   so Caddy can complete the ACME challenge and serve traffic.
3. **Docker** with the Compose plugin.

The `frontend` and `backend` images are **pulled from the container registry**
(`rg.fr-par.scw.cloud/asteriusit` by default) — the deploy host needs no source
checkout. `docker-compose.prod.yml` never builds; building lives in
`docker-compose.build.yml`.

## Building & pushing images

### In CI (recommended)

The `.github/workflows/build-images.yml` workflow builds and pushes the images
to `rg.fr-par.scw.cloud/asteriusit` **and** `ghcr.io/asteriusit` (the public registry
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

### The resource catalog (optional worker)

The visual builder composes against real provider schemas. Every release bundles
a snapshot of them in the API image, so a fresh install has the complete builder
immediately and needs nothing else.

Tracking new provider versions adds one container, under its own profile:

```sh
docker compose --env-file .env.prod -f docker-compose.prod.yml --profile catalog up -d
```

It runs `terraform` against a **generated empty configuration** pinning one
allowlisted public provider, and asks that provider to describe itself — never
against your infrastructure, your state or your code. It holds no cloud
credentials, and deliberately does not get the API's environment: a database URL
and the catalog's own settings are its whole configuration.

`CATALOG_PROVIDERS` is an allowlist, not a preference: a provider is an
executable that `terraform init` downloads and runs, so nothing outside that
list is ever fetched. Its egress should be restricted to
`registry.terraform.io` and `releases.hashicorp.com`.

For an air-gapped host set `CATALOG_REFRESH=disabled` and do not start the
profile. Nothing outbound is attempted anywhere in the stack, the builder serves
the bundled snapshot, and the interface labels it **pinned** rather than
current.

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

### GitHub App (optional, GP-193)

Repositories can authenticate with a **GitHub App installation** instead of a
personal access token: comments arrive from the app's own bot identity, the
token minted for each call lives an hour, and access is revoked from GitHub in
one click. It is entirely optional — without it, GitHub repositories keep using
PATs, and the Integrations page says the App is not configured on this instance.

1. Register the app — [github-app-setup.md](github-app-setup.md) walks through
   it field by field, and `docs/github-app-manifest.json` is the same values as
   data. Replace every `REPLACE-WITH-YOUR-GROUNDPLAN-ORIGIN` with
   `https://${APP_DOMAIN}` first. The permissions it asks for are the minimum:
   `contents:read`, `metadata:read`, `pull_requests:write`, `checks:write`.
1. Generate a private key and put these in `.env.prod`:

| Variable                    | Value                                                   |
| --------------------------- | ------------------------------------------------------- |
| `GITHUB_APP_ID`             | The numeric app id from its settings page               |
| `GITHUB_APP_PRIVATE_KEY`    | The `.pem`, base64-encoded so it fits one line          |
| `GITHUB_APP_SLUG`           | The app's URL slug (`github.com/apps/<slug>`)           |
| `GITHUB_APP_WEBHOOK_SECRET` | The webhook secret you set on the app (optional)        |

   ```bash
   base64 -w0 groundplan.YYYY-MM-DD.private-key.pem
   ```

1. In Groundplan: **Organization settings → Integrations → Connect GitHub**,
   which installs the app on your GitHub organization and binds that
   installation to this Groundplan org. Then switch each repository over from
   its repository settings. Nothing is lost in the move — pull requests, docs
   and annotations hang off the repository, not off how it authenticates — and
   the stored PAT is kept, so the switch is reversible.

`PUBLIC_BASE_URL` must be set for the flow to work: it is where GitHub redirects
the browser back to. It already is in the compose file (derived from
`APP_DOMAIN`).

### GitLab OAuth (optional, GP-195)

The same idea as the GitHub App, in GitLab's shape: an OAuth application whose
refresh token we renew, so nobody pastes a long-lived personal token. Works on
`gitlab.com` and on a self-managed instance — an OAuth application belongs to an
instance, so a self-managed install registers its own and points `GITLAB_URL` at
it. Group access tokens remain a fine alternative, and PATs keep working.

Register the application (GitLab → Settings → Applications) with the scopes
`api` and `read_repository`, confidential, redirect URI
`https://${APP_DOMAIN}/integrations/callback`. Then:

| Variable                     | Value                                       |
| ---------------------------- | ------------------------------------------- |
| `GITLAB_OAUTH_CLIENT_ID`     | The application id                          |
| `GITLAB_OAUTH_CLIENT_SECRET` | The application secret                      |
| `GITLAB_URL`                 | Instance origin (default `https://gitlab.com`) |

Connect it from **Organization settings → Integrations**. If GitLab later
revokes the authorization, the connection shows **Reconnect required** rather
than failing quietly.

### Azure DevOps via Microsoft Entra ID (optional, GP-196)

Azure DevOps' own OAuth apps are deprecated, so access goes through an **Entra
ID app registration** asking for the Azure DevOps resource scope. The customer's
Microsoft tenant grants it, their conditional-access policies apply, and they
revoke it from their own admin centre — which is usually the first question
their security team asks.

Register a multi-tenant app (Entra admin centre → App registrations) with
redirect URI `https://${APP_DOMAIN}/integrations/callback` and a client secret,
then delegate permission to *Azure DevOps*. Admin consent is required in each
customer tenant.

| Variable                 | Value                                                    |
| ------------------------ | -------------------------------------------------------- |
| `ADO_ENTRA_CLIENT_ID`    | Application (client) id                                  |
| `ADO_ENTRA_CLIENT_SECRET`| Client secret                                            |
| `ADO_ENTRA_TENANT`       | `organizations` (default) or a tenant id for single-tenant |

Azure DevOps **Server** (on-premises) has no Entra tenant; it keeps using a PAT,
which is why the mode is offered beside `pat` and never instead of it.

### Confluence via Atlassian OAuth (optional, GP-197)

Instead of pasting a Confluence API token per site, an organization can connect
Atlassian once: we hold a refresh token and mint a short-lived Bearer token per
call. Existing API-token and Data Center PAT integrations keep working exactly
as they did — Data Center has no 3LO, so those modes never go away.

Create an **OAuth 2.0 (3LO)** app at developer.atlassian.com with callback
`https://${APP_DOMAIN}/integrations/callback` and the Confluence scopes
(`read:confluence-space.summary`, `read:confluence-content.all`,
`write:confluence-content`, `write:confluence-file`, plus `offline_access`).

| Variable                   | Value             |
| -------------------------- | ----------------- |
| `ATLASSIAN_CLIENT_ID`      | The app's client id     |
| `ATLASSIAN_CLIENT_SECRET`  | The app's client secret |

Then **Organization settings → Integrations → Connect Confluence**. Reconnecting
the same site replaces the credential in place, so pages already published keep
being updated rather than recreated.

### Provider webhooks (optional, GP-194)

The ref poller (`git ls-remote` every 60s) works everywhere and needs nothing
inbound — it is the only mechanism a private network install can use, and it
stays the default. Where the provider *can* reach you, a webhook makes a merge
regenerate the documentation in seconds instead of within a minute, and the
poller drops back to a safety-net pass (once every 15 minutes) for that
repository.

Point the provider at `https://${APP_DOMAIN}/api/v1/webhooks/git/<provider>`:

| Provider     | Secret it must send                                                |
| ------------ | ------------------------------------------------------------------ |
| GitHub       | HMAC signature from `GITHUB_APP_WEBHOOK_SECRET` (the App wires it)  |
| GitLab       | The repository's webhook token, in `X-Gitlab-Token`                 |
| Azure DevOps | The repository's webhook token, in `X-Groundplan-Token`             |

The repository's webhook token is the one already shown when it is attached (and
rotatable from its settings) — the same secret CI uses to push plans. Events
useful to send: push, pull request opened/updated/merged, branch deleted;
anything else is accepted and ignored.

A delivery that fails verification is `401` and does nothing. A delivery that
arrives twice — a provider retry, or the poller finding the same commit — is
processed once: events are deduplicated on the fact (repository, kind, branch,
sha), not the delivery.

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
the callback `https://groundplan.asteriusit.fr/callback`.

- **If you use a different `APP_DOMAIN`,** add `https://<your-app-domain>/*` to
  the client's redirect URIs (realm file, or the admin console at
  `https://${AUTH_DOMAIN}` after boot).
- `--import-realm` only imports when the realm doesn't yet exist. To re-apply
  edits after first boot, change it in the admin console or reset the
  `kc-postgres` volume.

### Optimized image

`groundplan-keycloak` is an [optimized Keycloak
image](https://www.keycloak.org/server/containers): `keycloak/Dockerfile` runs
`kc.sh build --db=postgres --health-enabled=true` with the carbon theme already
in `providers/`, so the Quarkus augmentation that stock Keycloak performs on
every boot is done once, at image build time (~10.9s → ~3.2s to
`/health/ready`). That is why the service runs `start --optimized`.

Two consequences:

- **The command and the image are a pair.** `start --optimized` against a stock
  Keycloak — or an image tag predating this — fails immediately with *"the
  '--optimized' flag was used for first ever server start"*. Pull the matching
  tag when you change one.
- **Build options are fixed in the image.** The database *vendor* and
  `KC_HEALTH_ENABLED` are baked in; editing them in `docker-compose.prod.yml`
  has no effect under `--optimized`. Connection URL, credentials, hostname,
  proxy headers and cache mode remain ordinary runtime settings.

`start-dev` ignores the pre-built configuration and re-augments itself onto the
embedded file database, so the same image still serves the dev compose profile
and the eval-only Keycloak in the Helm chart unchanged.

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
