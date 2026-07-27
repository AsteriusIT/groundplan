---
title: Troubleshooting
description: Symptom, cause, remedy — ordered by where you got stuck, with the real messages rather than paraphrases.
---

For the moment something is not working. Find your symptom; the causes are
ordered by how often each one is the answer.

## Where the logs are

| Deployment | Command |
| --- | --- |
| Docker Compose | `docker compose --env-file .env.prod -f docker-compose.prod.yml logs -f backend migrate caddy` |
| Kubernetes | `kubectl -n groundplan logs deploy/groundplan-api`, and `kubectl -n groundplan logs job/groundplan-migrate` for the schema |

Two probes answer the first question: `GET /healthz` (the process is alive, no
database involved) and `GET /readyz` (`503` when Postgres is unreachable).

## The server does not start

| Symptom | Cause | Remedy |
| --- | --- | --- |
| The API container exits immediately; the log names `OIDC_ISSUER_URL` or `OIDC_AUDIENCE` | Fail-closed boot: production refuses to run without authentication configured | Set both. [OIDC](/reference/oidc/) |
| The API container exits immediately; the log names `ENCRYPTION_KEY` | Fail-closed boot: it will not hold credentials it cannot protect | `openssl rand -base64 32`. [The encryption key](/reference/encryption-key/) |
| `/readyz` returns `503`, `/healthz` is fine | Postgres unreachable or credentials wrong | Check `DATABASE_URL`, network policy, and that special characters in the password are URL-encoded |
| Every request `500`s right after a first all-in-one Helm install | Migrations still running — in embedded mode they are a post-install hook | `kubectl logs job/groundplan-migrate`; wait for it |
| `helm template` fails with a full sentence | Deliberate: an impossible values combination (two database modes, two identity providers, two sources for one secret) | The message names the value to remove |
| No TLS certificate is issued | Port 80 unreachable from the internet, or DNS not pointing here yet | Check both; the edge's log says which challenge failed |

## Signing in fails

| Symptom | Cause | Remedy |
| --- | --- | --- |
| Redirect loop between the app and the identity provider | The redirect URI is not registered exactly, or the issuer in `frontend-config.json` differs from `OIDC_ISSUER_URL` | Make the strings identical — including the trailing slash — and register `https://<host>/callback` |
| Login succeeds, then every API call is `401` | The access token's `aud` does not contain `OIDC_AUDIENCE` | Add the audience mapper, or request the API scope. Decode the token and look |
| `401` with a token that looks correct | Clock skew, or the API cannot reach the issuer for discovery | Check NTP on both hosts; check the API can resolve and reach `OIDC_ISSUER_URL` |
| The frontend serves a directory listing | `frontend-config.json` did not exist at the first `up`, so Docker created a directory in its place | Remove the directory, create the file, `up -d` |

## The repository does not clone

| Symptom | Cause | Remedy |
| --- | --- | --- |
| `authentication failed` on the repository | The token expired, was revoked, or lacks read scope | Re-enter it. Credentials are write-only, so it cannot be inspected — replacing is the only check |
| Works from your laptop, not from the server | Provider username conventions differ (GitLab wants `oauth2`, Azure DevOps accepts any username with a PAT) | Attach with the provider selected rather than as generic git, so the right convention is used |
| `repository not found` for a repository that exists | A private repository with a token that cannot see it, or the wrong URL | Both providers answer `404` to an unauthorised read — check the token first |
| It cloned once and then stopped | The credential was rotated at the provider | Update it; the repository keeps its history |

## The plan is pushed and nothing appears

| Symptom | Cause | Remedy |
| --- | --- | --- |
| The CLI prints `authentication failed (401) — check GROUNDPLAN_TOKEN…` | Wrong or rotated webhook token | Copy it again from the repository's CI setup page |
| The CLI prints `repository not found (404) — check GROUNDPLAN_URL…` | The URL belongs to a different repository, or a different organization | Re-copy it; it contains the repository id |
| The CLI prints `the payload is too large (413)` | Over the 10 MB ingestion cap | Split the estate across repositories or paths |
| The CI step is green and nothing arrived | The step never ran — a fork pull request gets no repository secrets on GitHub | Check the job's condition, not the token |
| The pull request is not listed | The detected branch is not the pull request's head | The CLI prints what it detected; override with `--branch` / `--sha` / `--pr` |
| A `422` with a sentence | The artefact is not what the endpoint accepts — for example a normal plan sent to `push-drift` | The message says which command produces the right one |

## The pull-request comment is missing

| Symptom | Cause | Remedy |
| --- | --- | --- |
| The diagram exists, no comment appears | The credential can read but not write pull requests | Grant write, or use a GitHub App installation |
| The comment stopped updating | The connection is in **Reconnect required** after a revoked authorization | Reconnect it from the integrations page |
| Several comments on one pull request | Not a supported state — one comment per plan snapshot is updated in place | Check that two repositories are not attached to the same provider repository |

## The documentation of main does not regenerate

| Symptom | Cause | Remedy |
| --- | --- | --- |
| Nothing happens after a merge | The tracked branch is not the one you merged into | Check the repository's default branch setting |
| It regenerated but is nearly empty | The configured path no longer exists | Fix the repository's path; an empty tree parses to an empty graph |
| It lags by up to a minute | Normal: the poller runs every 60 seconds | Add a provider webhook for seconds instead. [Integrations](/admin/integrations/#webhooks-or-the-poller) |
| A file fails to parse | A syntax error, or HCL the parser does not cover | The affected file is named and the snapshot is marked partial — the rest is still drawn |

## The diagram is unreadable

| Symptom | Cause | Remedy |
| --- | --- | --- |
| One node everything connects to | A hub resource — a resource group, a virtual network | Use the Network lens, where containment replaces the star, or filter by module |
| Too much on screen | The whole estate at once | Filters (change, category, module), search (`/`) to fly to a resource, focus mode for a clean canvas |
| A lens is not offered | It would be empty, so it is not shown | Expected — [Lenses](/use/lenses/#a-lens-that-is-missing) |

## The cluster diagram is incomplete

| Symptom | Cause | Remedy |
| --- | --- | --- |
| A warning naming skipped kinds | The kubeconfig's RBAC does not allow listing them | Expected and deliberate. Widen the role, or accept the partial diagram — [Live clusters](/use/live-clusters/) |
| No namespaces in the picker | The credential cannot list namespaces cluster-wide | Add `list` on `namespaces`, or use a kubeconfig with a default namespace |
| The cluster cannot be attached | It is unreachable from the server, or the kubeconfig is invalid | Verification runs at attach time, on purpose, so this fails immediately rather than later |

## Reporting something not on this page

Include: the version you are running, the deployment mode (Compose or Helm),
what you pushed (plan, refresh-only plan, state, manifests) and the exact
message. Those four facts answer most questions before anyone has to reproduce
anything.
