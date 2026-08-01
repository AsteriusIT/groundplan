---
title: Configuration
description: Every environment variable the API reads — what it does, its default, and what happens when it is absent.
---

The reference both installation guides point at. It is for whoever operates the
deployment, and it is complete by construction: a test compares this page
against the API's configuration module, so a variable added to the code without
a row here fails the build.

Absent means absent — every variable below is read from the process
environment, so it is set the same way in a compose file, a Kubernetes
`extraEnv`, a systemd unit or a shell.

## Required in production

Two things, and the API **refuses to boot** without them rather than starting in
a weaker mode. That is deliberate: a deployment that silently ran without
authentication would be a worse outcome than one that did not start.

| Variable | Effect | If absent |
| --- | --- | --- |
| `OIDC_ISSUER_URL` | The identity provider's issuer URL (discovery base). Must equal the `iss` claim of the tokens it mints, exactly. | Production refuses to boot. In development it defaults to the bundled provider on `localhost:8085`; set it to empty to run development without authentication. |
| `OIDC_AUDIENCE` | The `aud` claim an access token must carry to be accepted. | Production refuses to boot. Development defaults to `groundplan-api`. |
| `ENCRYPTION_KEY` | Base64 of 32 random bytes. Encrypts every stored credential at rest. | Production refuses to boot. Development and test use a fixed built-in key, which is why neither is a place to keep real credentials. See [The encryption key](/reference/encryption-key/). |

## Server

| Variable | Default | Effect |
| --- | --- | --- |
| `NODE_ENV` | `development` | `production` turns on the fail-closed checks above. Set it. |
| `HOST` | `0.0.0.0` | Interface to bind. |
| `PORT` | `3000` | Port to bind. |
| `CORS_ORIGIN` | `http://localhost:5173` | Origin(s) allowed to call the API, comma-separated, or `*`. In a single-origin deployment (the edge routes `/api` on the same host) this never matters; it does the moment the frontend is served from elsewhere. |
| `PUBLIC_BASE_URL` | empty | The absolute origin this deployment is reachable at, e.g. `https://groundplan.example.com`. Used for the login-free URLs in pull-request comments and for OAuth redirect URIs. Empty means comments carry stats and summary but no image and no link, and the OAuth connect flows cannot complete. |
| `EXPORT_CACHE_DIR` | a directory under the system temp dir | Where rendered SVG/PNG exports are cached. Pure cache: deleting it costs a re-render, nothing else. |

## Database

| Variable | Default | Effect |
| --- | --- | --- |
| `DATABASE_URL` | `postgres://groundplan:groundplan@localhost:5432/groundplan` | Postgres connection string. The default matches the development compose file, so it is never right in production. Special characters in the user or password must be URL-encoded. |

Migrations are applied by a separate one-shot process under a Postgres advisory
lock, so several instances starting at once cannot both apply them.

## Tenancy

| Variable | Default | Effect |
| --- | --- | --- |
| `SINGLE_ORG` | `true` | `true` is self-host mode: every user who logs in auto-joins one seeded organization, the **very first user ever** becomes its `owner` and everybody after is a `member`, creating organizations is disabled, and the frontend hides the switcher and the create-organization flow. `false` is multi-tenant: no auto-join, a new user without a membership or a pending invitation lands on a create-organization screen and owns what they create. |

Decide before the first login. Flipping the flag later does not move existing
users between the two models — their memberships already exist. Details:
[Organizations & roles](/admin/organizations/).

## The AI layer

| Variable | Default | Effect |
| --- | --- | --- |
| `AI_API_KEY` | empty | **The key is the feature flag.** Unset, the AI layer does not exist: the status endpoint reports it disabled, the generation routes answer `404`, and the frontend renders no AI surface at all. There is no development default, on purpose. |
| `AI_MODEL` | `claude-opus-4-8` | The model generations are labelled with and billed to. Read only when a key is set. |

What the model does and does not see is on [The AI layer](/ai/).

## The visual builder

| Variable | Default | Effect |
| --- | --- | --- |
| `BUILDER_ENABLED` | `false` | Opt-in. Turns on Build mode in the playground: compose resources on a canvas and generate Terraform from what you composed. Unset, the feature does not exist — the status endpoint reports it disabled, the generation route answers `404`, and the playground shows no Build surface. Anything but `true` leaves it off. |

Generation is deterministic and runs on the server with no model involved and no
cloud access: the same composition produces the same files.

It is one-way scaffolding. The generated files land in the playground, and from
there the Terraform is the source of truth; editing it does not move the sketch,
and existing Terraform is never read back into the builder.

## The resource catalog

Build mode composes against the real provider schemas, read from the providers
themselves by a separate worker: it runs Terraform against a generated empty
configuration that pins one allowlisted public provider, and asks that provider
to describe itself. Never against your infrastructure, your state or your code.

| Variable | Default | Effect |
| --- | --- | --- |
| `CATALOG_PROVIDERS` | the four below | Comma-separated `namespace/name` allowlist of the providers whose schemas may be read. This is a security boundary, not a preference: a provider is an executable, so nothing outside this list is ever downloaded, and a malformed entry is dropped rather than trusted. Empty means `hashicorp/azurerm`, `hashicorp/aws`, `hashicorp/google`, `hashicorp/kubernetes`. |
| `CATALOG_REFRESH` | `auto` | `disabled` makes the deployment air-gapped as far as the catalog goes: no outbound call at all, and what is stored is served and labelled as pinned rather than passed off as current. Anything other than `disabled` is `auto`. |
| `CATALOG_TTL_MS` | `21600000` (6h) | How long an answer from the provider registry is trusted before asking again. A provider ships a few times a month. |
| `CATALOG_REFRESH_INTERVAL_MS` | `1800000` (30m) | How often the refresh loop runs. Each pass only asks the registry if `CATALOG_TTL_MS` has elapsed, so this is a heartbeat, not a schedule. `0` disables the timer. |
| `CATALOG_EXTRACT_TIMEOUT_MS` | `600000` (10m) | Wall clock for one extraction command, read by the catalog worker. On expiry the process group is killed, the version is recorded as failed, and the previous one keeps being served. |
| `TERRAFORM_BIN` | `terraform` | The binary the catalog worker runs. Only the worker image ships one; the API never spawns it. |
| `TF_PLUGIN_CACHE_DIR` | a temp directory | Terraform's shared plugin cache, mounted as a volume in the worker. Without it every pass re-downloads the provider — hundreds of megabytes for `azurerm`. |
| `CATALOG_SNAPSHOT` | `catalog-snapshot.json.gz` | The bundled snapshot the API seeds an empty catalog from on first boot, so a fresh install — air-gapped or not — has the complete builder immediately. A missing file is not an error: the builder falls back to its curated resources and says so. Empty disables the seeding. |

## Ingestion and polling

| Variable | Default | Effect |
| --- | --- | --- |
| `REF_POLL_INTERVAL_MS` | `60000` | How often each repository's remote branches are checked with `git ls-remote`, which is what regenerates the documentation after a merge. `0` disables the background timer entirely — which is what the test suite does so it can drive a tick by hand. A repository that also receives provider webhooks is polled at a slower safety-net cadence instead. |

The 10 MB cap on a pushed plan is not configurable. It is a bound on what a
single webhook body may cost the server, not a preference.

## Git provider integrations (all optional)

Each of these is a **pair, and the pair is the flag** — the `AI_API_KEY`
posture. Without them, repositories on that provider keep authenticating with a
personal access token, and the interface says the integration is not configured
on this instance. Setup for each: [Integrations](/admin/integrations/).

| Variable | Default | Effect |
| --- | --- | --- |
| `GITHUB_APP_ID` | empty | Numeric id of a GitHub App registration. With the private key, enables installation-based auth: hour-long tokens, comments from the App's own identity, revocable in one click from GitHub. |
| `GITHUB_APP_PRIVATE_KEY` | empty | The App's PEM. Base64-encoding it is accepted, so it survives a single-line variable. |
| `GITHUB_APP_SLUG` | empty | The App's URL slug, used to build its installation link. |
| `GITHUB_APP_WEBHOOK_SECRET` | empty | The secret GitHub signs webhook deliveries with. Deliveries that fail verification are `401` and do nothing. |
| `GITLAB_OAUTH_CLIENT_ID` | empty | GitLab OAuth application id. |
| `GITLAB_OAUTH_CLIENT_SECRET` | empty | Its secret. |
| `GITLAB_URL` | `https://gitlab.com` | The instance the OAuth application is registered on — set it for a self-managed GitLab. |
| `ADO_ENTRA_CLIENT_ID` | empty | Microsoft Entra ID app registration for Azure DevOps (its own OAuth apps are deprecated). |
| `ADO_ENTRA_CLIENT_SECRET` | empty | Its secret. |
| `ADO_ENTRA_TENANT` | `organizations` | The login-URL segment: `organizations` for any work or school account, a tenant id for a single-tenant registration. |
| `ATLASSIAN_CLIENT_ID` | empty | Atlassian OAuth 2.0 (3LO) app, for publishing to Confluence without a per-site API token. |
| `ATLASSIAN_CLIENT_SECRET` | empty | Its secret. |

Azure DevOps **Server** (on-premises) has no Entra tenant and keeps using a
personal access token; Confluence **Data Center** has no 3LO and keeps using a
token or a Data Center PAT. Those modes are offered beside the OAuth ones, never
instead of them.

## Reading this page against the code

The API's configuration lives in one module, and this page is tested against it:
every `process.env.*` it reads must appear in a table above. If you add a
variable, add its row in the same change — that is the only discipline that
keeps a reference page true.
