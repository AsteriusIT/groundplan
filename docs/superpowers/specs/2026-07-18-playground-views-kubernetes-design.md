# Playground views + Kubernetes mode — design

Date: 2026-07-18
Status: approved (design), pending implementation plan

## Problem

The playground (GP-123..GP-130) parses scratch HCL onto the docs canvas —
and stops there. It offers none of the lenses the docs page has (Network,
IAM), and it speaks only Terraform: a `.yaml` manifest cannot even be
uploaded, although the backend has owned a complete YAML → graph pipeline
since GP-102 (`parseManifests` → `mapK8sObjects`).

## Decision (user-validated)

Three moves, each reusing an existing mechanism rather than inventing one:

1. **One parse endpoint, `iacType` branch** — `POST /playground/parse`
   gains an optional `iacType`, mirroring how `repositories.iac_type`
   branches producers (GP-101). Chosen over a second endpoint (duplicated
   client-side filtering) and over parse-both-return-both (bigger
   responses, murky error semantics).
2. **A centered Terraform/Kubernetes switch in the header**, both sides
   always visible (official logos via `IacTypeMark` + label), a side
   disabled when no matching files exist. Chosen over show-only-when-mixed
   and over a hard workspace-mode filter.
3. **Playground views: Global / Network / IAM in Terraform mode, diagram
   only in Kubernetes mode** — the GP-105 rule kept consistent. No
   Adapted/C4: the playground has no annotation layer.

## Backend — parse route (`routes/playground.ts`)

- `iacType: "terraform" | "kubernetes"` optional in the parse body,
  default `terraform` — the existing contract is unchanged for existing
  callers.
- The shared allowlist in `rejectInvalidFiles` widens to
  `.tf/.tfvars/.yaml/.yml`. It guards drafts too, so drafts hold manifests
  (and mixed sets) with **no schema change**.
- The route parses only the subset of files matching the mode and ignores
  the rest:
  - *terraform*: `parseHclRepo` over `.tf/.tfvars` — unchanged.
  - *kubernetes*: `parseManifests(subset, { rootDir: "" })` →
    `mapK8sObjects(objects, { unresolved })`, exactly the repo-docs
    pipeline (`services/repo-docs.ts`); `stats` carries
    `skippedDocuments` / `skippedFiles`.
- Errors, all 422 with the established `fields` shape:
  - zero files match the mode — "no .tf files to parse" /
    "no .yaml manifests to parse";
  - YAML that cannot be read at all (`InvalidManifestError`) — named per
    file, like the HCL skipped-file 422;
  - a manifest set where *nothing* is a Kubernetes object — refused, not
    stored as an empty diagram (the repo-docs rule, GP-102).
- Response shape `{graph, stats, summaryMd}` unchanged; `summarize`
  already handles any graph.

## Frontend — header switch + mode

- The header becomes a 3-zone grid: title block left, switch centered,
  status + drafts + Visualize right.
- The switch is a two-button segmented control; each side renders the
  official logomark (`IacTypeMark`, unmodified per `ICONS.md`) plus its
  label from `IAC_TYPE_LABELS`. A side with no matching files is disabled
  with a tooltip ("No .yaml files" / "No .tf files").
- Mode auto-selects **only** when the current side has zero files and the
  other has some — opening a manifests-only draft lands in Kubernetes
  mode; adding a yaml to a Terraform playground never yanks the mode.
- The last snapshot is kept **per mode** so flipping back shows that
  mode's last render, not a blank canvas. The parse failure is a single
  slot, cleared on mode switch (it describes the last parse).
- Visualize sends the whole file set + the active `iacType`; the server
  selects the subset. The modified-marker baseline keeps recording the
  whole set, so the marker stays "changed since I last looked" across
  modes.

## Frontend — files panel

- Uploads and drops accept the union of extensions always.
- The "+" menu offers **New Terraform file** and **New manifest**
  (`untitled-n.tf` / `untitled-n.yaml`) — creating a yaml file is how a
  scratch Kubernetes playground starts; its existence enables the switch
  side.
- Files not matching the active mode stay listed but muted, with a
  "Not in the <label> view" title. Error/modified dots behave as today.

## Frontend — views

- `viewsFor` gains a third variant, `"playground"`: Terraform →
  `["infra", "network", "iam"]`, Kubernetes → `["infra"]` (switcher
  removes itself, per its existing one-view rule). `INFRA_LABEL` for the
  variant is "Global".
- Tabs render in a slim `bg-card border-b` bar above the canvas once a
  snapshot exists, driven by `useGraphView` (`?view=` param, as
  everywhere).
- **Network** — the client-side `networkProjection` memo feeding
  `GraphCanvas` `containerIds`/`stacks`/`chips`, as the docs page does.
- **IAM** — `IamTable graph variant="docs"` with the jump-to-canvas
  wiring (switch to `infra`, select the node). The canvas section drops
  `blueprint-grid` for the IAM table, mirroring the docs page.

## Error handling / edge cases

- Switching modes never re-parses by itself — the parse stays a button.
- A mode with files but no snapshot yet shows the existing "click
  Visualize" hint.
- `?view=network` deep-linked onto a Kubernetes-mode playground falls back
  to `infra` (the `useGraphView` fallback, untouched).
- An open draft keeps opening even when invalid; mode is derived from its
  files before the auto-parse.

## Testing

TDD; backend `node --test` via `pnpm --filter @groundplan/backend test`,
frontend vitest + Testing Library + vitest-axe.

- Backend: kubernetes happy path (objects → graph, stats carry skipped
  counts); mixed set ignores `.tf` in kubernetes mode and `.yaml` in
  terraform mode; zero-match 422; unreadable-YAML 422 naming the file;
  nothing-is-an-object 422; drafts accept `.yaml`; existing terraform
  tests unchanged.
- Frontend: `viewsFor("playground", …)` unit; switch renders both sides,
  disables the empty one, auto-selects on manifests-only draft open;
  per-mode snapshot retention; New manifest menu item; muted
  not-in-view files; Network/IAM tabs render their views; Kubernetes mode
  renders no tabs; axe stays clean.

## Delivery

Three story-sized commits, matched to Jira GP numbers at implementation
time: backend parse branch → header switch + Kubernetes mode → playground
views.

## Out of scope

- No annotation layer, AI surface, tours or share links in the playground
  (unchanged from GP-125).
- No per-file mode override, no auto-detection heuristics beyond file
  extension.
- No draft schema change; no new endpoints.
