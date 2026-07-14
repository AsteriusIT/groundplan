# Clusters leave the project hierarchy

**Date:** 2026-07-14
**Status:** approved, ready to plan

## The problem

A live Kubernetes cluster is currently owned by a project: `clusters.project_id`
is a `NOT NULL` foreign key that cascades on delete, and you attach a cluster
from inside a project's detail page. That was the cheapest thing to build
(GP-95/GP-98 copied the repository-attach flow wholesale), but it says something
untrue about the estate.

A project is a unit of *code review* — it holds Git repositories, whose pull
requests we diff and whose main branch we document. A cluster is not code. It is
a running thing you read at a moment in time, it has no PRs, no annotations, no
tour, and no docs-of-main. The data model already knows this: a `graph_snapshot`
belongs to a repository **or** a cluster (`graph_snapshots_owner_check`), never
to a project. The only thing tying a cluster to a project is a column nobody
reads and a URL prefix.

Worse, the cascade is actively wrong. Deleting a project today silently deletes
the clusters attached to it, along with every namespace diagram ever read from
them — because they were filed under something they were never made of.

## The change

Clusters become peers of projects. The sidebar becomes:

    Dashboard · Projects · Clusters · Settings

### Scope

**In:** live clusters (kubeconfig, verify, read a namespace, draw it).

**Out:** Kubernetes *manifests repositories* (`repositories.iac_type =
'kubernetes'`, GP-101..GP-105). Those are Git repos. They get PR review and
docs-of-main; they belong in a project next to the Terraform repos, and they
stay there. This is why the nav entry is labelled **Clusters** and not
"Kubernetes" — a "Kubernetes" section would promise the manifests repos too, and
then not have them.

**Out:** the dashboard. It is built around repositories and pull requests and
structurally excludes cluster snapshots today (`loadRecentDocs` inner-joins
`repositories`). Surfacing clusters there is a separate story with its own
opinions about what a "recent live read" is worth on a home page.

## Data model

Drop `clusters.project_id`. Edit `src/db/schema.ts`, then
`pnpm --filter @groundplan/backend db:generate` — migrations are generated, never
hand-written. The expected shape:

```sql
ALTER TABLE "clusters" DROP CONSTRAINT "clusters_project_id_projects_id_fk";
ALTER TABLE "clusters" DROP COLUMN "project_id";
```

Existing cluster rows survive; they simply stop belonging to anything. Their
snapshots are untouched — those already point at the cluster.

In `db/schema.ts`: remove the `projectId` column, remove
`projectsRelations.clusters`, and remove `clustersRelations` entirely (a cluster
now relates to nothing upward). `PublicCluster` loses `projectId`;
`toPublicCluster` stays the single masking chokepoint and is otherwise unchanged.

Consequence, stated deliberately: **deleting a project no longer deletes
clusters.** A cluster is removed by removing the cluster.

## API

Two routes move. Everything else is already flat and does not change.

| Before | After |
| --- | --- |
| `GET /api/v1/projects/:id/clusters` | `GET /api/v1/clusters` |
| `POST /api/v1/projects/:id/clusters` | `POST /api/v1/clusters` |

Unchanged: `GET /clusters/:id`, `PATCH /clusters/:id`, `POST /clusters/:id/verify`,
`DELETE /clusters/:id`, and the whole namespace surface
(`GET /clusters/:id/namespaces`, `POST|GET /clusters/:id/namespaces/:ns/snapshots`).

`GET /clusters` lists every cluster, newest first — the same whole-estate read
the dashboard does. There is no per-user ownership model yet; when one lands,
this route scopes alongside `routes/dashboard.ts`.

The create body loses nothing: it was `{ name, kubeconfig }` and still is. The
kubeconfig stays write-only, AES-256-GCM at rest, masked as `"***"` on the way
out, and a malformed one is still a 422 that never quotes the file.

## Frontend

### Routes (`App.tsx`)

| Before | After |
| --- | --- |
| — | `/clusters` → `ClustersPage` (new) |
| `/projects/:id/clusters/:clusterId` | `/clusters/:id` → `ClusterPage` |

### New page: `pages/clusters-page.tsx`

The cluster half of the project detail page, lifted intact. `PageHeader` +
"Attach cluster", then a list of `ClusterCard`s. No clusters yet is one sentence
and one button — the existing `ClustersEmptyState`, moved, not rewritten. It
sits on a plain `bg-background` like every non-diagram view.

### Changed

- **`components/sidebar.tsx`** — a fourth `NAV` entry, `{ to: "/clusters",
  label: "Clusters", icon: KubernetesMark }`, between Projects and Settings.
- **`components/kubernetes-mark.tsx`** (new) — the official Kubernetes wheel,
  vendored unmodified as `src/icons/kubernetes-logo.svg` and rendered through an
  `<img>`, so it keeps its brand blue. It deliberately does **not** inherit
  `currentColor` like the three lucide icons around it: it is a vendor mark, and
  ICONS.md's rule is that vendor marks ship as-is, never recoloured. The nav
  already signals active state three other ways (left border, background tint,
  label weight), so nothing is lost by the icon not dimming. The file lives
  *outside* `src/icons/kubernetes/`, because that folder is glob-keyed by kind
  and a logo is not a kind. ICONS.md gains a line recording the source (CNCF
  artwork, `projects/kubernetes/icon/color/kubernetes-icon-color.svg`).
- **`pages/project-detail-page.tsx`** — the clusters section is *removed*, with
  no forwarding note left in its place. A project is repositories. The page keeps
  its repository list and nothing else.
- **`components/cluster-card.tsx`** — the "Namespaces" link becomes
  `/clusters/${cluster.id}`; it no longer reads `cluster.projectId`.
- **`components/attach-cluster-dialog.tsx`** — drops the `projectId` prop. The
  flow gets one step shorter: attaching a cluster no longer asks which project it
  belongs to, because it does not belong to one.
- **`api/client.ts`** — `listClusters()` (no argument) → `GET /clusters`;
  `createCluster(input)` → `POST /clusters`.
- **`api/types.ts`** — `Cluster` loses `projectId`.
- **`pages/cluster-page.tsx`** — reads a single `:id` param instead of
  `:id` + `:clusterId`, and its back link (today `/projects/${id}`) points at
  `/clusters`. The diagram, the namespace picker, the generate button, the
  warnings notice, the 409-is-busy handling: all untouched.

## Testing

TDD, in this order:

1. **`pages/clusters-page.test.tsx`** (new) — write first, watch it fail. It
   inherits the cluster assertions currently in `project-detail-page.test.tsx`:
   renders attached clusters, shows the empty state when there are none, attaches
   one through the dialog, and the kubeconfig is absent from the DOM afterwards.
2. **`pages/project-detail-page.test.tsx`** — cluster assertions deleted; add one
   asserting the page renders *no* cluster section, so the removal cannot silently
   regress.
3. **`routes/clusters.test.ts`** — list/create re-pointed at `/clusters`; drop the
   "clusters are scoped to their project" cases (there is no scope), add one
   asserting a cluster survives the deletion of any project.
4. **`components/cluster-card.test.tsx`** — the link target is `/clusters/:id`.
5. **`pages/cluster-page.test.tsx`** — the route param and back-link.

`routes/k8s-snapshots.test.ts` needs only its fixture-creation calls re-pointed;
its assertions are about namespaces and are unaffected.

No test contacts a real cluster — `buildApp(env, { k8s, k8sVerify })` stays
injectable, as it is today.

## Delivery

One commit, no Jira story:

    feat: clusters leave the project hierarchy
