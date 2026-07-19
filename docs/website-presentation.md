# Groundplan — Product Presentation for the Website

> Source document for the future marketing website. Every claim in here was
> verified against the code in this repository (July 2026). Sections marked
> **[copy]** are website-ready text; sections marked **[facts]** are proof
> points the site can safely assert. The last section lists what the site must
> **not** claim yet.

---

## 1. Positioning

**Working names:** `groundplan` (repo, CLI, VS Code extension) / _InfraCanvas_
(earlier product working name). A trademark check on "Groundplan" is still a
listed pre-launch step (`docs/vscode-publishing.md`).

**Tagline (already written, keep it):**

> **See your infrastructure. Review it. Shape it.**

**One-liner [copy]:**

> Groundplan turns Terraform and Kubernetes into living, interactive
> architecture diagrams — so teams review infrastructure changes visually,
> keep documentation permanently in sync with code, and see their cloud the
> way they think about it: as networks, permissions and systems, not
> thousands of lines of HCL.

**Trust-model one-liner [copy]:**

> **We ingest data, not access.** Groundplan reads the plan JSON and rendered
> manifests your own CI produces. It never holds cloud credentials, never
> reads your Terraform state, never runs `terraform`, `helm` or `kustomize`.
> Adoption is one pipeline step.

**Elevator pitch [copy]:**

> Every infrastructure change today is reviewed as a wall of HCL diff and a
> thousand-line `terraform plan`. Groundplan renders that change as a diagram:
> what's created, what's updated, what's destroyed — and what unchanged
> infrastructure is caught in the blast radius. Merge it, and the same diagram
> becomes your documentation, regenerated automatically on every push to main.
> No screenshots, no stale wiki, no draw.io archaeology.

---

## 2. Who it's for

- **Platform / DevOps / SRE teams** who own Terraform estates and review each
  other's PRs.
- **Tech leads & architects** who need up-to-date architecture views without
  maintaining them by hand.
- **Security-conscious organisations** (the differentiator): teams that will
  not hand cloud credentials or state-backend access to a third-party tool.
- **Kubernetes teams** documenting manifests repos and inspecting live
  namespaces.

Problems the website should name:

1. Infra review is text review — reviewers approve plans nobody can picture.
2. Architecture documentation is dead the day it's drawn.
3. The blast radius of a change is invisible until it detonates.
4. Existing visualisers demand read access to your cloud or your state.

---

## 3. The three pillars (site structure follows the tagline)

### Pillar 1 — SEE: Visual pull-request review

**[copy]** Open a PR, get a diagram. Groundplan parses the `terraform plan`
JSON your CI already produces and draws the change: green for created, amber
for updated, red (dashed, struck through) for destroyed — and violet for the
resources you *didn't* touch but that depend on what you did. The unchanged
estate is ghosted so the change dominates the canvas.

**[facts]**
- Plan JSON → graph producer with explicit `depends_on` **and**
  expression-inferred dependencies (`graph/plan-parser.ts`, GP-13/20/21).
- **Impact propagation**: unchanged dependents are marked "impacted" with
  distance, framing the true blast radius (GP-22, shared
  `@groundplan/graph-differ`).
- **Attribute-level before → after diff** on every node, with sensitive
  values masked (GP-32).
- **Deterministic change summary** — rule-based Markdown (deletions first),
  identical output for identical input, no AI required (GP-36).
- **Risk badges**: `Exposed` (internet-facing via NSG analysis) and
  `Privileged` (high-privilege IAM at broad scope) flagged on nodes, PR rows
  and the dashboard (GP-43/47).
- **PR comments on GitHub, GitLab and Azure DevOps**: one idempotent comment
  per plan snapshot with an embedded changes-only PNG and a link to the
  interactive diagram (GP-38/53/54).
- **PR lifecycle**: PRs are fed by the webhook, soft-closed when the branch is
  deleted, history kept (GP-107/109).

### Pillar 2 — UNDERSTAND: Living documentation & lenses

**[copy]** Merge to main and the documentation redraws itself. Groundplan
statically parses your HCL — no plan, no apply needed — and keeps a versioned
diagram of your default branch. Then look at the same estate through the lens
that matches your question: the network, the permissions, the C4 big picture.

**[facts]**
- **Docs of main** from static HCL parsing (GP-15), **auto-regenerated on
  merge** by a background ref poller — zero user action (GP-23/107/108).
- **Snapshot history timeline** + **compare mode**: diff two documentation
  versions (added / removed / moved) with a summary strip (GP-26/40).
- **Five lenses on one graph**: Global, Adapted, C4, Network, IAM — switched
  in place, deep-linkable via URL (`?view=`).
- **Network view**: real vnet ⊃ subnet ⊃ resource containment, NSG rule
  inspection, internet-exposure highlighting, hub-edge taming (GP-42..45).
- **IAM view**: principal → role → scope table with privileged-assignment
  flags and drill-down to source (GP-47..49).
- **C4 view**: your annotation groups collapsed to one node per system, with
  aggregated edge counts and drill-into-group (GP-77).
- **Search, filters, legend, focus mode**: fly-to search, filter by change /
  category / module, a persistent edge legend, fullscreen canvas.
- **Server-rendered SVG/PNG export**, cached and deterministic (GP-37), plus
  "changes only" export on PRs.
- **Public share links**: tokenized, read-only, no login — "always latest" or
  pinned to a version, revocable, rate-limited, never exposing AI content
  (GP-39).

### Pillar 3 — SHAPE: The annotation layer

**[copy]** A generated diagram knows what exists; only your team knows what it
*means*. Groundplan lets you group resources into systems, rename them in
human language, hide the noise, draw the logical connections and pin notes —
without ever editing the generated model. Your annotations survive
regeneration: when a resource disappears, its annotations are flagged for
review, never silently deleted.

**[facts]**
- Five annotation types — **note, link, group, hide, rename** — anchored to
  Terraform addresses, stored beside (never inside) the snapshot (GP-56/71).
- **Adapted view**: a pure projection folds annotations into an ordinary
  graph, so the renderer needs no special cases (GP-72..74).
- **Orphan reconciliation**: when an anchor's address vanishes, the annotation
  flips to *orphaned* and a review tray offers re-anchor / keep / delete —
  and the flip reverses itself if the resource comes back (GP-57/59).
- **AI-proposed annotations** arrive in a review inbox, never on the canvas,
  each with a one-sentence reason; a human accepts, edits or dismisses every
  one. Provenance (human vs AI) is permanent (GP-75/76).
- **Project & repository context**: long-form Markdown that documents intent
  and grounds the AI summaries (GP-60).

---

## 4. The AI layer (opt-in, grounded, honest)

**[copy]** Groundplan's AI never replaces the deterministic view — it sits
beside it. And it never reads your plan files: every generation is grounded in
a brief rendered from Groundplan's own deterministic outputs. No API key
configured? The AI layer doesn't exist — no surfaces, no calls, no surprises.

**[facts]** — these are strong differentiators; the security page should own them:
- `AI_API_KEY` **is** the feature flag: unset ⇒ routes 404 and the frontend
  renders zero AI surface (GP-62).
- **The model never sees raw plan JSON or HCL from your repos** — only a
  deterministic Markdown brief built from Groundplan's own outputs
  (`services/ai-input.ts`, golden-tested).
- Generations are **user-triggered** (never on page load), **cached**
  (a second ask costs nothing), **streamed**, and **always labelled** with the
  model name.
- Model output is treated as **untrusted input**: rendered as Markdown (never
  HTML), hallucinated anchors dropped, non-JSON responses rejected and never
  cached.
- Features: **AI change summary** on PRs (GP-63/64), **"Explain this
  infrastructure"** on docs (GP-65), **AI annotation proposals** (GP-75), and
  **AI guided tours** — narrated, camera-driven walk-throughs of a change or
  an estate, in spotlight or guide-rail style (GP-78/79).

### AI Infrastructure Studio (experimental — label it as such)

**[copy]** Describe the infrastructure you want in plain English; watch the
Terraform being written and the architecture appear, node by node, on the
canvas. Inspect any resource's generated HCL, get instant best-practice
findings, and download the project as a zip — then run `terraform plan`
yourself, because you stay in control.

**[facts]**
- Streaming chat that regenerates a full Terraform project each turn
  (GP-137), ephemeral parse to a diagram (GP-138), progressive node
  highlighting (GP-142), code viewer with node ↔ file navigation + zip
  download (GP-143).
- **Deterministic lint pass** on generated HCL: 12 in-house security and
  best-practice rules (open NSG, exposed SSH/RDP, hardcoded secrets, public
  storage, weak TLS, VM password auth…) shown as severity badges (GP-139).
- Currently **Azure-focused** and flagged **Experimental** in the UI (GP-141).
  Sessions are in-memory only — nothing is stored.

---

## 5. Kubernetes

**[copy]** The same review-and-document loop, for Kubernetes. Point Groundplan
at a manifests repo and it documents main and reviews PRs by structural diff —
no plan file needed. Attach a live cluster (read-only) and draw any namespace
on demand.

**[facts]**
- Repositories declare `terraform` or `kubernetes`; every producer branches on
  it (GP-101).
- Raw YAML repos parsed from the clone; **Helm/Kustomize rendered by *your*
  CI** and pushed — Groundplan never executes them (GP-102/103).
- PR review works **without any plan**: the head graph is coloured by
  comparison against the latest docs of main (graph v7 attributes,
  `change-diff`).
- **Live clusters are read-only**: kubeconfig encrypted at rest (same rules as
  PATs), LIST-only API usage, **Secret values are never fetched, stored or
  drawn** — even when a manifest hands them over in the clear (GP-95..99).
- Namespace reads are on-demand only; RBAC-limited reads degrade honestly
  (skipped kinds are named in a warning, not hidden).

---

## 6. Developer experience

### The CLI — `@asteriusit/cli` (published, MIT)

**[copy]** One line in your pipeline:
`npx @asteriusit/cli push-plan --file plan.json`. It detects your branch, SHA
and PR number on GitHub Actions, GitLab CI and Azure DevOps, validates the
plan locally before any network call, retries transient failures, and fails
your CI step loudly when something's wrong.

**[facts]** zero runtime dependencies by design; 4xx errors mapped to
actionable messages; per-repo **and** app-wide webhook tokens, both rotatable;
an "ingestion status" readout in the UI answers "did my CI reach Groundplan?"
(GP-110/111).

### The VS Code extension — "Groundplan — Terraform Architecture Preview"

**[copy]** See your Terraform as a live architecture diagram beside your
editor, while you type. A new `resource` block appears in the diagram about a
second after you pause — before you even save. Click a node to jump to its
HCL; put your cursor in a block to light up its node. Toggle diff mode to see
your working tree against git HEAD or your branch's merge-base. Fully offline:
no account, no cloud calls, no telemetry — nothing is ever uploaded anywhere.

**[facts]** debounced 500 ms re-parse of dirty buffers; last-good graph on
parse errors with an out-of-sync chip; errors land in the Problems panel with
file + line; Network and IAM views included; diff mode with changed-only
toggle and per-SHA baseline cache (GP-145..156). Same parser, differ and
canvas packages as the web product — identical diagrams by construction.

### The Playground

**[copy]** Paste HCL or Kubernetes YAML, get a diagram. Multi-file, drag &
drop, savable drafts — nothing touches a repository. The fastest way to try
Groundplan (and a natural interactive demo for the website).

---

## 7. Teams, tenancy & authentication

**[facts]**
- **Organizations with RBAC**: owner / admin / member, permission matrix
  mirrored front- and backend, ownership transfer, "never remove the last
  owner" guarantees, invite links (single-use, expiring, hash-stored),
  org switcher, org deep links (GP-112..118).
- **Two modes from one flag**: `SINGLE_ORG=true` for self-hosting (first user
  becomes owner, everyone else auto-joins) or multi-org SaaS mode with
  onboarding and invitations.
- **OIDC / SSO**: standard resource-server auth (Authorization Code + PKCE in
  the SPA) — works with any OIDC identity provider; a fully branded Keycloak
  (login, account console and ~30-locale email templates in the product's
  carbon palette) ships in the box.
- **Fail-closed production**: the backend refuses to boot in production
  without OIDC config and an encryption key.

---

## 8. Security page (this can be a whole website page — it's the moat)

**[copy] headline:** *Your cloud credentials never leave your cloud.*

| Claim [copy] | Proof [facts] |
| --- | --- |
| We ingest data, not access | Only plan JSON / rendered YAML from *your* CI; no cloud SDK credentials, no state backends, no `terraform`/`helm`/`kustomize` execution anywhere in the codebase |
| Secrets are write-only | Repo PATs and kubeconfigs encrypted at rest (AES-256-GCM), masked as `***` in every response, never logged — clone URLs are token-redacted in errors |
| Tokens compared safely | Webhook & invite tokens use constant-time comparison; invite tokens stored as SHA-256 hashes |
| Tenants are isolated | Org-scope guard returns 404 (never 403) across tenants — no existence leaks |
| The AI is contained | Key = flag, off by default; model sees deterministic briefs only; output treated as untrusted; failures never cached |
| Kubernetes reads are minimal | LIST-only client; Secret *values* never fetched, stored or diffed |
| Public sharing is bounded | Tokenized, revocable, rate-limited (240/min/IP), AI content excluded |
| The supply chain is checked | Release images are Trivy-scanned in CI; fixable CRITICAL CVEs block the release |
| Hard boundaries elsewhere | Path traversal blocked on file reads; https-only repo URLs; 10 MB ingestion cap; per-target generation locks |

---

## 9. Deployment

**[copy]** Run the entire platform from one compose file: reverse proxy with
automatic HTTPS, frontend, API, database, identity provider. No managed
services, no external dependencies. Or let us run it for you (SaaS mode is the
same build with one flag).

**[facts]** `docker-compose.prod.yml` = Caddy (auto-TLS, HTTP/3) + frontend +
backend + migrate + Postgres + branded Keycloak + Keycloak DB; only Caddy
publishes ports; pull-based deploys from a registry; semver+SHA image tags.

---

## 10. Design & craft (the "why it feels good" section)

- **A blueprint identity**: drafting-paper grid canvas, three themes — light
  (drafting paper), **blueprint** (cyanotype deep blue, the signature) and
  **carbon** (graphite, default dark). Space Grotesk / Inter / IBM Plex Mono.
- **Official vendor icons, unmodified**: Azure (V24), AWS, GCP and Kubernetes
  community icons, bundled — never fetched at runtime.
- **Deterministic rendering as a principle**: same input, same diagram, same
  summary, same SVG — CI output you can trust byte-for-byte.
- **Honest UI as a principle**: partial diagrams declare their warnings; empty
  lenses hide rather than lie; AI is labelled, never ambient.
- **Accessibility is tested**, not assumed: automated axe assertions across
  the component suites; ARIA roles, keyboard shortcuts, reduced-chrome focus
  mode.

*(These principles are website copy gold — teams recognise a tool built by
people who review infrastructure for a living.)*

---

## 11. Integration matrix (for a compatibility section)

| Dimension | Supported today |
| --- | --- |
| IaC | Terraform (any provider parses; deepest semantics on Azure), Kubernetes manifests (raw YAML; Helm/Kustomize via CI-rendered output) |
| Git hosting | GitHub, GitLab, Azure DevOps, generic https git |
| PR comments | GitHub, GitLab, Azure DevOps |
| CI context auto-detection (CLI) | GitHub Actions, GitLab CI, Azure DevOps Pipelines |
| Icons / visual taxonomy | Azure, AWS, GCP, Kubernetes |
| Identity | Any OIDC provider (Keycloak bundled & themed) |
| IDE | VS Code (Marketplace + Open VSX planned; offline `.vsix` releases) |
| Live infrastructure | Kubernetes clusters (read-only) |

---

## 12. Suggested website structure

1. **Hero** — tagline + the PR-review diagram animating from a wall of HCL.
   CTA: "Try the playground" (no signup needed — it's already built).
2. **The problem strip** — the four problems from §2, one line each.
3. **Three pillars** — See / Understand / Shape, one section each (§3).
4. **"We ingest data, not access"** — the security/trust section (§8),
   placed high; it's the objection-killer.
5. **AI, done honestly** — §4 including the Studio (marked Experimental).
6. **Kubernetes** — §5.
7. **Works where you work** — CLI + VS Code + integration matrix (§6, §11).
8. **Self-host or SaaS** — §9 + single-org/multi-org story (§7).
9. **FAQ** — seeded below.
10. **CTA** — "One pipeline step away from seeing your infrastructure."

### FAQ seeds [copy]

- *Do you need access to our cloud account?* No. Groundplan never holds cloud
  credentials or state. Your CI sends us the plan JSON it already produces.
- *Do you run Terraform, Helm or Kustomize?* Never. Rendering happens in your
  CI; we ingest the output.
- *What does the AI see?* A Markdown brief rendered from Groundplan's own
  deterministic outputs — never your raw plan files. And with no API key
  configured, the AI layer is entirely absent.
- *Can we self-host?* Yes — the whole platform, including the identity
  provider, from one compose file with automatic HTTPS.
- *What if a diagram can't be fully built?* It says so. Partial diagrams carry
  explicit warnings; we never silently store an empty or misleading graph.
- *Does the VS Code extension send our code anywhere?* No. It parses locally,
  works fully offline and contains no telemetry.

---

## 13. What the website must NOT claim (yet)

- **No cost estimation.** Nothing in the product prices resources.
- **The AI Studio is experimental and Azure-only.** Present it as a preview.
- **Deep semantics are Azure-first.** Network containment, NSG exposure, IAM
  extraction and the join-resource catalog target `azurerm`. Any Terraform
  provider gets nodes, dependencies, modules and diffing — but don't promise
  AWS/GCP *network or IAM lenses* yet (icons exist; deep analysis doesn't).
- **Kubernetes snapshots get the diagram only** — no annotations, AI, tours or
  share links on K8s repos (deliberate; the summary carries the review).
- **No SMTP** — invitations are copy-the-link, not emailed.
- **VS Code extension limits** (its README states them honestly): first
  workspace folder only, not tuned for 500+ resource repos, no Helm/plan
  rendering in-editor.
- **No per-user resource ownership below the org** — everyone in an org sees
  the org's whole estate.
- **Naming**: clear the "Groundplan" trademark check before printing the name
  on a website.

---

## 14. One-paragraph summary (for meta description / press)

**[copy]** Groundplan turns Terraform and Kubernetes into living, interactive
architecture diagrams. It renders every pull request as a visual change — with
blast radius, security exposure and permission risks — and regenerates your
documentation on every merge. It reads only the plan JSON and manifests your
own CI produces: no cloud credentials, no state access, ever. With network,
IAM and C4 lenses, a human annotation layer, an honest opt-in AI, a CLI, a
live VS Code preview and one-file self-hosting, it's infrastructure review the
way it should have always worked: visible.
