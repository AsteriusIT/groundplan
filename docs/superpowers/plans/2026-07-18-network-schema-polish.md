# Network Schema Polish Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix the two placement defects in the network view (floating VMs, floating multi-subnet NAT gateway) and land four readability improvements (avset chips, typed stack rows, subnet CIDR + ordering, ×n count badge), per `docs/superpowers/specs/2026-07-18-network-schema-polish-design.md`.

**Architecture:** Everything builds on the in-flight azurerm join-catalog work (uncommitted, tests green — committed first as Task 0). Backend: `graph/containment.ts` gains a two-hop *via* rule (VM → NIC → subnet) and a two-phase derivation whose second phase resolves ambiguous multi-anchor containment to the nearest common ancestor; `graph/azurerm-joins.ts` exposes ambiguous anchor sets instead of eagerly degrading, and gains an inline VM→avset attach duality; both producers emit subnet/vnet CIDRs and literal `count` into the existing v7 `attributes` field. Frontend: the GP-89 chip mechanism generalizes from subnet frames to top-level resource cards; stack rows get kind prefixes; subnets sort by CIDR; docs-view cards show a ×n badge.

**Tech Stack:** TypeScript (strict, `noUncheckedIndexedAccess`), Node test runner + tsx (backend), vitest + Testing Library (frontend), ELK layout, React Flow, Tailwind v4 semantic tokens.

## Global Constraints

- Backend tests MUST run via `pnpm --filter @groundplan/backend test` (sets `NODE_ENV=test`; a bare `node --test` picks up `.env` OIDC and 401s every inject).
- Frontend tests: `pnpm --filter @groundplan/frontend test`. Typecheck everything: `pnpm typecheck`.
- Backend ESM: relative imports use `.js` extensions even from `.ts` files.
- Never hardcode a colour in frontend components — semantic token utilities only (`design-tokens.test.ts` guard).
- No graph schema version additions: `attributes` (v7) and `associated_ids` (v4) already exist. Producers bump the emitted `version` to 7 only when a node carries `attributes`.
- Every commit message ends with the trailer: `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`.
- One commit per story, exactly as sequenced below. Never commit `terraform-test` paths — that repo is external scratch.

---

### Task 0: Commit the in-flight join-catalog story

The uncommitted working tree (azurerm-joins.ts + producer/containment/nsg/graph-layout changes + fixtures + catalog docs) is a complete story and its tests pass.

**Files:** all currently modified + untracked files per `git status` (backend `src/graph/*`, frontend `src/lib/graph-layout.*`, `__fixtures__/hcl-joins/`, `__fixtures__/plans/joins.plan.json`, `docs/azurerm-connection-catalog.{md,json}`).

- [ ] **Step 0.1: Verify baseline is green**

Run: `pnpm --filter @groundplan/backend test 2>&1 | tail -5` and `pnpm --filter @groundplan/frontend test 2>&1 | tail -5` and `pnpm typecheck`
Expected: all pass.

- [ ] **Step 0.2: Commit**

```bash
git add apps/backend/src/graph apps/frontend/src/lib/graph-layout.ts apps/frontend/src/lib/graph-layout.test.ts docs/azurerm-connection-catalog.md docs/azurerm-connection-catalog.json
git commit -m "feat(graph): azurerm join catalog — one table classifies association resources into placements, chips, and edges

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

## Story A — placement: via rule + common-ancestor degrade (one commit, Tasks 1–3)

### Task 1: `JoinEffects` exposes ambiguous containment

**Files:**
- Modify: `apps/backend/src/graph/azurerm-joins.ts` (types `JoinEffects`, function `resolveParents`, function `joinEffects`)
- Test: `apps/backend/src/graph/azurerm-joins.test.ts`

**Interfaces:**
- Produces: `JoinEffects.ambiguous: Map<string, string[]>` — satellite id → its 2+ sorted `contain` anchors. `parents` and `edges` behaviour unchanged (ambiguous sets STILL push one edge per anchor).

- [ ] **Step 1.1: Write the failing test** (append to `azurerm-joins.test.ts`; reuse the file's `setup`/`source` helpers)

```ts
test("a NAT gateway bound to two subnets is exposed as ambiguous, with edges kept", () => {
  const { ctx, typeById } = setup({
    "azurerm_nat_gateway.shared": "azurerm_nat_gateway",
    "azurerm_subnet.a": "azurerm_subnet",
    "azurerm_subnet.b": "azurerm_subnet",
    "azurerm_subnet_nat_gateway_association.s1":
      "azurerm_subnet_nat_gateway_association",
    "azurerm_subnet_nat_gateway_association.s2":
      "azurerm_subnet_nat_gateway_association",
  });
  const links = classifyJoins(
    [
      source(
        "azurerm_subnet_nat_gateway_association.s1",
        "azurerm_nat_gateway.shared.id",
        "azurerm_subnet.a.id",
      ),
      source(
        "azurerm_subnet_nat_gateway_association.s2",
        "azurerm_nat_gateway.shared.id",
        "azurerm_subnet.b.id",
      ),
    ],
    ctx,
    typeById,
  );
  const fx = joinEffects(links, typeById);
  assert.equal(fx.parents.size, 0);
  assert.deepEqual(fx.ambiguous.get("azurerm_nat_gateway.shared"), [
    "azurerm_subnet.a",
    "azurerm_subnet.b",
  ]);
  assert.deepEqual(fx.edges, [
    { from: "azurerm_nat_gateway.shared", to: "azurerm_subnet.a" },
    { from: "azurerm_nat_gateway.shared", to: "azurerm_subnet.b" },
  ]);
});
```

- [ ] **Step 1.2: Run to verify it fails**

Run: `pnpm --filter @groundplan/backend test 2>&1 | grep -A3 "ambiguous"`
Expected: FAIL — `fx.ambiguous` is undefined.

- [ ] **Step 1.3: Implement** — in `azurerm-joins.ts`:

Add to `JoinEffects`:

```ts
  /** satellite id → 2+ contain anchors, deferred to deriveContainment's
   * common-ancestor pass (each anchor still gets a direct edge). */
  ambiguous: Map<string, string[]>;
```

Replace `resolveParents` (keep its doc comment, extend it):

```ts
/** Unique parent per satellite; an ambiguous one keeps edges to each anchor and
 * is exposed for the common-ancestor pass in deriveContainment. */
function resolveParents(
  containAnchors: ReadonlyMap<string, string[]>,
  pushEdge: (from: string, to: string) => void,
): { parents: Map<string, string>; ambiguous: Map<string, string[]> } {
  const parents = new Map<string, string>();
  const ambiguous = new Map<string, string[]>();
  for (const [satelliteId, anchors] of containAnchors) {
    if (anchors.length === 1) parents.set(satelliteId, anchors[0] as string);
    else {
      ambiguous.set(satelliteId, [...anchors].sort(compareStrings));
      for (const anchorId of anchors) pushEdge(satelliteId, anchorId);
    }
  }
  return { parents, ambiguous };
}
```

In `joinEffects`, replace `const parents = resolveParents(...)` with `const { parents, ambiguous } = resolveParents(containAnchors, pushEdge);` and return `{ attachments, parents, ambiguous, edges }`.

- [ ] **Step 1.4: Run tests — the new test passes, nothing else breaks**

Run: `pnpm --filter @groundplan/backend test 2>&1 | tail -5`
Expected: PASS.

### Task 2: `deriveContainment` — two phases, nearest common ancestor

**Files:**
- Modify: `apps/backend/src/graph/containment.ts`
- Modify: `apps/backend/src/graph/hcl-parser.ts:583` and `apps/backend/src/graph/plan-parser.ts:555` (the `deriveContainment(...)` calls)
- Test: `apps/backend/src/graph/containment.test.ts`
- Fixtures: `apps/backend/src/graph/__fixtures__/hcl-joins/main.tf`, `apps/backend/src/graph/__fixtures__/plans/joins.plan.json`
- Test: `apps/backend/src/graph/hcl-parser.test.ts`, `apps/backend/src/graph/plan-parser.test.ts`

**Interfaces:**
- Produces: `export type JoinContainment = { parents?: ReadonlyMap<string, string>; ambiguous?: ReadonlyMap<string, readonly string[]> }`; new signature `deriveContainment(nodes, sources, ctx, joins?: JoinContainment): void`.
- Consumes: `JoinEffects.ambiguous` from Task 1.

- [ ] **Step 2.1: Write the failing unit test** (append to `containment.test.ts`, following the file's existing helper style for nodes/sources)

```ts
test("ambiguous containment degrades to the nearest common ancestor", () => {
  // vnet ⊃ subnet a, subnet b; NAT gateway anchored to both subnets.
  const nodes: GraphNode[] = [
    node("azurerm_virtual_network.hub", "azurerm_virtual_network"),
    node("azurerm_subnet.a", "azurerm_subnet"),
    node("azurerm_subnet.b", "azurerm_subnet"),
    node("azurerm_nat_gateway.shared", "azurerm_nat_gateway"),
  ];
  const sources: DependencySource[] = [
    src("azurerm_subnet.a", "azurerm_virtual_network.hub.name"),
    src("azurerm_subnet.b", "azurerm_virtual_network.hub.name"),
  ];
  deriveContainment(nodes, sources, ctxOf(nodes), {
    ambiguous: new Map([
      ["azurerm_nat_gateway.shared", ["azurerm_subnet.a", "azurerm_subnet.b"]],
    ]),
  });
  const byId = new Map(nodes.map((n) => [n.id, n]));
  assert.equal(
    byId.get("azurerm_nat_gateway.shared")?.parent_id,
    "azurerm_virtual_network.hub",
  );
});

test("no common ancestor leaves the ambiguous node unplaced", () => {
  // Two subnets in two different vnets.
  const nodes: GraphNode[] = [
    node("azurerm_virtual_network.v1", "azurerm_virtual_network"),
    node("azurerm_virtual_network.v2", "azurerm_virtual_network"),
    node("azurerm_subnet.a", "azurerm_subnet"),
    node("azurerm_subnet.b", "azurerm_subnet"),
    node("azurerm_nat_gateway.shared", "azurerm_nat_gateway"),
  ];
  const sources: DependencySource[] = [
    src("azurerm_subnet.a", "azurerm_virtual_network.v1.name"),
    src("azurerm_subnet.b", "azurerm_virtual_network.v2.name"),
  ];
  deriveContainment(nodes, sources, ctxOf(nodes), {
    ambiguous: new Map([
      ["azurerm_nat_gateway.shared", ["azurerm_subnet.a", "azurerm_subnet.b"]],
    ]),
  });
  const byId = new Map(nodes.map((n) => [n.id, n]));
  assert.equal(byId.get("azurerm_nat_gateway.shared")?.parent_id, undefined);
});
```

If `containment.test.ts` lacks `node`/`src`/`ctxOf` helpers, add them matching the pattern in `azurerm-joins.test.ts` (`buildInstancesByBase` over the node ids; `src(fromBase, ...refs)` building `{ fromBase, prefix: "", refs: [{ref, inferred: true}] }`; `node(id, type)` building `{ id, name: id.split(".").pop(), type, provider: "azurerm", module_path: [], change: null }`).

- [ ] **Step 2.2: Run to verify failure** (`joins` param is still a plain Map → type error / no phase 2)

Run: `pnpm --filter @groundplan/backend test 2>&1 | tail -10`
Expected: FAIL (compile error on the new call shape, or `parent_id` undefined in test 1).

- [ ] **Step 2.3: Implement in `containment.ts`**

Add the type and helpers:

```ts
/** What the join catalog tells containment (GP: azurerm joins). */
export type JoinContainment = {
  /** satellite id → its single unambiguous parent (`contain` semantic). */
  parents?: ReadonlyMap<string, string>;
  /** satellite id → 2+ contain anchors — resolved here to their nearest
   * common ancestor once phase 1 has derived the parent chains. */
  ambiguous?: ReadonlyMap<string, readonly string[]>;
};

/** A node and its ancestors, innermost first, cycle-guarded. */
function chainOf(
  id: string,
  parentOf: ReadonlyMap<string, string | undefined>,
): string[] {
  const chain: string[] = [];
  const seen = new Set<string>();
  let current: string | undefined = id;
  while (current !== undefined && !seen.has(current)) {
    seen.add(current);
    chain.push(current);
    current = parentOf.get(current);
  }
  return chain;
}

/** First node present in every anchor's ancestor chain (anchors included, so an
 * anchor that contains the others is itself the answer). */
function nearestCommonAncestor(
  anchors: readonly string[],
  parentOf: ReadonlyMap<string, string | undefined>,
): string | undefined {
  const [first, ...rest] = anchors;
  if (first === undefined) return undefined;
  const restChains = rest.map((a) => new Set(chainOf(a, parentOf)));
  return chainOf(first, parentOf).find((id) => restChains.every((s) => s.has(id)));
}
```

Change the signature and body of `deriveContainment` (4th param becomes `joins?: JoinContainment`; update its doc comment to describe the two phases):

```ts
export function deriveContainment(
  nodes: GraphNode[],
  sources: readonly DependencySource[],
  ctx: EdgeContext,
  joins?: JoinContainment,
): void {
  const r: ResolveCtx = {
    ctx,
    typeById: new Map(nodes.map((n) => [n.id, n.type])),
    sourceByBase: new Map(sources.map((s) => [s.fromBase, s])),
    referrersOf: buildReferrers(sources, ctx),
  };

  applyJoinParents(nodes, joins?.parents, r.typeById);

  // Phase 1: place every node with exactly one qualifying candidate. A rule
  // marked `ancestorFallback` defers its 2+-candidate set to phase 2 instead
  // of falling through — degraded, never guessed.
  const deferred = new Map<string, readonly string[]>(joins?.ambiguous ?? []);
  for (const node of nodes) {
    if (node.parent_id !== undefined) continue; // a join already placed it
    for (const rule of RULES) {
      if (!rule.childMatches(node)) continue;
      const targets = parentCandidates(node, rule, r);
      if (targets.size === 1) {
        node.parent_id = [...targets][0];
        break; // resolved — do not fall through to a lower-priority rule
      }
      if (targets.size > 1 && rule.ancestorFallback) {
        deferred.set(node.id, [...targets].sort());
        break;
      }
      // Zero or 2+ candidates: never guess. Fall through to the next matching
      // rule (a satellite's fallback is the generic subnet rule).
    }
  }

  // Phase 2: an ambiguous multi-anchor set resolves to the nearest common
  // ancestor of its anchors along the freshly-derived chains — a NAT gateway
  // serving two subnets of one vnet lands in that vnet. No common ancestor
  // leaves the node unplaced, exactly as before.
  if (deferred.size === 0) return;
  const parentOf = new Map(nodes.map((n) => [n.id, n.parent_id]));
  const byId = new Map(nodes.map((n) => [n.id, n]));
  for (const [id, anchors] of deferred) {
    const node = byId.get(id);
    if (!node || node.parent_id !== undefined) continue;
    const ancestor = nearestCommonAncestor(anchors, parentOf);
    if (ancestor !== undefined && ancestor !== id) node.parent_id = ancestor;
  }
}
```

Add `ancestorFallback?: boolean;` to the `ContainmentRule` type (doc: `/** On 2+ candidates, defer to the common-ancestor pass instead of falling through. */`). No rule sets it yet (Task 3 does).

Update both producers to pass the object — in `hcl-parser.ts` and `plan-parser.ts` replace `deriveContainment(..., joins.parents)` with:

```ts
deriveContainment([...ctx.nodes.values()], sources, edgeCtx, joins); // hcl
deriveContainment([...nodesById.values()], sources, edgeCtx, joins); // plan
```

(`JoinEffects` structurally satisfies `JoinContainment`.) Update any existing `containment.test.ts` call sites that pass a bare Map as the 4th argument to pass `{ parents: theMap }`.

- [ ] **Step 2.4: Run tests**

Run: `pnpm --filter @groundplan/backend test 2>&1 | tail -5`
Expected: PASS.

- [ ] **Step 2.5: Producer-level coverage — extend the joins fixtures with a two-subnet NAT gateway**

Append to `__fixtures__/hcl-joins/main.tf`:

```hcl
# A second subnet and a NAT gateway serving both: ambiguous containment must
# degrade to the vnet (nearest common ancestor), never guess a subnet.
resource "azurerm_subnet" "internal2" {
  name                 = "internal2"
  virtual_network_name = azurerm_virtual_network.hub.name
}

resource "azurerm_nat_gateway" "shared" {
  name = "shared"
}

resource "azurerm_subnet_nat_gateway_association" "s1" {
  subnet_id      = azurerm_subnet.internal.id
  nat_gateway_id = azurerm_nat_gateway.shared.id
}

resource "azurerm_subnet_nat_gateway_association" "s2" {
  subnet_id      = azurerm_subnet.internal2.id
  nat_gateway_id = azurerm_nat_gateway.shared.id
}
```

Mirror the same four resources into `__fixtures__/plans/joins.plan.json`: add `resource_changes` entries (copy the shape of the existing `azurerm_subnet.internal` / `azurerm_nat_gateway.out` / association entries, `actions: ["create"]`) and matching `configuration.root_module.resources` entries whose `expressions` carry the references (`subnet_id.references: ["azurerm_subnet.internal.id", "azurerm_subnet.internal"]` style — copy the existing association entry's shape exactly, including the doubled ref-with-and-without-attribute convention used there).

Add to the joins test in `hcl-parser.test.ts` (inside the existing `the join catalog places…` test) and the twin in `plan-parser.test.ts`:

```ts
  // Two subnets share one NAT gateway → nearest common ancestor: the vnet.
  assert.equal(
    byId.get("azurerm_nat_gateway.shared")?.parent_id,
    "azurerm_virtual_network.hub",
  );
```

- [ ] **Step 2.6: Run tests**

Run: `pnpm --filter @groundplan/backend test 2>&1 | tail -5`
Expected: PASS. (The single-association NAT `azurerm_nat_gateway.out` assertions must still pass — do not touch them.)

### Task 3: via rule — a VM is placed through its NICs

**Files:**
- Modify: `apps/backend/src/graph/containment.ts` (rule type, `parentCandidates`, `RULES`)
- Modify: `apps/backend/src/graph/hcl-parser.test.ts:70`, `apps/backend/src/graph/plan-parser.test.ts:117` (the flipped expectation)
- Test: `apps/backend/src/graph/containment.test.ts`

**Interfaces:**
- Produces: `ContainmentRule.via?: readonly string[]` — resolve child → via-typed refs → parentTypes.

- [ ] **Step 3.1: Write the failing tests** (append to `containment.test.ts`)

```ts
test("a VM lands in the subnet its NIC references (via rule)", () => {
  const nodes: GraphNode[] = [
    node("azurerm_virtual_network.hub", "azurerm_virtual_network"),
    node("azurerm_subnet.app", "azurerm_subnet"),
    node("azurerm_network_interface.nic", "azurerm_network_interface"),
    node("azurerm_linux_virtual_machine.vm", "azurerm_linux_virtual_machine"),
  ];
  const sources: DependencySource[] = [
    src("azurerm_subnet.app", "azurerm_virtual_network.hub.name"),
    src("azurerm_network_interface.nic", "azurerm_subnet.app.id"),
    src("azurerm_linux_virtual_machine.vm", "azurerm_network_interface.nic.id"),
  ];
  deriveContainment(nodes, sources, ctxOf(nodes));
  const byId = new Map(nodes.map((n) => [n.id, n]));
  assert.equal(
    byId.get("azurerm_linux_virtual_machine.vm")?.parent_id,
    "azurerm_subnet.app",
  );
  // The NIC still stacks under its VM (GP-86) — the via rule must not disturb it.
  assert.equal(
    byId.get("azurerm_network_interface.nic")?.parent_id,
    "azurerm_linux_virtual_machine.vm",
  );
});

test("a VM homed in two subnets degrades to the common vnet", () => {
  const nodes: GraphNode[] = [
    node("azurerm_virtual_network.hub", "azurerm_virtual_network"),
    node("azurerm_subnet.a", "azurerm_subnet"),
    node("azurerm_subnet.b", "azurerm_subnet"),
    node("azurerm_network_interface.n1", "azurerm_network_interface"),
    node("azurerm_network_interface.n2", "azurerm_network_interface"),
    node("azurerm_linux_virtual_machine.vm", "azurerm_linux_virtual_machine"),
  ];
  const sources: DependencySource[] = [
    src("azurerm_subnet.a", "azurerm_virtual_network.hub.name"),
    src("azurerm_subnet.b", "azurerm_virtual_network.hub.name"),
    src("azurerm_network_interface.n1", "azurerm_subnet.a.id"),
    src("azurerm_network_interface.n2", "azurerm_subnet.b.id"),
    src(
      "azurerm_linux_virtual_machine.vm",
      "azurerm_network_interface.n1.id",
      "azurerm_network_interface.n2.id",
    ),
  ];
  deriveContainment(nodes, sources, ctxOf(nodes));
  const byId = new Map(nodes.map((n) => [n.id, n]));
  assert.equal(
    byId.get("azurerm_linux_virtual_machine.vm")?.parent_id,
    "azurerm_virtual_network.hub",
  );
});
```

- [ ] **Step 3.2: Run to verify failure**

Run: `pnpm --filter @groundplan/backend test 2>&1 | tail -10`
Expected: FAIL — VM `parent_id` undefined.

- [ ] **Step 3.3: Implement in `containment.ts`**

Extend `ContainmentRule`:

```ts
  /** Resolve through an intermediate hop: child → refs of these types → each
   * hop's own refs of `parentTypes` (a VM never references a subnet; its NIC's
   * ip_configuration does). */
  via?: readonly string[];
```

At the top of `parentCandidates` (before the `direction === "up"` branch):

```ts
  if (rule.via) {
    const mids = new Set<string>();
    const source = r.sourceByBase.get(stripInstanceIndex(node.id));
    if (source) collectRefsOfType(source, node.id, new Set(rule.via), r, mids);
    for (const mid of mids) {
      const midSource = r.sourceByBase.get(stripInstanceIndex(mid));
      if (midSource) collectRefsOfType(midSource, mid, wanted, r, out);
    }
    return out;
  }
```

Add the VM host types constant next to `LB_SATELLITES`:

```ts
const VM_HOST_TYPES = new Set([
  "azurerm_linux_virtual_machine",
  "azurerm_windows_virtual_machine",
  "azurerm_virtual_machine",
]);
```

Insert the rule into `RULES` after the NIC rule and before the generic subnet rule:

```ts
  // A VM is placed through its NICs (VM → NIC → subnet). Several distinct
  // subnets (a multi-homed VM) degrade to the nearest common ancestor.
  {
    childMatches: (n) => VM_HOST_TYPES.has(n.type),
    parentTypes: ["azurerm_subnet"],
    via: ["azurerm_network_interface"],
    ancestorFallback: true,
  },
```

- [ ] **Step 3.4: Run tests — expect exactly two pre-existing failures to flip**

Run: `pnpm --filter @groundplan/backend test 2>&1 | tail -20`
Expected: the two new tests PASS; `hcl-parser.test.ts` ("derives vnet⊃subnet⊃NIC containment…") and `plan-parser.test.ts` twin FAIL on `azurerm_virtual_machine.main → undefined`. That flip IS the bug fix. Update both assertions to:

```ts
  // The via rule (network-schema-polish): the VM lands in its NIC's subnet.
  assert.equal(
    byId.get("azurerm_virtual_machine.main")?.parent_id,
    "azurerm_subnet.internal",
  );
```

(Adjust the expected subnet id to whatever that fixture's NIC actually references — read the fixture in the test file first.) If any other assertion in those files fails, STOP and re-read: the via rule must not move anything but VM-type nodes.

- [ ] **Step 3.5: Full backend suite + typecheck green**

Run: `pnpm --filter @groundplan/backend test 2>&1 | tail -5 && pnpm typecheck`
Expected: PASS.

- [ ] **Step 3.6: Commit Story A**

```bash
git add apps/backend/src/graph
git commit -m "fix(graph): place a VM through its NIC's subnet; ambiguous containment degrades to the common ancestor

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

## Story B — availability set as a chip on member VM cards (one commit, Tasks 4–5)

### Task 4: backend — inline VM→avset attach duality

**Files:**
- Modify: `apps/backend/src/graph/azurerm-joins.ts` (new `inlineVmAttachLinks`)
- Modify: `apps/backend/src/graph/hcl-parser.ts` (`hclJoinLinks`), `apps/backend/src/graph/plan-parser.ts` (`planJoinLinks`)
- Fixture: `apps/backend/src/graph/__fixtures__/hcl-joins/main.tf`
- Test: `apps/backend/src/graph/azurerm-joins.test.ts`, `apps/backend/src/graph/hcl-parser.test.ts`

**Interfaces:**
- Produces: `export function inlineVmAttachLinks(fromBase: string, prefix: string, refs: Iterable<string>, ctx: EdgeContext, typeById: ReadonlyMap<string, string>): JoinLink[]` — `attach` links, satellite = the referenced availability set, anchor = each VM instance.

- [ ] **Step 4.1: Write the failing test** (append to `azurerm-joins.test.ts`; import `inlineVmAttachLinks`)

```ts
test("a VM's availability_set_id attaches the avset to the VM (inline duality)", () => {
  const { ctx, typeById } = setup({
    "azurerm_linux_virtual_machine.app": "azurerm_linux_virtual_machine",
    "azurerm_availability_set.app": "azurerm_availability_set",
  });
  const links = inlineVmAttachLinks(
    "azurerm_linux_virtual_machine.app",
    "",
    ["azurerm_availability_set.app.id", "azurerm_resource_group.this.name"],
    ctx,
    typeById,
  );
  assert.deepEqual(links, [
    {
      semantic: "attach",
      satelliteId: "azurerm_availability_set.app",
      anchorId: "azurerm_linux_virtual_machine.app",
    },
  ]);
});

test("inlineVmAttachLinks ignores non-VM sources", () => {
  const { ctx, typeById } = setup({
    "azurerm_linux_virtual_machine_scale_set.web":
      "azurerm_linux_virtual_machine_scale_set",
    "azurerm_availability_set.app": "azurerm_availability_set",
  });
  assert.deepEqual(
    inlineVmAttachLinks(
      "azurerm_linux_virtual_machine_scale_set.web",
      "",
      ["azurerm_availability_set.app.id"],
      ctx,
      typeById,
    ),
    [],
  );
});
```

- [ ] **Step 4.2: Run to verify failure** — Run: `pnpm --filter @groundplan/backend test 2>&1 | tail -5` — Expected: FAIL (no export).

- [ ] **Step 4.3: Implement in `azurerm-joins.ts`** (below `inlineScaleSetLinks`):

```ts
/** Satellite types a VM binds inline (no association resource exists for them). */
const INLINE_VM_ATTACH_SATELLITES = new Set(["azurerm_availability_set"]);

/**
 * The inline half of the availability-set duality: a VM states its avset via
 * `availability_set_id`, not an association resource. A referenced satellite
 * attaches to each VM instance exactly as an association resource would have
 * said it. `refs` are the VM's own raw references; anything not resolving to a
 * listed satellite type is ignored.
 */
export function inlineVmAttachLinks(
  fromBase: string,
  prefix: string,
  refs: Iterable<string>,
  ctx: EdgeContext,
  typeById: ReadonlyMap<string, string>,
): JoinLink[] {
  if (!VM_TYPES.includes(typeOfBase(fromBase))) return [];
  const anchors = ctx.instancesByBase.get(fromBase) ?? [fromBase];
  const satellites = new Set<string>();
  for (const ref of refs) {
    for (const id of resolveReference(prefix, ref, ctx)) {
      if (INLINE_VM_ATTACH_SATELLITES.has(typeById.get(id) ?? "")) satellites.add(id);
    }
  }
  const links: JoinLink[] = [];
  for (const satelliteId of [...satellites].sort(compareStrings)) {
    for (const anchorId of anchors) {
      links.push({ semantic: "attach", satelliteId, anchorId });
    }
  }
  return links;
}
```

Wire into both producers. `hcl-parser.ts` `hclJoinLinks` — replace the scale-set-only loop body:

```ts
  for (const ps of ctx.pendingSources) {
    if (!ps.fromBase.includes("_virtual_machine")) continue;
    const refs = extractReferences(ps.body);
    links.push(
      ...inlineScaleSetLinks(ps.fromBase, ps.prefix, refs, edgeCtx, typeById),
    );
    links.push(
      ...inlineVmAttachLinks(ps.fromBase, ps.prefix, refs, edgeCtx, typeById),
    );
  }
```

`plan-parser.ts` `planJoinLinks` — same shape (`address.includes("_virtual_machine")`, refs from `collectReferences(entry.expressions, refs)`), calling both helpers. Update both import lists.

- [ ] **Step 4.4: Fixture coverage** — append to `__fixtures__/hcl-joins/main.tf`:

```hcl
resource "azurerm_availability_set" "app" {
  name = "app-avset"
}

resource "azurerm_linux_virtual_machine" "app" {
  name                  = "app-vm"
  availability_set_id   = azurerm_availability_set.app.id
  network_interface_ids = [azurerm_network_interface.nic.id]
}
```

Add to the joins test in `hcl-parser.test.ts`:

```ts
  // Inline duality: availability_set_id → the avset chips onto its VM.
  assert.deepEqual(byId.get("azurerm_availability_set.app")?.associated_ids, [
    "azurerm_linux_virtual_machine.app",
  ]);
  // And the via rule places the VM in its NIC's subnet.
  assert.equal(
    byId.get("azurerm_linux_virtual_machine.app")?.parent_id,
    "azurerm_subnet.internal",
  );
```

Caution: the fixture's `azurerm_network_interface.nic` may already be asserted to have some `parent_id` — adding a VM that references it flips the NIC's parent to the VM (GP-86 up-rule). If an existing assertion breaks, update it to expect `azurerm_linux_virtual_machine.app` and note it in the commit body.

- [ ] **Step 4.5: Run backend tests** — Expected: PASS.

### Task 5: frontend — chips on host cards

**Files:**
- Create: `apps/frontend/src/components/attachment-chip.tsx` (move `SubnetChip` + `chipVariant` out of `network-container-node.tsx`, renamed `AttachmentChip`, keep the `data-subnet-chip` attribute for test continuity)
- Modify: `apps/frontend/src/lib/graph-layout.ts` (`subnetChips` → `attachmentChips`, `networkProjection`, `elkNodeFor`)
- Modify: `apps/frontend/src/components/network-container-node.tsx` (import the moved chip)
- Modify: `apps/frontend/src/components/graph-node.tsx` (`NodeCard` chips row + props, `ResourceFlowNode` wiring)
- Modify: `apps/frontend/src/components/graph-canvas.tsx` (~line 630: extend the chip wiring — `onSelectChip` / `highlightedChipId` — from container nodes to any node whose data carries `chips`)
- Test: `apps/frontend/src/lib/graph-layout.test.ts`, `apps/frontend/src/components/graph-node.test.tsx`

**Interfaces:**
- Produces: `export function attachmentChips(graph: Graph, containerIds: ReadonlySet<string>, stacks: ReadonlyMap<string, GraphNode[]>): Map<string, GraphNode[]>` (replaces `subnetChips` — update every import/test); `NodeCard` accepts `chips?: GraphNode[]`, `highlightedChipId?: string`, `onSelectChip?: (node: GraphNode) => void`.

- [ ] **Step 5.1: Write the failing layout tests** (in `graph-layout.test.ts`, mirroring the existing `subnetChips` tests' helper style)

```ts
it("chips an avset onto its member VM cards and hides its node", () => {
  const graph = g(
    [
      n("vnet", "azurerm_virtual_network"),
      n("subnet", "azurerm_subnet", { parent_id: "vnet" }),
      n("vm1", "azurerm_linux_virtual_machine", { parent_id: "subnet" }),
      n("vm2", "azurerm_linux_virtual_machine", { parent_id: "subnet" }),
      n("avset", "azurerm_availability_set", { associated_ids: ["vm1", "vm2"] }),
    ],
    [],
  );
  const { chips, stacks } = networkProjection(graph);
  expect(chips.get("vm1")?.map((c) => c.id)).toEqual(["avset"]);
  expect(chips.get("vm2")?.map((c) => c.id)).toEqual(["avset"]);
  // Chip-carried → not laid out as a node.
  const elk = toElkGraph(networkProjection(graph).graph, undefined,
    networkProjection(graph).containerIds, stacks, chips);
  const ids: string[] = [];
  const walk = (node: { id: string; children?: unknown[] }) => {
    ids.push(node.id);
    for (const c of (node.children ?? []) as { id: string; children?: unknown[] }[]) walk(c);
  };
  walk(elk);
  expect(ids).not.toContain("avset");
});

it("keeps a satellite floating when its only anchor is itself stacked", () => {
  // NSG associated to a NIC that is stacked inside a VM: no chip home → floats.
  const graph = g(
    [
      n("vnet", "azurerm_virtual_network"),
      n("subnet", "azurerm_subnet", { parent_id: "vnet" }),
      n("vm", "azurerm_linux_virtual_machine", { parent_id: "subnet" }),
      n("nic", "azurerm_network_interface", { parent_id: "vm" }),
      n("nsg", "azurerm_network_security_group", { associated_ids: ["nic"] }),
    ],
    [],
  );
  const { chips } = networkProjection(graph);
  expect([...chips.values()].flat().map((c) => c.id)).not.toContain("nsg");
});
```

(Use the file's actual `n`/`g` helpers — read the top of the test file first and match them.)

- [ ] **Step 5.2: Run to verify failure** — Run: `pnpm --filter @groundplan/frontend test 2>&1 | tail -10` — Expected: FAIL.

- [ ] **Step 5.3: Implement in `graph-layout.ts`**

Replace `subnetChips` with (update the doc comment to cover both anchor kinds):

```ts
/**
 * GP-89, generalized: attachments render as chips on their anchor — an NSG /
 * route table on its subnet frame header, an availability set on each member
 * VM's card. An eligible anchor is a kept subnet container or a top-level
 * resource card; an anchor that is itself stacked inside a host (a NIC) offers
 * no chip home, so a satellite with no eligible anchor stays a floating node —
 * a chip is never lost to a missing anchor.
 */
export function attachmentChips(
  graph: Graph,
  containerIds: ReadonlySet<string>,
  stacks: ReadonlyMap<string, GraphNode[]>,
): Map<string, GraphNode[]> {
  const byId = new Map(graph.nodes.map((n) => [n.id, n]));
  const stacked = new Set<string>();
  for (const list of stacks.values()) for (const c of list) stacked.add(c.id);
  const eligible = (anchor: string): boolean => {
    const node = byId.get(anchor);
    if (!node || isModule(node)) return false;
    if (containerIds.has(anchor)) return node.type === "azurerm_subnet";
    return !stacked.has(anchor); // a top-level resource card
  };
  const chips = new Map<string, GraphNode[]>();
  for (const node of graph.nodes) {
    for (const anchor of node.associated_ids ?? []) {
      if (!eligible(anchor)) continue;
      const list = chips.get(anchor);
      if (list) list.push(node);
      else chips.set(anchor, [node]);
    }
  }
  for (const list of chips.values()) list.sort((a, b) => a.id.localeCompare(b.id));
  return chips;
}
```

In `networkProjection`, compute stacks before chips and return them from the same values:

```ts
  const stacks = resourceStacks(projected, containerIds);
  return {
    graph: projected,
    hiddenCount,
    containerIds,
    stacks,
    chips: attachmentChips(projected, containerIds, stacks),
  };
```

In `elkNodeFor`, add chip height to resource cards (new const `const CARD_CHIP_BAND = 26;` next to `CHIP_BAND`):

```ts
  const hostChildren = stacks?.get(node.id);
  const chipCount = chips?.get(node.id)?.length ?? 0;
  const base = hostChildren ? stackHostHeight(hostChildren.length) : RESOURCE_HEIGHT;
  return {
    id: node.id,
    width: RESOURCE_WIDTH,
    height: base + (chipCount > 0 ? CARD_CHIP_BAND : 0),
  };
```

Update every `subnetChips` import/call (grep the frontend; the test file imports it). Note `elkToFlow` already passes `chips` into node data unconditionally — no change there.

- [ ] **Step 5.4: Component work**

Create `attachment-chip.tsx` with the exact `chipVariant` + chip component moved from `network-container-node.tsx` (export as `AttachmentChip`); replace the local copy in `network-container-node.tsx` with the import. In `graph-node.tsx`, add the props and render the chip row between the header `div` and `StackSection`:

```tsx
      {/* Attachments chip row (avset on its member VM, GP network-schema-polish). */}
      {hasChips && (
        <div className="flex flex-wrap gap-1 px-2 pb-1">
          {chips.map((chip) => (
            <AttachmentChip
              key={chip.id}
              node={chip}
              highlighted={chip.id === highlightedChipId}
              onSelect={onSelectChip}
            />
          ))}
        </div>
      )}
```

with `const hasChips = chips !== undefined && chips.length > 0;` and prop plumbing in `ResourceFlowNode` (`chips: data.chips as GraphNode[] | undefined`, `highlightedChipId`, `onSelectChip` — cast like the existing `onSelectStackChild`). In `graph-canvas.tsx`, find the ~line-630 block that injects `onSelectChip: selectChip` / `highlightedChipId` into container node data and widen its condition so any node whose `data.chips` is set gets the same two fields.

Component test (append to `graph-node.test.tsx`, matching its render helpers):

```tsx
it("renders attachment chips on the card and selects on click", async () => {
  const onSelectChip = vi.fn();
  const avset = makeNode({ id: "avset", name: "app", type: "azurerm_availability_set" });
  render(
    <NodeCard
      graphNode={makeNode({ id: "vm", type: "azurerm_linux_virtual_machine" })}
      chips={[avset]}
      onSelectChip={onSelectChip}
    />,
  );
  await userEvent.click(screen.getByTitle("azurerm_availability_set · app"));
  expect(onSelectChip).toHaveBeenCalledWith(avset);
});
```

- [ ] **Step 5.5: Run frontend tests + typecheck** — Expected: PASS (update any `subnetChips`-era test expectation that legitimately changed — e.g. an NSG anchored to a *top-level* NIC card now chips instead of floating; verify each flip against the design before accepting it).

- [ ] **Step 5.6: Commit Story B**

```bash
git add apps/backend/src/graph apps/frontend/src
git commit -m "feat: availability set as a chip on its member VM cards

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

## Story C — typed satellite rows (one commit, Task 6)

### Task 6: stack rows say what they are

**Files:**
- Modify: `apps/frontend/src/components/graph-node.tsx` (`StackRow`)
- Test: `apps/frontend/src/components/graph-node.test.tsx`

- [ ] **Step 6.1: Failing test**

```tsx
it("prefixes a stacked row with its kind", () => {
  render(
    <NodeCard
      graphNode={makeNode({ id: "lb", type: "azurerm_lb" })}
      stack={[
        makeNode({ id: "p", name: "app", type: "azurerm_lb_backend_address_pool" }),
        makeNode({ id: "pr", name: "app", type: "azurerm_lb_probe" }),
      ]}
    />,
  );
  expect(screen.getByText("pool")).toBeInTheDocument();
  expect(screen.getByText("probe")).toBeInTheDocument();
});
```

- [ ] **Step 6.2: Verify failure** — Run: `pnpm --filter @groundplan/frontend test 2>&1 | tail -5`

- [ ] **Step 6.3: Implement** — in `graph-node.tsx` add above `StackRow`:

```ts
/** Short kind labels for common satellite rows; anything else falls back to
 * shortType. Three LB rows all named "app" must not read identically. */
const STACK_KIND_LABELS: Record<string, string> = {
  azurerm_lb_backend_address_pool: "pool",
  azurerm_lb_probe: "probe",
  azurerm_lb_rule: "rule",
  azurerm_lb_nat_rule: "nat rule",
  azurerm_lb_outbound_rule: "outbound",
  azurerm_network_interface: "nic",
  azurerm_public_ip: "pip",
  azurerm_public_ip_prefix: "pip prefix",
  azurerm_managed_disk: "disk",
};

const stackKindOf = (type: string): string =>
  STACK_KIND_LABELS[type] ?? shortType(type);
```

In `StackRow`, replace the single label span with kind + name:

```tsx
      <span className="text-muted-foreground shrink-0 font-mono text-[10px]">
        {stackKindOf(child.type)}
      </span>
      <span className="text-ink min-w-0 flex-1 truncate font-mono text-[10px]">
        {label}
      </span>
```

- [ ] **Step 6.4: Tests + typecheck pass**, then commit:

```bash
git add apps/frontend/src/components
git commit -m "feat(frontend): typed satellite rows — stacked children say what they are

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

## Story D — subnet CIDR on headers + CIDR ordering (one commit, Tasks 7–8)

### Task 7: backend — emit CIDRs into `attributes`

**Files:**
- Modify: `apps/backend/src/graph/hcl-parser.ts` (list reader + node attributes + version), `apps/backend/src/graph/plan-parser.ts` (after-derived attributes + version)
- Test: `apps/backend/src/graph/hcl-parser.test.ts`, `apps/backend/src/graph/plan-parser.test.ts`

**Interfaces:**
- Produces: subnet nodes carry `attributes.address_prefixes` (`"10.0.1.0/24"` or comma-joined), vnet nodes `attributes.address_space`; graph `version` becomes `7` when any node carries `attributes`.

- [ ] **Step 7.1: Failing tests.** HCL side (new test, inline files style used elsewhere in the file):

```ts
test("subnet and vnet CIDRs land in attributes and escalate to v7", () => {
  const { graph } = parseHclRepo([
    {
      path: "main.tf",
      content: `
resource "azurerm_virtual_network" "hub" {
  name          = "hub"
  address_space = ["10.0.0.0/16"]
}
resource "azurerm_subnet" "app" {
  name                 = "app"
  virtual_network_name = azurerm_virtual_network.hub.name
  address_prefixes     = ["10.0.1.0/24"]
}
`,
    },
  ]);
  const byId = new Map(graph.nodes.map((n) => [n.id, n]));
  assert.equal(byId.get("azurerm_subnet.app")?.attributes?.["address_prefixes"], "10.0.1.0/24");
  assert.equal(byId.get("azurerm_virtual_network.hub")?.attributes?.["address_space"], "10.0.0.0/16");
  assert.equal(graph.version, 7);
});
```

Plan side: the joins fixture's `azurerm_subnet.internal` entry — add `"address_prefixes": ["10.0.1.0/24"]` to its `change.after` object in `joins.plan.json`, then assert in the joins test of `plan-parser.test.ts`:

```ts
  assert.equal(
    byId.get("azurerm_subnet.internal")?.attributes?.["address_prefixes"],
    "10.0.1.0/24",
  );
  assert.equal(graph.version, 7);
```

Check whether other `plan-parser.test.ts` tests assert `graph.version === 4` on fixtures that now gain attributes — only the joins fixture gains them, so only its version assertion (if any) moves to 7.

- [ ] **Step 7.2: Verify failure**, then implement.

`hcl-parser.ts` — add next to `readAttr`:

```ts
/** Read a flat list-of-strings attribute (`key = ["a", "b"]`) from a block body. */
function readStringList(body: string, key: string): string[] | undefined {
  const m = new RegExp(
    String.raw`(?:^|\n)[ \t]*${key}[ \t]*=[ \t]*\[([^\]]*)\]`,
  ).exec(body);
  if (!m) return undefined;
  const items = [...(m[1] as string).matchAll(/"([^"]*)"/g)].map(
    (x) => x[1] as string,
  );
  return items.length > 0 ? items : undefined;
}

/** v7 attributes a network frame carries: its statically-declared CIDRs. */
function hclNetworkAttributes(
  type: string,
  body: string,
): Record<string, string> | undefined {
  const key =
    type === "azurerm_subnet"
      ? "address_prefixes"
      : type === "azurerm_virtual_network"
        ? "address_space"
        : null;
  if (!key) return undefined;
  const values = readStringList(body, key);
  return values ? { [key]: values.join(", ") } : undefined;
}
```

In `parseModuleDir`, right after `ctx.nodes.set(id, {...})` for resource/data blocks:

```ts
        const attrs = hclNetworkAttributes(type, block.body);
        const created = ctx.nodes.get(id);
        if (attrs && created) created.attributes = attrs;
```

(`attributes` appended after the base fields, keeping node key order stable.) Version — replace the version computation tail:

```ts
  let version: Graph["version"] = nodes.some(isV4) ? 4 : 1;
  if (nodes.some((n) => n.attributes !== undefined)) version = 7;
```

`plan-parser.ts` — add:

```ts
/** v7 attributes a network frame carries: its CIDRs, from the plan's `after`. */
function planNetworkAttributes(
  type: string,
  after: Record<string, unknown>,
): Record<string, string> | undefined {
  const key =
    type === "azurerm_subnet"
      ? "address_prefixes"
      : type === "azurerm_virtual_network"
        ? "address_space"
        : null;
  if (!key) return undefined;
  const value = after[key];
  if (!Array.isArray(value) || value.length === 0) return undefined;
  return { [key]: value.map(String).join(", ") };
}
```

In the node-building loop (where `rc.change` is at hand), after the `attribute_diff` block:

```ts
    const after = (rc.change?.after ?? {}) as Record<string, unknown>;
    const attrs = planNetworkAttributes(node.type, after);
    if (attrs) node.attributes = attrs;
```

Version — after the `isV4` check:

```ts
  if (withImpact.nodes.some((n) => n.attributes !== undefined)) version = 7;
```

- [ ] **Step 7.3: Backend tests pass.**

### Task 8: frontend — CIDR on frame headers + CIDR-ordered subnets

**Files:**
- Modify: `apps/frontend/src/components/network-container-node.tsx` (header CIDR)
- Modify: `apps/frontend/src/lib/graph-layout.ts` (`toElkGraph` child ordering + model-order options)
- Test: `apps/frontend/src/components/network-container-node.test.tsx`, `apps/frontend/src/lib/graph-layout.test.ts`

- [ ] **Step 8.1: Failing tests.** Header (component test):

```tsx
it("shows the subnet CIDR on the frame header", () => {
  render(
    <NetworkContainer
      graphNode={makeNode({
        id: "s", name: "web", type: "azurerm_subnet",
        attributes: { address_prefixes: "10.0.2.0/24" },
      })}
    />,
  );
  expect(screen.getByText("10.0.2.0/24")).toBeInTheDocument();
});
```

Ordering (layout test): three subnets with CIDRs 10.0.3.0/24, 10.0.1.0/24, 10.0.2.0/24 inside one vnet (ids chosen so alphabetical ≠ CIDR order, e.g. `sa`→.3, `sb`→.1, `sc`→.2); assert the vnet's ELK `children` ids come back `["sb", "sc", "sa"]` and the vnet container's `layoutOptions` include `"elk.layered.considerModelOrder.strategy": "NODES_AND_EDGES"`.

- [ ] **Step 8.2: Verify failure**, then implement.

`network-container-node.tsx` — inside the header label `<span>`, after the name span:

```tsx
        {cidr && (
          <span className="text-faint font-normal normal-case tracking-normal">
            {cidr}
          </span>
        )}
```

with, above the return:

```ts
  const cidr =
    graphNode.attributes?.["address_prefixes"] ??
    graphNode.attributes?.["address_space"];
```

`graph-layout.ts` — add:

```ts
/** Numeric sort value of a node's first CIDR, or null when it has none. */
function cidrSortValue(node: GraphNode): number | null {
  const raw = node.attributes?.["address_prefixes"]?.split(",")[0]?.trim();
  const m = raw ? /^(\d+)\.(\d+)\.(\d+)\.(\d+)\/\d+$/.exec(raw) : null;
  if (!m) return null;
  const [, a, b, c, d] = m;
  if (a === undefined || b === undefined || c === undefined || d === undefined) {
    return null;
  }
  return ((Number(a) * 256 + Number(b)) * 256 + Number(c)) * 256 + Number(d);
}

/**
 * Order a container's children by CIDR (known CIDRs first, numerically; the
 * rest keep id order) and tell ELK to respect that model order — so subnets lay
 * out by address plan, stable across code refactors, not by declaration or id.
 */
function orderChildrenByCidr(
  elk: ElkGraphNode,
  byId: ReadonlyMap<string, GraphNode>,
): void {
  const children = elk.children;
  if (!children || children.length < 2) return;
  const values = new Map(
    children.map((c) => [c.id, cidrSortValue(byId.get(c.id) ?? ({} as GraphNode))]),
  );
  if (![...values.values()].some((v) => v !== null)) return;
  children.sort((x, y) => {
    const a = values.get(x.id) ?? null;
    const b = values.get(y.id) ?? null;
    if (a !== null && b !== null) return a - b;
    if (a !== null) return -1;
    if (b !== null) return 1;
    return x.id.localeCompare(y.id);
  });
  elk.layoutOptions = {
    ...elk.layoutOptions,
    "elk.layered.considerModelOrder.strategy": "NODES_AND_EDGES",
    "elk.layered.crossingMinimization.forceNodeModelOrder": "true",
  };
}
```

In `toElkGraph`, after `const roots = nestElkNodes(...)`:

```ts
  const byId = new Map(graph.nodes.map((n) => [n.id, n]));
  for (const elk of elkById.values()) orderChildrenByCidr(elk, byId);
```

- [ ] **Step 8.3: Frontend tests + typecheck pass**, then commit Story D:

```bash
git add apps/backend/src/graph apps/frontend/src
git commit -m "feat: subnet CIDR on frame headers, subnets ordered by address plan

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

## Story E — ×n badge for literal count (one commit, Task 9)

### Task 9: literal `count` → attribute → badge

**Files:**
- Modify: `apps/backend/src/graph/hcl-parser.ts` (count attribute)
- Modify: `apps/frontend/src/components/graph-node.tsx` (badge)
- Test: `apps/backend/src/graph/hcl-parser.test.ts`, `apps/frontend/src/components/graph-node.test.tsx`

- [ ] **Step 9.1: Failing tests.** Backend:

```ts
test("a literal count lands in attributes; an expression count does not", () => {
  const { graph } = parseHclRepo([
    {
      path: "main.tf",
      content: `
resource "azurerm_linux_virtual_machine" "app" {
  name  = "app"
  count = 2
}
resource "azurerm_linux_virtual_machine" "dyn" {
  name  = "dyn"
  count = var.n
}
`,
    },
  ]);
  const byId = new Map(graph.nodes.map((n) => [n.id, n]));
  assert.equal(byId.get("azurerm_linux_virtual_machine.app")?.attributes?.["count"], "2");
  assert.equal(byId.get("azurerm_linux_virtual_machine.dyn")?.attributes?.["count"], undefined);
});
```

Frontend:

```tsx
it("shows a ×n badge for a literal count", () => {
  render(
    <NodeCard
      graphNode={makeNode({
        id: "vm", type: "azurerm_linux_virtual_machine",
        attributes: { count: "2" },
      })}
    />,
  );
  expect(screen.getByText("×2")).toBeInTheDocument();
});
```

- [ ] **Step 9.2: Verify failure**, then implement.

`hcl-parser.ts` — extend `hclNetworkAttributes` into the general attribute builder (rename to `hclNodeAttributes(type, body)`), merging:

```ts
function hclNodeAttributes(
  type: string,
  body: string,
): Record<string, string> | undefined {
  const attrs: Record<string, string> = {};
  const key =
    type === "azurerm_subnet"
      ? "address_prefixes"
      : type === "azurerm_virtual_network"
        ? "address_space"
        : null;
  if (key) {
    const values = readStringList(body, key);
    if (values) attrs[key] = values.join(", ");
  }
  // A literal `count` is knowable without evaluation; an expression is not.
  const count = readAttr(body, "count");
  if (count !== undefined && /^\d+$/.test(count)) attrs["count"] = count;
  return Object.keys(attrs).length > 0 ? attrs : undefined;
}
```

(Update the Task 7 call site name. The plan producer emits nothing for count — real instances are already expanded there, so the badge is docs-view-only by construction.)

`graph-node.tsx` — in the header, after the name/label `div`, before the hub indicator:

```tsx
      {countLiteral !== undefined && (
        <span
          className="bg-muted text-muted-foreground shrink-0 rounded-full px-1.5 py-0.5 font-mono text-[10px]"
          title={`count = ${countLiteral}`}
        >
          ×{countLiteral}
        </span>
      )}
```

with `const countLiteral = graphNode.attributes?.["count"];` next to the other derivations.

- [ ] **Step 9.3: All tests + typecheck pass**, then commit Story E:

```bash
git add apps/backend/src/graph apps/frontend/src/components
git commit -m "feat: ×n badge — a literal count reads off the docs-view card

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

## Final verification

- [ ] `pnpm --filter @groundplan/backend test` — all pass
- [ ] `pnpm --filter @groundplan/frontend test` — all pass (including `design-tokens.test.ts` and vitest-axe assertions on touched components)
- [ ] `pnpm typecheck` — clean
- [ ] Optional end-to-end sanity: the `verify` skill against the terraform at `/home/qrodic/workspace/local/terraform-test/src` — the NAT gateway should render inside the VNet with dashed edges to subnets `web` and `this`; both `linux_virtual_machine` cards inside subnet `this` with an `avset app` chip on the two app VMs; lb rows reading `pool app` / `probe app` / `rule app`; subnet headers carrying CIDRs in address order.
