# Registering the GitHub App

How to create the GitHub App that lets an organization connect GitHub from the
Integrations page instead of pasting a personal access token, and how to wire it
into a deployment.

The App is **optional**. Without it, GitHub repositories keep authenticating with
a PAT and the Integrations page honestly says so ("Token only on this instance").
Registering it changes nothing about existing repositories until someone switches
them over — and the switch is reversible.

## Before you start: it is an App, not an OAuth App

The connect button behaves like an OAuth flow — click, approve on GitHub, come
back connected — but GitHub is the one provider where the credential is **not**
an OAuth grant:

| | GitLab / Azure DevOps / Confluence | GitHub |
| --- | --- | --- |
| Registration | OAuth 2.0 application | **GitHub App** |
| Flow | Authorization code + PKCE | App installation |
| Stored secret | Rotating refresh token (encrypted) | **none** — only an installation id |
| Token per call | Access token from a refresh | Installation token, 1 hour |
| Acts as | The user who authorized | The App's own bot identity |

So there is no `client_id`/`client_secret` to configure for GitHub, and no
`redirect_uri` on GitHub's side that receives an authorization code. Groundplan
signs a short-lived RS256 JWT with the App's private key, exchanges it for an
installation token, and throws that token away when it expires
([github-app.ts](../apps/backend/src/integrations/adapters/github-app.ts)). Leave
**"Request user authorization (OAuth) during installation" unchecked** — we never
need to act as the person who installed it.

If you were looking for a classic GitHub *OAuth App*: the codebase does not
implement one. GitHub offers exactly two credential modes, `installation_app` and
`pat` ([github.ts:80](../apps/backend/src/integrations/adapters/github.ts#L80)).

## Prerequisites

- **Owner or admin of the GitHub organization** that holds the repositories
  (personal accounts work too — install it on yourself).
- **Owner or admin in the Groundplan organization** — connecting requires the
  `integration:manage` permission.
- **`PUBLIC_BASE_URL` set** on the backend, e.g. `https://groundplan.example.com`.
  It is where GitHub sends the browser back; without it, `POST
  /connections/start` answers 422 and the Connect button fails. In
  `docker-compose.prod.yml` it is derived from `APP_DOMAIN` — nothing to do.
- The App must be reachable at that origin only for **webhooks**, which are
  optional (see below). The connect flow itself is browser-driven, so it works
  even when GitHub cannot reach your network.

## Step 1 — Register the App

Register it under the **organization** that owns the repositories
(`https://github.com/organizations/<ORG>/settings/apps/new`), not under a
personal account, unless the repositories really are personal.

### Option A — prefilled form (recommended)

GitHub prefills the "New GitHub App" form from query parameters. Replace
`<ORG>` and `<ORIGIN>` (e.g. `https://groundplan.example.com`) and open:

```text
https://github.com/organizations/<ORG>/settings/apps/new
  ?name=groundplan
  &url=<ORIGIN>
  &description=Turns+Terraform+and+Kubernetes+changes+into+reviewable+architecture+diagrams,+posted+on+the+pull+request.
  &public=false
  &webhook_active=true
  &webhook_url=<ORIGIN>/api/v1/webhooks/git/github
  &setup_url=<ORIGIN>/integrations/callback
  &setup_on_update=true
  &request_oauth_on_install=false
  &contents=read
  &metadata=read
  &pull_requests=write
  &checks=write
  &events[]=push
  &events[]=pull_request
  &events[]=delete
```

(Join it into one line — it is split here for reading.) Review the form, set the
webhook secret, and click **Create GitHub App**.

### Option B — fill the form by hand

[github-app-manifest.json](github-app-manifest.json) is the same values in
GitHub's manifest shape; use it as the checklist:

| Field | Value |
| --- | --- |
| **GitHub App name** | `groundplan` (must be unique across GitHub — add your org name if taken) |
| **Homepage URL** | your Groundplan origin |
| **Callback URL** | leave empty (no user authorization) |
| **Request user authorization (OAuth) during installation** | **unchecked** |
| **Setup URL** | `<ORIGIN>/integrations/callback` |
| **Redirect on update** | checked |
| **Webhook → Active** | checked if GitHub can reach you, otherwise unchecked |
| **Webhook URL** | `<ORIGIN>/api/v1/webhooks/git/github` |
| **Webhook secret** | a random string you keep (`openssl rand -hex 32`) |
| **Repository permissions** | Contents: **Read-only** · Metadata: **Read-only** · Pull requests: **Read & write** · Checks: **Read & write** |
| **Subscribe to events** | Push, Pull request, Delete |
| **Where can this App be installed?** | *Only on this account* for a self-hosted deployment; *Any account* only if you host many tenants |

The **Setup URL** is what makes the flow work: after an install, GitHub sends the
browser there with `installation_id` and the `state` Groundplan minted. No setup
URL means no way back, and the connection is never recorded.

Nothing else is needed. The four permissions are the whole ask: read code to
parse it, read metadata, write the PR comment, publish a check. Groundplan never
asks for secrets, actions, admin, or org-level scopes.

### Option C — the manifest creation flow

GitHub can also create an App from a POSTed manifest and hand back the id, PEM
and webhook secret in one exchange. Be aware that
[github-app-manifest.json](github-app-manifest.json)'s `redirect_url` points
at the Groundplan callback page, which handles *installations*, not manifest
conversions — using it as-is lands the browser on "Connection not completed"
while the App is nonetheless created. If you want this path, point `redirect_url`
at a scratch page of your own that POSTs the returned `code` to
`https://api.github.com/app-manifests/<code>/conversions`. Options A and B are
less trouble.

## Step 2 — Collect four values

From the App's settings page, after it exists:

1. **App ID** — the number at the top of *General*.
2. **Private key** — *Private keys → Generate a private key*. GitHub downloads a
   `.pem` **once**; it is the App's identity, so treat it like a signing key.
3. **Slug** — the last segment of `https://github.com/apps/<slug>`. GitHub
   derives it from the name (`Groundplan` → `groundplan`); it is what the connect
   URL is built from, so a typo here is a 404 on GitHub's side.
4. **Webhook secret** — the one you just set, if you enabled webhooks.

## Step 3 — Configure the deployment

| Variable | Value |
| --- | --- |
| `GITHUB_APP_ID` | the numeric App id |
| `GITHUB_APP_PRIVATE_KEY` | the PEM, raw or base64-encoded |
| `GITHUB_APP_SLUG` | the URL slug |
| `GITHUB_APP_WEBHOOK_SECRET` | the webhook secret (optional) |

`GITHUB_APP_ID` **and** `GITHUB_APP_PRIVATE_KEY` together are the feature flag —
the `AI_API_KEY` posture. Either one empty and the App simply does not exist for
that instance: no install route, no button, no error at boot.

The PEM is multi-line, which most env files dislike, so base64-encode it — the
backend decodes either form
([env.ts:19](../apps/backend/src/config/env.ts#L19)):

```bash
base64 -w0 groundplan.2026-07-26.private-key.pem   # macOS: base64 -i <file>
```

In `.env.prod`:

```dotenv
GITHUB_APP_ID=1234567
GITHUB_APP_PRIVATE_KEY=LS0tLS1CRUdJTiBSU0EgUFJJVkFURSBLRVktLS0tLQo…
GITHUB_APP_SLUG=groundplan
GITHUB_APP_WEBHOOK_SECRET=…
```

Then restart the backend — the config is read at boot:

```bash
docker compose --env-file .env.prod -f docker-compose.prod.yml up -d api
```

Verify the instance sees it (any member of the org can call this):

```bash
curl -s -H "Authorization: Bearer $TOKEN" \
  https://<APP_DOMAIN>/api/v1/orgs/<ORG_ID>/connections/providers \
  | jq '.[] | select(.id=="github")'
# → "connectableModes": ["installation_app"]   ← configured
# → "connectableModes": []                     ← not configured
```

### Local development

Point `PUBLIC_BASE_URL` at the **frontend** dev server, since the callback page
is part of the SPA:

```dotenv
PUBLIC_BASE_URL=http://localhost:5173
```

and register a second, throwaway App whose Setup URL is
`http://localhost:5173/integrations/callback`. GitHub accepts `http://localhost`
here. Webhooks cannot reach a laptop without a tunnel (`smee`, `cloudflared`);
skip them — the ref poller covers the same ground every 60s.

## Step 4 — Install and connect

1. In Groundplan: **Organization settings → Integrations → GitHub → Connect**.
   This seals your org id into an opaque `state` and sends the browser to
   `https://github.com/apps/<slug>/installations/new?state=…`.
2. On GitHub, pick the account to install on and **which repositories** it may
   access. "Only select repositories" is the right default; the selection can be
   edited later without reconnecting — the installation id does not change.
3. GitHub returns to `/integrations/callback`. Groundplan proves the installation
   is real (an app-JWT call to `GET /app/installations/{id}`) *before* storing
   anything, then shows **Connected** with the account name.
4. Switch repositories over one at a time from their settings. Pull requests,
   docs and annotations hang off the repository, not off how it authenticates, so
   nothing is lost — and the stored PAT is kept, so you can switch back.

Reconnecting later (**Reconnect**) replaces the credential **in place** for the
same installation, so every repository pointing at it keeps working. **Revoke**
deletes the connection; repositories fall back to their own PAT if they have one,
and report "no access token configured" if they do not — nothing cascades.

## Webhooks (optional)

The App's webhook makes a merge regenerate documentation in seconds instead of
within a minute; that repository's poller then drops to a 15-minute safety net.
Everything works without it.

- **URL**: `https://<APP_DOMAIN>/api/v1/webhooks/git/github`
- **Secret**: `GITHUB_APP_WEBHOOK_SECRET` — one secret for every installation,
  verified as HMAC-SHA256 over the raw bytes of the delivery
  ([webhooks.ts:77](../apps/backend/src/integrations/webhooks.ts#L77)).
- **Events**: push, pull request, delete. Anything else is accepted and ignored
  (`202 {"handled":0}`), because providers send far more than we asked for.

A delivery that fails verification is `401` and does nothing. So is a delivery
about a repository this deployment does not know — deliberately identical, so the
endpoint cannot be used to enumerate what you watch. Deliveries are deduplicated
on the fact (repository, kind, branch, sha), not on the delivery, so a provider
retry and a poller tick for the same commit are handled once.

## What the App can and cannot do

The trust model does not change because you registered an App. It reads the code
your pipeline already produces and writes a comment back:

- **Can**: read repository contents and metadata, comment on pull requests,
  publish check runs — on the repositories you selected, and nothing else.
- **Cannot**: reach any cloud account. Groundplan holds no cloud credentials,
  never reads Terraform state, never runs `terraform`, `helm` or `kustomize`.
- **Stored**: the installation id and the account login. That is all — the row
  holds **no secret**. Installation tokens live in memory until they expire and
  are never written down; the private key stays in your deployment's env.

## Troubleshooting

| Symptom | Cause |
| --- | --- |
| No Connect button; "Token only on this instance" | `GITHUB_APP_ID` or `GITHUB_APP_PRIVATE_KEY` empty, or the backend was not restarted after editing them |
| Button visible but you cannot click it | You are a `member`; connecting needs owner/admin (`integration:manage`) |
| 422 "this deployment has no public base URL configured" | `PUBLIC_BASE_URL` is empty |
| GitHub 404 on the install page | `GITHUB_APP_SLUG` does not match `github.com/apps/<slug>` |
| "GitHub did not return an installation id" | The App has no **Setup URL**, or the App was installed from GitHub directly instead of via Connect. Set the Setup URL, then use the Connect button |
| "This callback is missing its state" / "connection attempt does not belong to this organization" | The callback was reached out of band, or the active org changed mid-flow. Start again from Integrations |
| `GitHub App API 401: A JSON web token could not be decoded` | The PEM was mangled by the env file (CRLF, quotes, lost newlines) — base64-encode it |
| Same 401 with a clean key | Server clock skew. The JWT is backdated 60s already; anything larger needs NTP |
| Comments stop: "the GitHub App installation is no longer available … reconnect this integration" | The App was uninstalled, or the repository was dropped from its selection. Re-add the repository on GitHub, or **Reconnect** |
| Webhook deliveries show 401 on GitHub | Secret mismatch, or the repository URL is not attached in Groundplan (both answer 401 by design) |

## See also

- [deployment.md](deployment.md) — the full self-host configuration,
  including GitLab OAuth, Entra ID and Atlassian 3LO, which *are* OAuth 2.0.
- [github-app-manifest.json](github-app-manifest.json) — the same
  registration as data.
