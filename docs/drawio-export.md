# draw.io export & shape library

groundplan can export any snapshot as a **draw.io diagram** (`.drawio`): real,
editable cells — not an image — positioned exactly like the canvas, with each
resource's own vendored provider icon (the same official Azure/AWS/GCP/
Kubernetes set the app draws, embedded in the file), the change colours
(create / update / delete / impacted) and the Terraform address of every node
in its hover tooltip. Open the file in [diagrams.net](https://app.diagrams.net)
(web or desktop): moving, deleting and re-connecting nodes behaves like any
hand-drawn diagram, and module containers collapse.

Use **Export → draw.io** on a PR or docs view, or fetch it directly:

```text
GET /api/v1/orgs/:orgId/snapshots/:id/export.drawio?view=infra|network|iam
```

The export always covers the full snapshot (never the current filter state)
and is cached per snapshot id + view like the SVG/PNG exports. `view` picks
the lens, mirroring the app's view switcher:

- **infra** (default) — the raw graph with module containers.
- **network** — vnet ⊃ subnet containment as real nested containers, join
  plumbing folded away, internet-exposed subnets ringed in the exposed colour.
- **iam** — the grant graph: one node per principal and scope, one edge per
  role assignment labelled with the role (`— privileged` when flagged).

## The groundplan shape library

`groundplan-shapes.xml` is a draw.io **custom shape library** holding one
template per vendored provider icon — the app's whole icon set — plus a
generic resource and a module container, styled identically to exported
diagrams, so you can extend an export with new nodes that match.

Download it from the Export menu ("draw.io shape library") or grab
`/groundplan-shapes.xml` from your groundplan instance.

To load it in diagrams.net:

1. **File → Open Library from → Device…** and pick `groundplan-shapes.xml`
   (on draw.io desktop: **File → Open Library…**).
2. A **groundplan** palette appears in the left sidebar.
3. Drag templates next to exported nodes; they carry the same styles.

> **Load from Device, not from URL.** "Open Library from → URL…" makes the
> app.diagrams.net web app fetch through draw.io's own proxy, which cannot
> reach a private or localhost groundplan instance — you get its HTML error
> page back and draw.io reports it as
> `Unexpected token 'T', "This page "… is not valid JSON`. Download the file
> first, then open it from your device.

## Keeping the library in sync (contributors)

Two committed artifacts are **generated**, never hand-edited:

- `apps/backend/src/graph/drawio-icons.generated.ts` — the canvas package's
  type→icon maps + inlined SVGs (`pnpm --filter @groundplan/backend
  drawio:icons`); regenerate after touching `packages/canvas/src/icons`.
- `apps/frontend/public/groundplan-shapes.xml` — the shape library, from the
  style builder (`pnpm --filter @groundplan/backend drawio:library`);
  regenerate after changing any draw.io style.

CI (`drawio-library.yml`) fails when either drifts from its source, and the
backend test suite asserts the same locally.
