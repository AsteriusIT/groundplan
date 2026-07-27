---
title: Integrations
description: Connect Git providers and Confluence — personal access tokens, GitHub Apps, OAuth, and what happens when a connection expires.
---

For whoever connects %PRODUCT% to the systems it reads. Every external system
goes through one seam, so a provider offers only the capabilities it actually
implements and the product never guesses.

## Repository credentials

A repository needs a credential that can **clone** it. That is the minimum, and
with only that %PRODUCT% documents main and draws pull-request diagrams. To also
**comment** on pull requests, the credential needs write access to them — the
repository's settings say which capability is missing rather than failing
silently.

| Mode | Providers | What it is |
| --- | --- | --- |
| **Personal access token** | GitHub, GitLab, Azure DevOps, generic HTTPS git | The simplest start. Encrypted at rest, write-only afterwards. |
| **GitHub App installation** | GitHub | Hour-long tokens minted per call, comments from the App's own bot identity, revocable in one click from GitHub. |
| **OAuth application** | GitLab (cloud or self-managed) | A refresh token we renew, so nobody pastes a long-lived personal token. |
| **Microsoft Entra ID** | Azure DevOps | Azure DevOps' own OAuth apps are deprecated; access goes through an Entra app registration, so your tenant's conditional-access policies apply and your admins revoke it from their own console. |

Each optional mode is enabled by **a pair of environment variables, and the pair
is the flag**: without them, that provider offers personal access tokens only
and the interface says the integration is not configured on this instance. See
[Configuration](/reference/configuration/#git-provider-integrations-all-optional).

Azure DevOps **Server** (on-premises) has no Entra tenant and keeps using a
token. That mode is offered beside the others, never instead of them.

### Moving a repository between modes

Nothing is lost. Pull requests, documentation, annotations and policy history
hang off the repository, not off how it authenticates. The previous credential
is kept, so the switch is reversible.

## Confluence

The credential lives on an **organization-level integration** — created once,
verified against the base URL, and attachable by any number of repositories.
Managing one needs `integration:manage` (admin and above); members can pick from
the list.

Three credential shapes, depending on where Confluence lives: an Atlassian OAuth
2.0 (3LO) connection for Cloud, an API token, or a Data Center personal access
token. Data Center has no 3LO, which is why the token modes never go away.

Each repository then names a target: the integration to use, and a space key.
Publishing is idempotent — [Exports & sharing](/use/exports/#confluence).

## Webhooks, or the poller

Both keep the documentation of main current, and both funnel through the same
handler:

- **The poller** runs `git ls-remote` per repository (every 60 seconds by
  default) and needs nothing inbound. It works everywhere, including behind a
  firewall with no ingress at all, and it is the default.
- **A provider webhook** makes a merge regenerate in seconds instead of within a
  minute. A repository that receives webhooks is polled at a slower safety-net
  cadence instead of every tick.

Point the provider at `https://<your host>/api/v1/webhooks/git/<provider>`. The
secret is the repository's own webhook token — the same one CI uses to push
plans — except for GitHub Apps, which sign with the App's webhook secret.

A delivery that fails verification is `401` and does nothing. A delivery that
arrives twice — a provider retry, or the poller finding the same commit — is
processed **once**: events are deduplicated on the fact (repository, kind,
branch, sha), not on the delivery.

## When a connection stops working

A revoked authorization is the one failure that flips a connection to
**Reconnect required**, shown in the interface, rather than failing quietly
forever. Everything else — a rate limit, a network blip, a transient `5xx` — is
treated as transient and retried, because flipping a working connection to
"broken" over a five-minute outage would train people to ignore the state.

## Adding a provider

Providers live behind one registry and one capability contract, and a
contract test runs the same specification against every adapter. A new provider
is an adapter, not a new route and not a frontend change — which is why the
connect flow looks identical for all of them.
