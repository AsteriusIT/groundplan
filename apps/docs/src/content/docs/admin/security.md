---
title: Security posture
description: Answers for a vendor security questionnaire — what is held, what is encrypted, what is isolated, and what is deliberately absent.
---

For a security reviewer, and written to be usable as-is in a questionnaire
response. Every claim below is a property of the code, checkable against the
repository, and none of them is a roadmap item.

## What %PRODUCT% has access to

| Access | Held? |
| --- | --- |
| Cloud credentials (subscription, IAM role, access key) | **Never.** None exist anywhere in the product. |
| Terraform state backend | **Never.** A state is parsed and stripped by the CLI on your machine; only the derived graph is sent, and a raw state posted at the API is refused. |
| Executing `terraform`, `helm` or `kustomize` **against your infrastructure, state or code** | **Never.** Your pipeline renders; the product ingests the output. The one place the `terraform` binary runs at all is the [resource catalog](#the-resource-catalog) worker, on a generated empty configuration — see below. |
| Repository read access | Yes — a credential you supply, to clone. |
| Repository write access | Only to comment on pull requests, only if you grant it. |
| A Kubernetes cluster | Only if you attach one: a read-only kubeconfig, LIST verbs only, [Secret values never fetched](/use/live-clusters/). |
| An AI provider | Only if you configure a key, and it receives [product-generated briefs](/ai/) — never source code or plan files. |

This is the moat and the design constraint: the product is fed artefacts your
own systems produce, so a compromise of it does not become a compromise of your
cloud.

## The resource catalog

The visual builder — off by default, enabled per deployment — offers real
resource types with real arguments, and those come from the providers
themselves. Reading them is the single place this product runs the `terraform`
binary, so it is worth stating exactly.

A separate worker writes a configuration and runs Terraform against **it**: a
`required_providers` block pinning one exact version of one allowlisted public
provider, and nothing else. No resources, no backend, no variables, no
credentials — there are none to supply. `terraform init` downloads the
provider, `terraform providers schema -json` asks it to describe itself, the
schemas are stored, and the directory is deleted. Your infrastructure, your
state and your code are not involved at any point.

What bounds it:

- **An allowlist, checked before anything is spawned.** A provider is an
  executable that `terraform init` downloads and runs, so an arbitrary
  namespace/name would be arbitrary code execution. Only the configured
  providers are ever fetched — four by default, and community providers are not
  supported.
- **Its own container**, non-root, with a checksum-verified pinned Terraform, no
  listening port, and deliberately **not** the API's environment: it holds a
  database URL and the catalog's settings, and none of the application's
  secrets.
- **Bounded resources**: a wall clock per command that kills the process group
  on expiry, a memory cap, and a temp directory removed on every path.
- **Restricted egress**: the Terraform registry and HashiCorp's release host.
  Nothing else.

An air-gapped deployment can switch the whole thing off
(`CATALOG_REFRESH=disabled`) and still have the complete builder: every release
bundles a snapshot of the schemas, imported on first boot. The interface then
labels the catalog **pinned**, with the provider version and the date it was
read, rather than presenting it as current.

## Secrets at rest

Repository tokens, OAuth refresh tokens, kubeconfigs and Confluence credentials
are encrypted with **AES-256-GCM** under a key supplied at deployment
(`ENCRYPTION_KEY`, [details](/reference/encryption-key/)) and are **write-only**:
once stored, no API response and no interface ever returns them, to anybody,
including the person who entered them. Responses go through a mapper that masks
them as `***`.

Authenticated clone URLs are never logged; errors carrying one are redacted
before they reach a log line.

## Tokens and comparisons

- Webhook tokens are compared in **constant time**, so a comparison cannot be
  timed to recover one.
- A repository's webhook token is shown **once**, at creation, and is rotatable
  at any time; rotation revokes the previous value immediately.
- Invitation tokens are stored as **SHA-256 hashes** — a database dump yields no
  usable invitation.

## Tenant isolation

Every organization-owned route is nested under the organization and guarded by
membership. A request crossing a tenant boundary is answered **`404`, never
`403`** — a `403` would confirm the resource exists, which is a disclosure by
itself.

There is no ownership below the organization: every member sees that
organization's estate. Separation between teams is separation between
organizations. See [Organizations & roles](/admin/organizations/).

## Authentication

OIDC resource-server authentication; the browser app uses Authorization Code
with PKCE and holds no client secret. There is no local password store, no
password reset flow, and no session cookie to steal — which also means account
lockout, MFA and password policy are your identity provider's, where your
security team already manages them.

In production the API **fails closed**: with no OIDC configuration or no
encryption key it refuses to start.

## Input handling

- **10 MB cap** on an ingested plan or manifest body; oversized bodies are
  rejected with that reason.
- **Path traversal is blocked** on every file read from a clone.
- Repository URLs must be **HTTPS**.
- A body that cannot be parsed is a `422` that **stores nothing** — half a graph
  would read as a deletion.
- Model output is treated as untrusted input: rendered as Markdown, never as
  HTML.
- Public share links are rate-limited per IP and revocable; AI content is
  excluded from them by construction.

## Supply chain

Release images are scanned with Trivy **before** they are published, and a
fixable `CRITICAL` finding fails the build so nothing is pushed. Images are
tagged by semantic version and by commit sha, so a deployment is traceable to a
commit.

The CLI has **zero runtime dependencies** — deliberately, because it is the one
piece of this product that runs inside your pipeline.

## Data residency and deletion

%PRODUCT% self-hosted holds its data in the Postgres you provide, on the
infrastructure you chose. Deleting a repository deletes its snapshots,
annotations, reports and credential. Deleting the organization deletes its
estate. There is no external service the product depends on at runtime, and no
telemetry: neither the server nor the
[VS Code extension](/use/vscode/) phones home.

## What does not exist

Stated plainly, because a questionnaire will ask:

- **No compliance certification.** None is claimed, and none is held.
- **No audit log** of user actions (the policy waiver trail is the one
  append-only history that exists).
- **No SSO group-to-role mapping**; roles are managed in the product.
- **No per-project permissions**, no service accounts, no IP allowlisting.
- **No SMTP** anywhere — invitations are copy-the-link.
- **No community provider support** in the visual builder. The catalog covers
  the providers a deployment allowlists; anything else is composed as a custom
  resource, checked as syntax only.

## Reporting a vulnerability

Report it privately through the repository's security contact rather than in a
public issue, with the version and the deployment mode. The
[repository](https://github.com/AsteriusIT/groundplan) is the canonical place to
check what a given release contains.
