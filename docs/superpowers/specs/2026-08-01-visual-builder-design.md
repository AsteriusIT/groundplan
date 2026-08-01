# Visual Builder — compose infrastructure, generate Terraform (GP-131)

Design for GP-132..GP-135. One-way scaffolding: the builder graph is a sketch,
the generated HCL is the source of truth from the moment it lands.

## What it is

A **Build mode** in the playground. The user picks resource types from a
palette, drops them on a canvas, fills in a handful of attributes per node, and
connects nodes together — each connection is a Terraform *reference*, not a
line. **Generate Terraform** turns the composed graph into `.tf` files, which
are written into the playground's file set. From there the existing playground
takes over: edit, Visualize, save as a draft.

Nothing round-trips. Existing HCL is never imported into the builder, the
builder graph is never re-derived from files, and the generated files are
ordinary playground files with no special casing.

## Feature flag

`BUILDER_ENABLED` (default `false`) — the `AI_API_KEY` posture, applied to a
boolean because there is no key to double as the flag:

- unset/`false`: `GET /builder/status` reports `{ enabled: false }`,
  `POST /builder/generate` answers `404`, and the playground renders **no**
  Build surface — no mode switch, no palette, no hint that a mode is missing.
- `true`: the mode switch appears in the playground header.

The frontend learns the answer from `GET /builder/status`, probed once per
session and shared at module level, exactly like `useAiStatus` (GP-62). An
unreachable probe is read as "off": the playground must never break because a
flag endpoint blinked.

## Where the code lives

The tickets say `packages/models`, which does not exist in this repository
(the Jira "How" sections predate the stack — CLAUDE.md says to honour the
acceptance criteria and adapt the how). The shared, pure, FE+BE code lands in a
new workspace package modelled on `@groundplan/graph-parser`:

```
packages/builder/          @groundplan/builder — pure, zero runtime deps
  src/catalog.ts           the 12 azurerm resource definitions (the ONLY place
                           that knows which types exist — registry.ts posture)
  src/builder-graph.ts     BuilderGraph types
  src/validate.ts          validateBuilderGraph → typed issues
  src/generate.ts          BuilderGraph → [{ path, content }], deterministic
  src/index.ts
```

The backend route is a thin wrapper (validate → generate → reply), the way
`routes/playground.ts` wraps `parseHclRepo`. The frontend imports the same
package for the palette, the forms and the client-side validation, so the
browser and the server cannot disagree about what is valid.

Validation is hand-written, not Zod: this repository validates request bodies
with Fastify JSON Schema and everything else with plain TypeScript, and a
catalog entry is a data literal that `satisfies ResourceDef` at compile time.

## GP-132 — catalog + BuilderGraph + validation

A resource definition is data, not code:

```ts
type ReferenceSlot = {
  attribute: string;              // "virtual_network_name"
  targetTypes: readonly string[]; // what may be connected here
  targetAttribute: string;        // "name" | "id" | "location"
  required: boolean;
  list?: boolean;                 // network_interface_ids
};

type ResourceDef = {
  type: string;                   // "azurerm_subnet"
  label: string;
  category: "foundation" | "network" | "compute" | "data";  // decides the file
  attributes: readonly AttributeDef[];  // string | number | bool | enum | list
  references: readonly ReferenceSlot[];
  blocks?: readonly string[];     // verbatim scaffold blocks (os_disk, …)
};
```

Twelve azurerm types, the demo topology: resource group, virtual network,
subnet, network security group, public IP, network interface, Linux virtual
machine, storage account, key vault, private endpoint, service plan, Linux web
app. A curated subset of attributes per type — what a scaffold needs, never the
provider schema.

`blocks` is what keeps "add a type = add one catalog entry" true while still
emitting HCL Terraform would accept: a Linux VM needs an `os_disk` and a
`source_image_reference` block, and those are part of the *definition*, not of
the generator.

The builder graph is deliberately not a GraphSnapshot — it is an editor
document, with client-side node ids and canvas positions:

```ts
type BuilderNode = { id, type, name, attributes, position };
type BuilderReference = { from, to, attribute };   // node ids + the slot
type BuilderGraph = { nodes, references };
```

`validateBuilderGraph` returns **every** issue, each machine-readable
(`nodeId`, `attribute?`, `reason`, `message`): unknown type, invalid or
duplicate Terraform name, missing required attribute, missing required
reference, a reference whose target type does not match the slot, a reference
to a node that is not there, a reference through an attribute the type has no
slot for, a value that does not fit its kind. Nothing throws; the caller
decides whether an issue is a badge or a 422.

## GP-134 — deterministic generation

`POST /api/v1/builder/generate` → `{ files: [{ path, content }] }`. Stateless,
nothing persisted, no AI, no cloud access (the playground-parse posture).

- Invalid graph → `422` listing **every** offending node and attribute in the
  app-wide `fields` shape (`{ field, message }`, field = `<type>.<name>` or
  `<type>.<name>.<attribute>`), so the frontend can badge nodes instead of
  reading prose.
- Files by category: `main.tf` (the `terraform` block, the `azurerm` provider
  stub and the foundation resources), `network.tf`, `compute.tf`, `data.tf`.
  A category with no resources produces no file.
- Within a file, resources are sorted by `(type, name)`. Attributes are emitted
  in catalog order, aligned `=` like `terraform fmt` would, references as
  `azurerm_virtual_network.this.name` — never as a literal. Canvas positions and
  node ordering are ignored. Same graph in ⇒ byte-identical files out.
- No `count`, no `for_each`, no modules, no variables. Values are inlined
  literals. It is a scaffold.

**The golden invariant** is the correctness test: feed the generated files to
Producer B (`parse` from `@groundplan/graph-parser`) and the resulting snapshot
must carry exactly the composed nodes and exactly the composed reference edges.
The diagram the user built is the diagram they get back.

## GP-133 — Build mode

The playground header gains a two-state switch, **Edit HCL / Build**, beside
the existing Terraform/Kubernetes switch. Build mode replaces the file panel
with the palette and the canvas with the editor; the file set is untouched
underneath, and switching back restores it exactly. The builder graph lives in
the playground page's state, so Build → Edit HCL → Build is lossless within the
session. It is never persisted: a draft holds files, and only files.

The editor is its own React Flow canvas (`apps/frontend/src/builder/`), not the
read-only `@groundplan/canvas` one — creating, connecting and deleting is a
different job from rendering a snapshot, and the shared canvas is also the VS
Code webview's. It reuses the canvas package's `ResourceIcon` and the design
tokens, so a builder node looks like the diagram it will become.

- **Palette**: catalog entries grouped by category, each with its vendor icon.
  Click adds a node at a free spot; the node lands selected.
- **Handles**: one target handle per node, one source handle per reference
  slot, labelled with the slot. `isValidConnection` consults the catalog, so an
  incompatible connection cannot be made — it is rejected while dragging, not
  explained afterwards. A non-list slot already filled is not connectable.
- **Attribute form**: the selected node's fields, generated from the catalog
  (text, number, checkbox, select, comma list), plus its Terraform local name.
  Required-and-empty is flagged inline; the name is validated for the
  Terraform identifier rules and for uniqueness within its type.
- **Node status**: a node with any issue carries a badge with the count; the
  canvas says which nodes are not ready without opening each one.
- Deleting a node deletes its edges, in and out. No dangling references, ever.
- Manual positions, no auto-layout: the user's arrangement is the point.
- Out of scope: undo/redo, multi-select, copy/paste, Kubernetes.

## GP-135 — the generate flow

**Generate Terraform** is the primary action in Build mode.

1. Blocked while the graph has issues — the button is disabled and the nodes
   already carry their badges. A server-side `422` (belt and braces) maps back
   onto the same badges; nothing is written.
2. On success, a **preview dialog**: one tab per generated file, read-only
   `HclEditor`, so the user sees the code before it exists.
3. Confirm writes the files into the playground file set. A name that collides
   with an existing file turns the dialog's confirm into an explicit
   **Replace** (naming the files it would overwrite) with Cancel beside it;
   Cancel leaves the file set untouched. No merging.
4. After the write: back to Edit HCL, first generated file open, Visualize runs
   automatically — the loop closes on the diagram.
5. A dismissible note states the one-way rule in the user's words: the sketch
   made the code, the code is now the truth, and editing the HCL will not move
   the sketch.

## Testing

- `packages/builder`: `node --test` beside the subject — catalog integrity (the
  12 types, every slot's target exists in the catalog, every slot's attribute
  is not also a plain attribute), validation cases one per reason, codegen
  determinism (generate twice, compare bytes), the golden invariant against
  Producer B, and an "add one entry" test proving a new type needs no code.
- Backend: route tests through `pnpm test` — 404 when the flag is off, 200 and
  the file list when on, 422 listing every offending node.
- Frontend: vitest + Testing Library — no Build switch when the status is off,
  compose-a-node flow, incompatible connection refused, badges on invalid
  nodes, preview → confirm → files written and Visualize called, collision →
  Replace/Cancel.

## Out of scope

Re-importing HCL into the builder, `count`/`for_each`/modules/expressions,
Kubernetes resources, AI-assisted composition, persisting the builder graph,
pushing generated files to a repository.
