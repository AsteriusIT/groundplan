# Groundplan — Project Brief (for the Claude.ai project)

> Paste-ready context document. Keep it in sync with `CLAUDE.md` and
> `docs/website-presentation.md` (the code-verified pitch source). Last
> refreshed: 2026-07-21, board state GP-1..GP-184.

## Pitch

**Tagline:** See your infrastructure. Review it. Shape it.

Groundplan turns Terraform and Kubernetes into living, interactive
architecture diagrams. Every pull request is rendered as a visual change —
created (green), updated (amber), destroyed (red), plus the unchanged
resources caught in the **blast radius** (violet, with distance) — with
security exposure and permission risks flagged. Merge it, and the same
diagram becomes the documentation, regenerated automatically on every push to
main. No screenshots, no stale wiki, no draw.io archaeology.

**Trust model (the differentiator): we ingest data, not access.** Groundplan
reads only the plan JSON and rendered manifests the user's own CI produces.
It never holds cloud credentials, never reads Terraform state, never runs
`terraform`, `helm` or `kustomize`. Adoption is one pipeline step. The one
deliberate extension: an optional read-only kubeconfig for live-cluster views
(encrypted, LIST-only, Secret values never fetched).

**Who it's for:** platform/DevOps/SRE teams reviewing Terraform PRs; tech
leads and architects who need always-current architecture views;
security-conscious organisations that refuse to hand credentials to a
third-party tool; Kubernetes teams documenting manifests repos and inspecting
live namespaces.

**Naming:** "groundplan" is the working name (repo, CLI, VS Code extension).
It is a **no-go as public name** (live trademark registrations in classes
9/42; npm/GitHub names squatted). Public launch waits on a cleared name —
"InfraCanvas" is the candidate. The marketing site stays noindex meanwhile.

## Product surface (implemented and tested)

**SEE — visual PR review**

- plan.json → graph with explicit and expression-inferred dependencies;
  impact propagation marks unchanged dependents (true blast radius).
- Attribute-level before→after diff per node, sensitive values masked.
- Deterministic rule-based change summary (identical input ⇒ identical
  Markdown, no AI required).
- Risk badges: `Exposed` (internet-facing via NSG analysis) and `Privileged`
  (broad-scope IAM), on nodes, PR rows and the dashboard.
- Idempotent PR comments on GitHub, GitLab and Azure DevOps with an embedded
  changes-only PNG and a link to the interactive diagram.
- GitOps loop: a background ref poller tracks branches, soft-closes PRs when
  the branch is deleted (history kept), auto-regenerates docs on merge.

**UNDERSTAND — living documentation & lenses**

- Docs of main from static HCL parsing (no plan or apply needed),
  auto-regenerated on merge; history timeline + compare-two-versions diff.
- Five lenses on one graph, switched in place and URL-deep-linkable:
  Global, Adapted, C4, **Network** (vnet ⊃ subnet ⊃ resource containment,
  NSG rule inspection, exposure highlighting, resource stacking — satellites
  render inside their host card), **IAM** (principal → role → scope table
  with privileged flags and source drill-down).
- Search/fly-to, filters, legend, focus mode; official Azure/AWS/GCP/
  Kubernetes icons bundled; three themes (light, blueprint, carbon default).
- Exports: cached server-rendered SVG/PNG; editable **draw.io** files (with a
  generated shape library); **Confluence** publish (one idempotently-updated
  page per repo: summary + diagram + backlink).
- Public share links: tokenized, read-only, revocable, rate-limited,
  "always latest" or pinned, AI content excluded.

**SHAPE — annotation layer**

- Five annotation types — note, link, group, hide, rename — anchored to
  Terraform addresses, stored beside (never inside) the generated snapshot.
- Adapted view = pure projection of annotations onto the graph; C4 view =
  annotation groups collapsed to one node per system.
- Orphan reconciliation: a vanished anchor flips the annotation to
  *orphaned* (never deletes) and a review tray offers re-anchor/keep/delete;
  the flip reverses if the resource returns.
- AI-proposed annotations arrive in a review inbox with a one-sentence
  reason each; a human accepts/edits/dismisses; provenance is permanent.

**AI layer (opt-in, grounded, honest)**

- `AI_API_KEY` is the feature flag: unset ⇒ no routes, no UI, no surprises.
- The model never sees raw plan JSON or repo HCL — only deterministic
  Markdown briefs built from Groundplan's own outputs.
- User-triggered, streamed, cached, always labelled with the model name;
  output treated as untrusted (Markdown only, hallucinated anchors dropped).
- Features: PR change summary, docs "Explain this infrastructure",
  annotation proposals, AI guided tours (narrated camera walk-throughs).
- **AI Infrastructure Studio (experimental, Azure-only):** describe
  infrastructure in plain English → streaming HCL generation → live diagram,
  per-resource code view, deterministic 12-rule security lint, zip download.
  Ephemeral — nothing stored.

**Kubernetes**

- Repositories declare `terraform` or `kubernetes`. Raw YAML parsed from the
  clone; Helm/Kustomize rendered by the *user's* CI and pushed.
- PR review without a plan: head graph coloured by comparison against the
  latest docs of main (graph-vs-graph diff).
- Live clusters (top-level, beside projects): read-only kubeconfig, draw any
  namespace on demand; RBAC-limited reads degrade honestly with warnings.
- K8s snapshots get the diagram + deterministic summary only (no
  annotations/AI/tours/share links — deliberate).

**Developer experience**

- **CLI** `@asteriusit/cli` (published, MIT, zero runtime deps):
  `npx @asteriusit/cli push-plan --file plan.json`; auto-detects branch/SHA/PR
  on GitHub Actions, GitLab CI, Azure DevOps; validates locally, retries,
  fails CI loudly.
- **VS Code extension** "Groundplan — Terraform Architecture Preview": live
  diagram beside the editor (~1 s after you pause typing, before saving),
  node ↔ code navigation, Network/IAM views, diff mode against HEAD or
  merge-base with changed-only filter. Fully offline, no telemetry — same
  parser/differ/canvas packages as the web product, identical diagrams by
  construction.
- **Playground**: paste multi-file HCL or Kubernetes YAML → diagram; savable
  drafts; CodeMirror editing; touches no repository.

**Teams, tenancy & security**

- Organizations with RBAC (owner/admin/member), permission matrix mirrored
  frontend/backend, ownership transfer, last-owner protection, single-use
  expiring invite links (copy-link, no SMTP). `SINGLE_ORG=true` for
  self-host; multi-org SaaS mode from the same build.
- Any OIDC provider (Authorization Code + PKCE); a fully carbon-branded
  Keycloak (login, account console, ~30-locale emails) ships in the box.
- Security posture: secrets write-only and AES-256-GCM encrypted (PATs,
  kubeconfigs, Confluence credentials), constant-time token comparison,
  cross-tenant requests answered 404 (never 403), 10 MB ingestion cap,
  path-traversal blocked, Trivy-gated release images, fail-closed production
  boot (no OIDC config or encryption key ⇒ refuses to start).

**Deployment**

- Self-host: one `docker-compose.prod.yml` (Caddy auto-TLS + frontend + API
  + migrations + Postgres + branded Keycloak).
- Kubernetes: Helm chart with external DB/IdP by default (eval-only embedded
  alternatives), migrations as a hook Job, golden-file tests and a kind
  smoke test in CI. Images on GHCR + Scaleway.
- Astro marketing website (`apps/website`), customer-language copy pinned by
  tests to the pitch document; noindex until naming clears.

## Architecture at a glance

pnpm monorepo (Node ≥ 22, TypeScript strict everywhere, TDD):

- `apps/backend` — Fastify 5 + Drizzle/Postgres API under `/api/v1`;
  org-owned resources nested under `/api/v1/orgs/:orgId`. Graph engine in
  `src/graph/` (parsers, impact, diffs, network/IAM extraction, projections,
  ELK layout, SVG/draw.io renderers, deterministic summaries, HCL lint).
- `apps/frontend` — React 19 + Vite + Tailwind v4 + shadcn/ui SPA.
- `apps/vscode` — offline extension host (esbuild) + webview (Vite).
- `apps/website` — Astro static site.
- `packages/graph-parser` — HCL → GraphSnapshot **and the shared graph
  schema** (v1..v8, versioned in place via optional fields).
- `packages/graph-differ` — pure static snapshot diff + impact.
- `packages/canvas` — the React Flow/ELK canvas + vendor icons, shared by
  frontend and VS Code webview.
- `packages/cli` — the published CI CLI.
- `keycloak/` — Keycloakify carbon theme; `deploy/chart/` — Helm chart.

One graph format, three producers: **A** plan.json (PR flow), **B** static
HCL (docs flow), **C** Kubernetes objects (manifests, CI-rendered, or live
namespace). Rendering is deterministic by principle: same input ⇒ same
diagram, same summary, same SVG.

## Implementation status (Jira project GP, 2026-07-21)

**Done epics** (all stories merged to main):

| Epic | Scope | Stories |
| --- | --- | --- |
| GP-1 | Foundation (apps, DB, OIDC auth, app shell) | GP-2..9 |
| GP-10 | Git MVP (repo attach, PR diagram, docs of main) | GP-11..18 |
| GP-19 | Real dependencies, blast radius, living docs | GP-20..26 |
| GP-27 | Design language v3 (tokens, icons, nodes, layout) | GP-28..33, 155, 156 |
| GP-34 | Review loop: PR comments, exports, share links, docs diff | GP-35..40 |
| GP-41 | Semantic network view | GP-42..45 |
| GP-46 | Semantic IAM view | GP-47..49 |
| GP-50 | Multi-provider Git (GitHub/GitLab/Azure DevOps) | GP-51..54 |
| GP-55 | Annotation & context layer foundation | GP-56..60 |
| GP-61 | AI layer v1 (PR summary, docs explain) | GP-62..65 |
| GP-66 | Real dashboard & thin settings | GP-67..69 |
| GP-70 | Annotations, adapted view, AI proposals, C4 | GP-71..77 |
| GP-85 | Resource stacking (network view v2) | GP-86..89 |
| GP-90 | AWS / GCP / Kubernetes icon coverage | GP-91..93 |
| GP-94 | Kubernetes live view (clusters, namespaces) | GP-95..99 |
| GP-100 | Kubernetes Git flow (manifests repos) | GP-101..105 |
| GP-106 | GitOps model: poller, PR lifecycle, CLI | GP-107..111 |
| GP-112 | Organizations & RBAC | GP-113..118 |
| GP-119 | Terraform source in docs view | GP-120..121 |
| GP-122 | Playground (HCL/YAML without Git, drafts) | GP-123..130 |
| GP-136 | AI Infrastructure Studio | GP-137..143 |
| GP-144 | VS Code extension (live preview) | GP-145..150 |
| GP-151 | VS Code live diff mode | GP-152..154 |
| GP-157 | Marketing website | GP-158..165 (GP-166 open) |
| GP-167 | Helm chart & Kubernetes install | GP-168..172 |
| GP-173 | Editable draw.io export | GP-174..177 |
| GP-178 | Confluence export (page quality + org integration) | GP-179..184 |

**Open / not implemented:**

- **GP-78 Cost-aware review** (GP-79..84, To Do): Infracost overlay as a
  sidecar beside the snapshot. **Nothing in the product prices resources
  today — never claim cost estimation.** (Note: git commits labelled
  GP-78/79 are the guided-tours work — a Jira key collision, not the cost
  feature.)
- **GP-131 Visual Builder** (GP-132..135, To Do): compose infrastructure
  visually → generate deterministic HCL (one-way scaffolding).
- **GP-166** (In Progress): trademark/domain clearance gate — "Groundplan"
  rejected; awaiting the founder's fallback name.

**Honesty list — what must not be claimed:** no cost estimation; AI Studio
is experimental and Azure-only; deep network/IAM semantics are Azure-first
(other providers get nodes/deps/modules/diffing); Kubernetes snapshots get
the diagram only; invitations are copy-link (no SMTP email); no per-user
ownership below the organization; the public name is not cleared yet.
