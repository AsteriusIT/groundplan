# Semantic Network View (GP-42 → GP-45) — Design

**Epic:** GP-41 "Semantic network view"
**Stories:** GP-42 (BE containment), GP-43 (BE NSG rules), GP-44 (FE network view + switcher), GP-45 (FE exposure + rule inspection)
**Date:** 2026-07-12

## Goal

Let teams see their Terraform as a **network**: virtual networks containing subnets
containing resources, with internet-exposed security groups made visually loud and
their rules inspectable. Derived deterministically from the existing GraphSnapshot,
shared across both producers (plan.json and static HCL), rendered by the existing
React Flow / ELK canvas with no fork of the node components.

## Reality adaptations (tickets were written against an idealized state)

The tickets assume things that do not exist in the repo. Confirmed adaptations:

1. **Schema.** There is no schema "v3" file and no per-version files. The graph
   format is one committed schema, [`apps/backend/schema/graph.v1.schema.json`](../../../apps/backend/schema/graph.v1.schema.json),
   versioned **in place** through optional fields (`version: 1 | 2 | 3`, each a
   superset of the last). We extend it in place: add optional `parent_id`,
   `rules[]`, `internet_exposed`, `associated_ids[]`; extend the `version` enum to
   include `4`. No new schema file, no parallel containment-edge type.
2. **No `packages/models`.** There is no monorepo `packages/` dir. The model and
   both parsers live in [`apps/backend/src/graph/`](../../../apps/backend/src/graph/).
   New backend logic lands there (`containment.ts`, `nsg.ts`); the frontend type
   mirror stays in [`apps/frontend/src/api/types.ts`](../../../apps/frontend/src/api/types.ts).
3. **No `tintin92350/groundplan-example` in-tree.** That repo is external and cannot
   be cloned/run here. Acceptance is proven with deterministic in-repo Azure
   fixtures (plan.json + HCL) under
   [`apps/backend/src/graph/__fixtures__/`](../../../apps/backend/src/graph/__fixtures__/),
   matching the existing fixture style. (The existing `plan-expressions.plan.json`
   is already a vnet→subnet→NIC→VM topology and is reused/extended.)

## Non-negotiable constraints (from the tickets, still honored)

- One containment mechanism only (`parent_id`), never a second edge kind.
- Never guess a parent: unresolvable or ambiguous → `parent_id` absent/null.
- Old v1/v2/v3 snapshots stay valid and byte-identical (all new fields optional;
  version only escalates when a new field is actually populated).
- No new API — the existing snapshot read endpoint serves v4 unchanged.
- Sensitive-value masking (GP-32) unaffected.
- No cloud credentials / state access. Pure functions over plan JSON / HCL text.

---

## GP-42 — Network containment (`parent_id`) in the GraphSnapshot

### Data model

`GraphNode` gains one optional field, mirrored in backend `graph.ts`, the JSON
schema, and frontend `types.ts`:

```ts
/** v4: id of the node that contains this one (vnet⊃subnet⊃resource). Null/absent
 *  when no single unambiguous parent resolves. Distinct from module `contains`. */
parent_id?: string;
```

Schema: add `parent_id` (`type: ["string","null"]`) to the node definition; extend
`version` enum to `[1,2,3,4]`; update the version description.

### Derivation — shared, deterministic, one place

A new pure module `apps/backend/src/graph/containment.ts` exports
`deriveContainment(nodes, sources, edgeCtx)` and mutates/returns nodes with
`parent_id` set where resolvable. Both parsers already build exactly the inputs it
needs — `DependencySource[]` (each node's outgoing references, module-prefixed) and
the `EdgeContext` (id sets + instances-by-base) — and both already own
`resolveReference(prefix, ref, ctx)`. Containment **reuses** that resolver; it does
not re-parse anything.

**Rule table** (data-driven, in `containment.ts`) — a small list of
`{ childMatches(node), parentType }` entries:

| child | parent type | how the reference is found |
|---|---|---|
| `type === "azurerm_subnet"` | `azurerm_virtual_network` | subnet's refs (e.g. `virtual_network_name = azurerm_virtual_network.x.name`) |
| any type except vnet/subnet | `azurerm_subnet` | the node's refs that resolve to a subnet (NIC `ip_configuration.subnet_id`, `subnet_id`, delegated subnet, AKS `vnet_subnet_id`, …) |

**Algorithm** (per node, per matching rule):
1. Resolve the node's references (from its `DependencySource`) to target node ids
   via `resolveReference`.
2. Keep the distinct targets whose resolved node `type === rule.parentType`.
3. **Exactly one** qualifying target → set `parent_id` to it. Zero or >1 (e.g. a
   `count`-expanded subnet reference resolving to two instances) → leave unset.

This is target-type-filtered, so it is precise without per-attribute block
knowledge, and identical for both producers (both hand it the same reference set).
It naturally yields `parent_id: null` for a VM (references a NIC, not a subnet) and
for ambiguous count references — matching "never guess."

### Producer wiring

- **plan-parser.ts**: it already builds `sources` from `configuration…expressions`
  and the `edgeCtx`. Call `deriveContainment` after nodes/edges are built, before
  `propagateImpact`. Escalate `version` to `4` when any node has `parent_id`.
- **hcl-parser.ts**: it already builds `sources` (`ctx.pendingSources` → refs) and
  `edgeCtx`. Same call, same version escalation (docs snapshots become v4 when
  containment exists).

Module `contains` edges are untouched — containment (`parent_id`) and module
hierarchy (`contains` edges) are orthogonal and both remain.

### Fixtures & tests (`containment.test.ts`, extended parser tests)

- Extend/author a plan fixture and an HCL fixture with vnet ⊃ subnet ⊃ NIC, plus a
  VM (no subnet ⇒ null) and a `count` subnet referenced ambiguously (⇒ null).
- Unit tests on `deriveContainment`: subnet→vnet, NIC→subnet, VM→null,
  ambiguous→null, non-Azure→null.
- Parser tests: `parsePlanToGraph` / `parseHclRepo` emit correct `parent_id` chains
  and `version: 4` when present; a plan/HCL with no network stays v2/v1.
- A snapshot with `parent_id` validates against the extended schema; a v3 snapshot
  without it still validates (backward compat).

### Acceptance mapping

- Correct vnet→subnet→NIC chains on the fixture (spot-check 3) ✔ via fixtures.
- Unresolvable → `parent_id: null` ✔ (VM, ambiguous count).
- Schema v4 published & validated in CI (the existing schema test) ✔.
- Masking unaffected ✔ (containment never touches attribute values).

### Out of scope

vnet peering, NSG rules (GP-43), non-Azure containment beyond what the same
target-type rule happens to cover, any UI (GP-44/45), effective connectivity.

---

## GP-43 — NSG rules as typed node payload

### Data model

`GraphNode` gains (all optional, v4):

```ts
rules?: NsgRule[];          // present on azurerm_network_security_group nodes
internet_exposed?: boolean; // computed; true only on an exposed NSG node
associated_ids?: string[];  // node ids of subnets/NICs this NSG is attached to
```

```ts
type NsgRule = {
  name: string;
  priority: number;
  direction: string;   // Inbound | Outbound (raw)
  access: string;      // Allow | Deny (raw)
  protocol: string;    // raw
  ports: string;       // normalized: "80", "80-443", "*"
  source: string;      // raw source address prefix
  destination: string; // raw destination address prefix
};
```

`associated_ids` is the chosen representation (per decision) for the NSG↔subnet/NIC
link that GP-45 needs to ring. It keeps `internet_exposed` "true exactly for the
NSG" (GP-43 acceptance) rather than propagating it onto neighbors.

Schema: add these three to the node definition with a nested `NsgRule` object
schema (`additionalProperties: false`).

### Derivation — shared compute, producer-specific extraction

`apps/backend/src/graph/nsg.ts` exports:
- `computeInternetExposed(rules): boolean` — `true` iff any rule with
  `direction === Inbound && access === Allow` has a source in
  `{ "*", "0.0.0.0/0", "Internet" }` (case-insensitive). This is the whole
  heuristic — no priority/effective-rule engine.
- `normalizePorts(raw): string` — `"80"`, `"80-443"`, `"*"`; passthrough otherwise.
- `attachNsg(nodes, extracted)` — a shared post-step that, given per-NSG extracted
  rules and associations, sets `rules`, `internet_exposed`, `associated_ids` on the
  right nodes.

Extraction differs by producer (like containment):
- **plan-parser.ts**: NSG rule values come from `change.after` — inline
  `security_rule[]` on `azurerm_network_security_group`, plus standalone
  `azurerm_network_security_rule` (grouped to its NSG by `network_security_group_name`
  / reference), plus `*_association` resources (`azurerm_subnet_network_security_group_association`,
  `azurerm_network_interface_security_group_association`) resolved through
  `resolveReference` to subnet/NIC + NSG node ids for `associated_ids`.
- **hcl-parser.ts**: inline `security_rule { … }` sub-blocks scanned from the NSG
  block body (reuse `scanTopLevelBlocks` on the body); standalone rule blocks and
  association blocks parsed the same way, resolved via the same reference builder.

`internet_exposed` and `associated_ids` are set in the shared step so both producers
agree.

### Fixtures & tests (`nsg.test.ts`, parser tests)

- Add to the Azure fixtures: one NSG with a deliberately internet-open inbound Allow
  rule (source `*` or `Internet`) associated with a subnet, and a second closed NSG.
- Unit tests: `computeInternetExposed` truth table (Internet/`*`/`0.0.0.0/0` vs a
  specific CIDR; inbound-Allow vs outbound/Deny), `normalizePorts`.
- Parser tests: NSG node carries `rules[]` matching the HCL/plan; `internet_exposed`
  true **only** for the fixture NSG; `associated_ids` point at the right subnet/NIC;
  works for both producers.

### Acceptance mapping

- NSG nodes carry `rules[]` matching source ✔.
- `internet_exposed` true exactly for the fixture NSG ✔.
- Both producers ✔.

### Out of scope

Effective reachability, ASG expansion, Azure Firewall, AWS/GCP SGs, rule-level
diffing.

---

## GP-44 — Network view + view switcher (frontend)

### Projection (pure, client-side)

New pure fn in [`apps/frontend/src/lib/graph-layout.ts`](../../../apps/frontend/src/lib/graph-layout.ts)
(beside `toElkGraph`): `networkProjection(graph): Graph`.

Keep a node iff: it is in a `parent_id` chain (has a `parent_id`, or is the parent
of something), **or** `categorize(type) === "network"`, **or** it is an NSG whose
`associated_ids` intersect kept nodes (so its rules stay inspectable in GP-45).
Drop the rest. Re-express containment as the canvas's existing nesting mechanism:
feed `parent_id` into the same `parentOf` map `toElkGraph`/`elkToFlow` build today
for module `contains`, so vnet/subnet become ELK parents and render as **containers**
through the existing subflow path (a node with ELK children is drawn as a container).
Because that path currently hardcodes the module container look, the container node
component gets a **light extension** to render a resource-backed container with its
own identity (network icon + resource name, e.g. the subnet) instead of a
`module.<name>` label — a small variant, not a fork of the resource node.

Nodes hidden by the projection are surfaced, not lost: a **count chip** "N resources
not in network view" (informational; no click behavior yet).

### Switcher

A segmented control (Plan-impact ⇄ Network) in the header slot of
[`pull-detail-page.tsx`](../../../apps/frontend/src/pages/pull-detail-page.tsx) and
[`docs-page.tsx`](../../../apps/frontend/src/pages/docs-page.tsx), beside the existing
snapshot `<select>` / export menu. State lives in the URL as `?view=network`,
following the exact `?compare` pattern already in `docs-page.tsx` (`useSearchParams`,
`setSearchParams(next, { replace: true })`). Default (absent/`infra`) = today's
plan-impact/docs view. Each page passes either `snapshot.graph` or
`networkProjection(snapshot.graph)` into the **same** `<GraphCanvas>` — no fork.

Shared search/filter panel and change/impacted coloring are inherited unchanged
because it is the same `GraphCanvas` + same node components. Selection is preserved
across the switch when the node exists in both projections (selection already lives
in `GraphCanvas` state keyed by node id; a node present in both views keeps it).

### Tests

- `graph-layout.test.ts`: `networkProjection` keeps/drops the right nodes, nests by
  `parent_id`, computes the hidden count, keeps associated NSGs.
- A page/canvas test (matching `graph-canvas.test.tsx` mocks): `?view=network`
  renders the projected graph and the count chip; switching preserves selection;
  PR variant still shows create/update/delete styling.

### Acceptance mapping

Switcher on PR + docs; deep-link `?view=network` lands on network view; nesting
correct; hidden count accurate; PR styling intact; reset/search/filters unchanged.

### Out of scope

NSG rule display (GP-45), peering/NAT/LB edges, "unplaced resources" UI,
export polish, any backend change.

---

## GP-45 — Exposure highlighting & rule inspection (frontend)

### Side panel

Extend [`node-details-panel.tsx`](../../../apps/frontend/src/components/node-details-panel.tsx):
a new `<SidePanelSection label="Security rules">` shown when `node.rules?.length`.
A table sorted by `priority`; each row shows priority / direction / access / ports /
source; rows whose source is an internet source (`*`, `0.0.0.0/0`, `Internet`) are
flagged (reuse a status/`delete`-toned Chip). Pure helper in
[`lib/node-details.ts`](../../../apps/frontend/src/lib/node-details.ts) to sort/flag.

### Canvas treatment (one visual treatment only)

In `NodeCard` ([`graph-node.tsx`](../../../apps/frontend/src/components/graph-node.tsx)):
a warning badge + colored ring when a node is exposed. The exposed set is derived
client-side: the NSG itself when `internet_exposed`, plus its `associated_ids`.
Computed once per graph (small helper `exposedNodeIds(graph)`), passed into
`NodeCard` as an `exposed` flag through the existing data path. No animation, no
severity scale. **Decision:** add one dedicated semantic token pair
(`--exposed` / `--exposed-soft`) to `index.css` following the existing status-token
pattern, generating `ring-exposed` / `bg-exposed-soft` utilities — no hardcoded
colors, satisfying the design-token guard. The exposure indicator is a small
warning badge in the new `exposed` tone (a shield/warning glyph, distinct from the
impacted `!` badge) — added via `lib/status.ts` metadata so it stays centralized.

### PR context

A changed rule surfaces through the **existing** GP-32 attribute diff (the NSG's
`security_rule` attributes appear in `attribute_diff`); removing the open rule in a
PR clears `internet_exposed` in the next plan snapshot, so the badge disappears. No
rule-level diff engine.

### Tests

- `node-details-panel.test.tsx`: rules section renders sorted, flags internet rows,
  hidden when absent.
- `graph-node.test.tsx`: exposed node shows badge/ring; non-exposed does not.
- `exposedNodeIds` helper unit test (NSG + associated_ids; nothing when not exposed).

### Acceptance mapping

Fixture NSG's subnet shows the badge; removing the rule removes it (via snapshot);
side panel lists rules with priority/direction/access/ports/source; PR rule change
shows via attribute diff.

### Out of scope

Rule-level semantic diffing, reachability, remediation, IAM view.

---

## Execution plan

Dependency order, TDD (tests beside subjects; `pnpm --filter @groundplan/backend test`
for BE, `pnpm --filter @groundplan/frontend test` for FE), `pnpm typecheck` +
targeted tests green before each commit. One commit per story matching the repo's
`feat(scope): summary (GP-xx)` convention:

1. `feat(backend): network containment via parent_id in GraphSnapshot (GP-42)`
2. `feat(backend): NSG rules + internet_exposed node payload (GP-43)`
3. `feat(frontend): network view + plan-impact ⇄ network switcher (GP-44)`
4. `feat(frontend): exposure highlighting & NSG rule inspection (GP-45)`

Then transition GP-42→45 to Done in Jira.

## Risks / watch-items

- **Over-parenting** by the target-type rule (a resource that references a subnet
  for a non-containment reason). Mitigation: single-unambiguous-target-or-null, and
  `*_association` plumbing is filtered from the child match if tests show noise.
- **Plan vs. HCL divergence** in NSG rule extraction (structured `after` vs. text
  body). Mitigation: shared compute (`internet_exposed`, ports, associations) with
  thin per-producer extractors, cross-checked by parallel producer tests.
- **CLAUDE.md is stale** (says "scaffold only"; real work is at GP-40). Out of scope
  to fix here, but noted.
