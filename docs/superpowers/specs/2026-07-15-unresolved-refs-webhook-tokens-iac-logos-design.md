# Design: unresolved references, webhook-token regeneration, IaC type logos

Date: 2026-07-15

Three independent features, one commit each (per the repo's one-story-per-commit
convention). All follow the existing patterns rather than inventing new ones.

## A. Read references that could not be resolved (Terraform + Kubernetes)

### Problem

Every producer discards unresolvable references today:

- The Terraform HCL parser keeps only an aggregate count string
  (`"N reference(s) could not be resolved to a resource"`) in `stats.warnings`.
- The Terraform plan.json parser records **nothing**.
- The Kubernetes mapper drops dangling references **silently** in its `link()`
  choke point — no warning, no count, no node.

There is no "unresolved/dangling/external" concept anywhere in the graph. The user
wants to *read* these references: a link in the snapshot's warning message that
opens a dialog listing each one.

### Backend — capture

New structured type in the graph layer:

```ts
export type UnresolvedReference = {
  from: string;      // source address (TF) or node id "ns/Kind/name" (K8s)
  ref: string;       // the target it could not resolve
  reason?: string;   // e.g. "target not in namespace", "external module"
};
```

- **Terraform:** `buildDependencyEdges` (shared by the HCL and plan parsers)
  returns `{ edges, unresolved }` instead of the HCL parser re-resolving refs to
  count them. The HCL parser drops its separate counting loop; the plan.json
  parser gets capture for free. The existing `isReferenceable` filter is applied
  when collecting so `var.`/`local.`/`each.`/attribute noise never lands in the
  list.
- **Kubernetes:** `k8s-mapper`'s `link()` records `{ from, ref: "Kind/name",
  reason }` when the source node is present but the target is not. Only **named**
  references count (ConfigMap / Secret / PVC / ServiceAccount, Ingress backend
  service, HPA `scaleTargetRef`). An empty selector that matches nothing is a
  valid state, not a dangling reference, and is excluded. `mapK8sObjects` returns
  `{ graph, unresolved }`; `mapNamespace` threads it through.

### Backend — surface

Thread `unresolvedReferences` through the existing `stats` plumbing, exactly like
`warnings`: producer → `extraStats` → `insertGraphSnapshot` merges into
`stats` → served at `routes/snapshots.ts`. Add
`unresolvedReferences?: UnresolvedReference[]` to the stats type on both backend
and frontend. The old aggregate `"N reference(s)…"` warning string is retired in
favour of the structured field (no double-reporting).

### Frontend — link + dialog

- `WarningsNotice` gains an optional `unresolvedReferences` prop. When non-empty
  it renders a line — *"N reference(s) could not be resolved — View"* — whose
  link opens a new `UnresolvedReferencesDialog` (shadcn Dialog) listing each
  `from → ref` (mono) with its reason. Plain-string warnings render unchanged.
- Surfaces: `docs-page` and `cluster-page` already render `WarningsNotice`;
  `pull-detail-page` gets the unresolved-references surface too so plan.json /
  rendered PR snapshots show theirs.

### Tests

Parser tests asserting the captured `from`/`ref` for HCL, plan.json, and the K8s
mapper; a `WarningsNotice` + dialog render/interaction test.

## B. Regenerate webhook token, both per-repo and app-wide

The webhook token is what CI uses to push plans. There is no regenerate endpoint
today, and token scope is strictly per-repository. We add regeneration and a
second, app-wide token — either authenticates a push.

### Per-repo regenerate

- `POST /api/v1/repositories/:id/webhook-token` rotates `webhookToken` via
  `generateToken()` and returns it once (mirroring the create response). Lands in
  `routes/repositories.ts` beside the other per-repo mutations.
- UI: a **Regenerate token** button in `CiSetupBlock`'s token area (the branch
  that says "shown once when attached"); on success it displays the fresh token
  via the existing token-present branch.

### App-wide token

- New singleton `app_settings` table (one row) with a nullable `webhook_token`
  (null = app-wide ingestion disabled) and `updated_at`. Migration generated via
  drizzle-kit (`db:generate`), never hand-written.
- New `routes/settings.ts`:
  - `GET /api/v1/settings/ingestion` → `{ appWebhookTokenSet: boolean,
    updatedAt: string | null }` (masked; never the value).
  - `POST /api/v1/settings/ingestion/webhook-token` → generate/rotate, returns
    the token once.
  - `DELETE /api/v1/settings/ingestion/webhook-token` → revoke (set null).
  - Authed by the global OIDC hook. No role model yet, so any authenticated user
    may rotate it — documented as a known limitation, to scope when ownership
    lands (beside `routes/dashboard.ts` / `routes/clusters.ts`).
- Ingestion auth (`routes/ingestion.ts`) becomes:
  `safeEqual(provided, repo.webhookToken) || (appToken != null &&
  safeEqual(provided, appToken))`. The app-wide token authenticates a push to any
  repository via that repository's URL. Stored plaintext + `safeEqual`,
  consistent with the existing per-repo token (not hashed — see Trade-offs).
- UI: an **Ingestion** card on `/settings` — Set / Not-set state, Generate /
  Regenerate (token shown once, copyable via the existing `Field`), and Revoke.

### Tests

Ingestion auth accepts a valid per-repo token, a valid app-wide token, and
rejects a wrong token, with and without an app token configured; regenerate
endpoint returns a new, different token; settings GET masks, POST returns once,
DELETE clears.

## C. IaC type logo chip on the repository card

- Add `apps/frontend/src/icons/terraform-logo.svg` (official HashiCorp mark,
  unmodified) and update `ICONS.md` attribution — following the existing
  `kubernetes-logo.svg` / `KubernetesMark` "a logo is not a kind" convention.
- Add an `IacTypeMark` component that switches on `IacType` and renders the right
  logo via `<img>`, never recoloured.
- In `repository-card.tsx`, replace the bare `<span>{IAC_TYPE_LABELS[...]}</span>`
  with the existing `Chip` primitive containing `IacTypeMark` + the label; `alt` /
  `title` from `IAC_TYPE_LABELS` for accessibility.

### Tests

`repository-card` renders the type chip with the correct logo and label for each
`iacType`.

## Trade-offs / known limitations

- The app-wide webhook token is a high-value secret (one leak = ingestion to
  every repository). It is stored plaintext + compared with `safeEqual`, matching
  the existing per-repo token, rather than hashed/encrypted. Accepted for now;
  hashing is a later hardening.
- App-wide token rotation is available to any authenticated user (no role model
  yet). `routes/settings.ts` is the place to scope when ownership lands.
- Unresolved references are surfaced off-canvas (a list), not drawn as ghost
  nodes — the deterministic diagram stays clean and the adapted/C4/diff layers are
  untouched.
