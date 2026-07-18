# Network schema polish — design

Date: 2026-07-18
Status: approved (design), pending implementation plan

## Problem

Rendering the network view of a representative Azure estate
(`terraform-test/src`: hub VNet, 7 subnets, VMs, VMSS, LB, app gateway,
bastion, NAT gateway, private endpoints) shows two placement defects and
several readability gaps:

1. **The NAT gateway floats outside the VNet.** It attaches to subnets only
   through `azurerm_subnet_nat_gateway_association` resources, and it serves
   *two* subnets (`web` and the app subnet). The in-flight join-catalog work
   (`graph/azurerm-joins.ts`) classifies that association as `contain` but
   never guesses an ambiguous parent, so a multi-subnet NAT gateway degrades
   to plain edges and keeps floating.
2. **VMs float outside the VNet.** A VM never references a subnet itself — its
   NIC's `ip_configuration.subnet_id` does. GP-86 stacking nests the NIC
   *under* the VM, and no containment rule lets the VM inherit its satellite
   NIC's subnet, so `azurerm_linux_virtual_machine.this` / `.app` render
   beside the VNet with their NICs stacked inside them.
3. Readability gaps: the LB card shows three indistinguishable "app" rows
   (backend pool, probe, rule all share the name); the availability set is
   invisible; subnet headers carry no CIDR and subnets lay out in declaration
   order; a `count = 2` resource renders as one unmarked card in the docs
   view.

Everything below builds **on top of** the in-flight join-catalog story, which
lands first, unchanged.

## Decisions (user-validated)

- Multi-subnet NAT gateway: **place inside the VNet (nearest common ancestor)
  with a dashed edge to each served subnet** — not chips, not edges-only.
- Availability set: **chip on each member VM's card** (GP-89 mechanism
  extended to host cards) — not a grouping box, not a plumbing node.
- Scope includes all four polish items: typed satellite rows, subnet CIDR +
  ordering, availability set, count-instance badge.

## 1. Backend — containment (`graph/containment.ts`)

### 1a. Via rule: VM placed through its stacked NIC

A new rule kind alongside `down`/`up`: a **via** rule resolving two hops —
child (VM types: `azurerm_linux_virtual_machine`,
`azurerm_windows_virtual_machine`, `azurerm_virtual_machine`) → the NICs it
references (`network_interface_ids`) → the subnets those NICs reference. If
the union of subnets is exactly one, it becomes the VM's `parent_id`.

- Ordered before the generic subnet rule; does not disturb the NIC-under-VM
  stacking rule (the NIC keeps the VM as parent).
- Count instances resolve naturally: both `app` NICs reference the same
  subnet, so each `app` VM resolves uniquely whether or not the reference is
  index-resolved.
- Multiple distinct subnets (multi-homed VM) fall into the 1b degrade.

### 1b. Ambiguous containment degrades to the nearest common ancestor

Today `joinEffects` (`graph/azurerm-joins.ts`) eagerly turns a multi-anchor
`contain` into edges and no parent. Change:

- `JoinEffects` exposes ambiguous anchor sets (`ambiguous: Map<satelliteId,
  anchorIds[]>`) instead of resolving them to edges itself.
- `deriveContainment` runs **two phases**: (1) place every unambiguous parent
  (join parents, then the rules, as today); (2) resolve each deferred
  ambiguous set to the **nearest common ancestor** of its anchors, walking the
  parent chains derived in phase 1.
- Whatever the outcome, each anchor keeps one dashed (`inferred: true`)
  `depends_on` edge, deduped against declared edges (existing
  `joinEdgeAdditions` behaviour).
- No common ancestor ⇒ today's behaviour exactly: no parent, edges only.

Result for the fixture: the NAT gateway (with its stacked public IP) parents
into VNet `this`, dashed edges to subnets `web` and `this`. The same degrade
serves via-rule ambiguity (1a) for free.

## 2. Backend — availability set as an inline attach (`graph/azurerm-joins.ts`)

`availability_set_id` is an inline reference, not an association resource —
the same duality as the VMSS inline NSG (`inlineScaleSetLinks`). Generalise
into an inline-attach table: a VM-type resource referencing an
`azurerm_availability_set` yields an `attach` link with the **availability
set as satellite and the VM as anchor** (one link per VM instance). The avset
lands in `associated_ids` through the existing `attachAssociations`
(`graph/nsg.ts`). Both producers get it via the shared classify step.

## 3. Backend — data for the frontend, in existing schema fields

No graph schema version bump; the v7 `attributes: Record<string, string>`
field carries everything:

- Subnet nodes: `attributes["address_prefixes"]` (comma-joined) when
  statically known (HCL literal or plan value). VNet nodes:
  `attributes["address_space"]` likewise. Unknown/expression values are
  simply absent.
- HCL producer: a literal `count` stores `attributes["count"]` (e.g. `"2"`).
  The plan producer already expands real instances and stores nothing.

## 4. Frontend

### 4a. Chips on host cards (avset)

Extend the GP-89 chip mechanism (`SubnetChip` in
`components/network-container-node.tsx`, chip assembly in
`lib/graph-layout.ts`) so an attach-satellite's chips can render on
**top-level resource cards**, not only subnet frames. The avset chip appears
on each member VM's card header; clicking opens the avset's detail panel; the
avset node disappears from the canvas exactly as NSGs did.

Hiding rule: an attach-satellite is hidden only when **every** anchor renders
a chip home (a subnet frame or a top-level card). An anchor that is itself a
stacked row (e.g. an NSG associated to a NIC) keeps today's rendering — the
satellite stays a node with its edge.

### 4b. Typed satellite rows

Stacked rows inside a host card get a short kind prefix derived from the node
type — `pool app`, `probe app`, `rule app`, `nic this`, `pip nat` — so the
LB's three identical "app" rows become readable. Prefix in muted mono; the
name keeps its current weight. Frontend-only.

### 4c. Subnet CIDR + ordering

- Subnet and VNet frame headers show the CIDR after the name (mono, muted,
  smaller), from `attributes` — absent attribute, unchanged header.
- Subnets inside a VNet sort by CIDR numeric order (parse the first prefix);
  subnets without a known CIDR sort last, alphabetically. Replaces
  declaration-order layout so diagrams are stable across refactors.

### 4d. Count badge

A docs-view card whose node has `attributes["count"]` shows a `×n` badge next
to the title. The plan view never shows it (real instances render
individually).

All colours via semantic tokens; the `design-tokens.test.ts` guard applies.

## Error handling / edge cases

- Via rule with zero resolvable NICs or subnets: falls through to the generic
  subnet rule, then no parent — never a guess.
- Common-ancestor walk guards against cycles (bounded by parent-chain
  length) and missing nodes (an anchor without a derived parent contributes
  nothing; the walk then finds no common ancestor).
- `attributes` values are strings; multi-prefix subnets join with `", "`.
  CIDR sorting tolerates unparseable strings by sending them to the tail.
- An avset referenced by VMs in *different* subnets still chips onto each VM
  card — chips carry no containment, so nothing dangles.

## Testing

TDD throughout (repo convention; `NODE_ENV=test` via `pnpm test`).

- Backend: extend `__fixtures__/hcl-joins/` and
  `__fixtures__/plans/joins.plan.json` with the multi-subnet NAT, VM-via-NIC,
  and avset shapes; unit tests beside `containment.ts` (via rule, two-phase
  ancestor degrade), `azurerm-joins.ts` (ambiguous exposure, inline attach),
  and both producers (attributes emission).
- Frontend: `graph-layout.test.ts` (card chips, hiding rule, CIDR sort),
  component tests for typed rows, header CIDR, and the ×n badge; vitest-axe
  on the touched components.

## Sequencing — one commit per story

1. Land the in-flight join-catalog story as-is.
2. **Placement** (backend): via rule + common-ancestor degrade — fixes both
   reported floats.
3. **Availability set** (full-stack): inline attach + host-card chips.
4. **Typed satellite rows** (frontend).
5. **Subnet CIDR + ordering** (backend attributes + frontend).
6. **Count badge** (backend attribute + frontend).

## Out of scope

- Synthetic subnet nodes for inline vnet subnets (deferred in the catalog —
  own story).
- Chips on stacked rows (NSG-on-NIC keeps node + edge rendering).
- `for_each` cardinality badges (keys are rarely static).
- Any change to the annotation/adapted layers — this is all raw-view
  rendering.
