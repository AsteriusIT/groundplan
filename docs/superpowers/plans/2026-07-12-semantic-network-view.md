# Semantic Network View (GP-42 → GP-45) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give Groundplan a semantic network view — vnet⊃subnet⊃resource containment and internet-exposure highlighting — derived deterministically from the GraphSnapshot and rendered by the existing React Flow / ELK canvas.

**Architecture:** Backend adds two optional, versioned node payloads to the source-agnostic graph — `parent_id` (containment) and NSG `rules[]`/`internet_exposed`/`associated_ids[]` — each derived in a shared post-parse step reused by both producers (plan.json and static HCL). Frontend adds a pure `networkProjection` that re-nests the same snapshot by `parent_id` through the existing subflow mechanism, a URL-driven view switcher, and one exposure treatment (badge + ring + a side-panel rules table). No new API; no fork of the node components.

**Tech Stack:** Backend — TypeScript (ESM/NodeNext), Ajv, `node --test` + tsx. Frontend — React 19, `@xyflow/react`, elkjs, Tailwind v4, vitest + Testing Library (jsdom).

## Global Constraints

- **ESM `.js` import extensions** on all backend relative imports (source is `.ts`). Required.
- **Optional fields only**; a snapshot's `version` escalates only when a new field is actually populated. Old v1/v2/v3 snapshots stay valid and byte-identical. Schema `version` enum becomes `[1,2,3,4]`.
- **One containment mechanism** (`parent_id`) — never a second edge kind. Module `contains` edges are untouched and orthogonal.
- **Never guess a parent:** unresolvable or ambiguous (>1 candidate) → `parent_id` absent.
- **No hardcoded colours** in components — use semantic Tailwind tokens generated from `src/index.css` (`design-tokens.test.ts` guards this). New `exposed` colour is added as a token.
- **No new API, no cloud credentials, no state access.** Pure functions over plan JSON / HCL text. Sensitive-value masking (GP-32) is never touched.
- **Determinism:** stable ordering everywhere (the parsers already sort nodes/edges; new fields must not perturb that).
- **Commit granularity:** one commit per story, at the end of that story's last task, using the repo's `feat(scope): summary (GP-xx)` convention. Run `pnpm typecheck` + the story's tests green before each commit.
- **Backend commits touch only `apps/backend/`; frontend commits touch only `apps/frontend/`.** The frontend `api/types.ts` mirror is updated in the frontend commit that first consumes each field.

## Test commands (referenced throughout)

- Backend, one file: `pnpm --filter @groundplan/backend exec env NODE_ENV=test node --import tsx --test <path>`
- Backend, all: `pnpm --filter @groundplan/backend test`
- Frontend, one file: `pnpm --filter @groundplan/frontend exec vitest run <path>`
- Frontend, all: `pnpm --filter @groundplan/frontend test`
- Typecheck (root, all packages): `pnpm typecheck`

## File Structure

**GP-42 (backend)**
- Modify `apps/backend/schema/graph.v1.schema.json` — add `parent_id`; `version` enum `[1,2,3,4]`.
- Modify `apps/backend/src/graph/graph.ts` — `GraphNode.parent_id?`, `version: 1|2|3|4`.
- Create `apps/backend/src/graph/containment.ts` — `deriveContainment` + rule table.
- Create `apps/backend/src/graph/containment.test.ts`.
- Modify `apps/backend/src/graph/plan-parser.ts` + `hcl-parser.ts` — call `deriveContainment`, escalate version.
- Add/extend fixtures under `apps/backend/src/graph/__fixtures__/`.

**GP-43 (backend)**
- Modify schema + `graph.ts` — `NsgRule`, `rules?`, `internet_exposed?`, `associated_ids?`.
- Create `apps/backend/src/graph/nsg.ts` — `computeInternetExposed`, `normalizePorts`, extraction/attach helpers.
- Create `apps/backend/src/graph/nsg.test.ts`.
- Modify both parsers — extract NSG data; call the shared attach step.
- Extend fixtures.

**GP-44 (frontend)**
- Modify `apps/frontend/src/api/types.ts` — `parent_id?`, `Graph.version: 1|2|3|4`.
- Modify `apps/frontend/src/lib/graph-layout.ts` — `networkProjection`; generalize container detection.
- Create `apps/frontend/src/components/network-container-node.tsx` — resource-backed container.
- Create `apps/frontend/src/components/view-switcher.tsx` — `?view` segmented control.
- Modify `apps/frontend/src/components/graph-canvas.tsx` — register `container` node type.
- Modify `apps/frontend/src/pages/pull-detail-page.tsx` + `docs-page.tsx` — switcher, projection, hidden-count chip.
- Tests: `graph-layout.test.ts`, `view-switcher.test.tsx` (+ existing canvas test unaffected).

**GP-45 (frontend)**
- Modify `apps/frontend/src/api/types.ts` — `NsgRule`, `rules?`, `internet_exposed?`, `associated_ids?`.
- Modify `apps/frontend/src/index.css` — `--exposed` / `--exposed-soft` tokens.
- Modify `apps/frontend/src/lib/status.ts` — `exposed` metadata.
- Modify `apps/frontend/src/lib/graph-layout.ts` — `exposedNodeIds`; thread `exposed` into node data.
- Modify `apps/frontend/src/lib/node-details.ts` — `sortedRules` helper.
- Modify `apps/frontend/src/components/graph-node.tsx` + `network-container-node.tsx` — badge + ring.
- Modify `apps/frontend/src/components/node-details-panel.tsx` — Security rules section.
- Tests: `graph-layout.test.ts`, `graph-node.test.tsx`, `node-details-panel.test.tsx`.

---

## Story GP-42 — Network containment (`parent_id`)

### Task 42.1: Extend the schema + graph types with `parent_id`

**Files:**
- Modify: `apps/backend/schema/graph.v1.schema.json`
- Modify: `apps/backend/src/graph/graph.ts:57-65` (Graph.version), `:20-43` (GraphNode)
- Test: `apps/backend/src/graph/graph.test.ts`

**Interfaces:**
- Produces: `GraphNode.parent_id?: string` (a node id, or absent); `Graph.version: 1|2|3|4`.

- [ ] **Step 1: Write the failing test.** Append to `graph.test.ts`:

```ts
test("validateGraph accepts a v4 graph with parent_id", () => {
  const graph = {
    version: 4,
    nodes: [
      { id: "azurerm_virtual_network.main", name: "main", type: "azurerm_virtual_network", provider: "azurerm", module_path: [], change: "create" },
      { id: "azurerm_subnet.internal", name: "internal", type: "azurerm_subnet", provider: "azurerm", module_path: [], change: "create", parent_id: "azurerm_virtual_network.main" },
    ],
    edges: [],
  };
  assert.deepEqual(validateGraph(graph), { valid: true, errors: [] });
});

test("validateGraph rejects a non-string parent_id", () => {
  const graph = { version: 4, nodes: [ { id: "a", name: "a", type: "t", provider: null, module_path: [], change: null, parent_id: 5 } ], edges: [] };
  assert.equal(validateGraph(graph).valid, false);
});
```

- [ ] **Step 2: Run — expect FAIL** (version 4 not in enum / parent_id unknown property).

Run: `pnpm --filter @groundplan/backend exec env NODE_ENV=test node --import tsx --test src/graph/graph.test.ts`
Expected: FAIL.

- [ ] **Step 3: Edit the schema.** In `graph.v1.schema.json`: change `"version": { … "enum": [1, 2, 3] }` to `"enum": [1, 2, 3, 4]` and update its description to append `; 4 adds optional node parent_id containment (GP-42).`. Inside `definitions.node.properties`, after `attribute_diff_truncated`, add:

```json
"parent_id": {
  "type": ["string", "null"],
  "description": "v4: id of the containing node (vnet⊃subnet⊃resource). Absent/null when no single unambiguous parent resolves. Distinct from module `contains` edges (GP-42)."
}
```

- [ ] **Step 4: Edit `graph.ts`.** In `GraphNode` (after `attribute_diff_truncated?`), add:

```ts
  /**
   * v4: id of the node that contains this one (vnet⊃subnet⊃resource). Absent
   * when no single unambiguous parent resolves. Distinct from module `contains`
   * edges — this is network containment (GP-42).
   */
  parent_id?: string;
```

Change `export type Graph = { version: 1 | 2 | 3; …` to `version: 1 | 2 | 3 | 4;` and update the adjacent comment to mention `4 adds optional node parent_id (GP-42)`.

- [ ] **Step 5: Run — expect PASS.**

Run: `pnpm --filter @groundplan/backend exec env NODE_ENV=test node --import tsx --test src/graph/graph.test.ts`
Expected: PASS. (No commit yet — GP-42 commits at Task 42.3.)

### Task 42.2: `deriveContainment` — the shared derivation

**Files:**
- Create: `apps/backend/src/graph/containment.ts`
- Test: `apps/backend/src/graph/containment.test.ts`

**Interfaces:**
- Consumes: `GraphNode[]`, `DependencySource[]`, `EdgeContext`, `resolveReference`, `stripInstanceIndex` (from `./dependency-edges.js`).
- Produces: `deriveContainment(nodes: GraphNode[], sources: readonly DependencySource[], ctx: EdgeContext): void` — mutates nodes in place, setting `parent_id` where exactly one reference resolves to a node of the expected parent type.

- [ ] **Step 1: Write the failing test.** Create `containment.test.ts`:

```ts
import { test } from "node:test";
import assert from "node:assert/strict";

import { deriveContainment } from "./containment.js";
import { buildInstancesByBase, type DependencySource, type EdgeContext } from "./dependency-edges.js";
import type { GraphNode } from "./graph.js";

function node(id: string, type: string): GraphNode {
  return { id, name: id.split(".").pop()!, type, provider: "azurerm", module_path: [], change: null };
}
function ctxFor(nodes: GraphNode[]): EdgeContext {
  const resourceIds = new Set(nodes.filter((n) => n.type !== "module").map((n) => n.id));
  return { resourceIds, moduleIds: new Set(), instancesByBase: buildInstancesByBase(resourceIds) };
}

test("subnet is contained by the vnet it references", () => {
  const nodes = [node("azurerm_virtual_network.main", "azurerm_virtual_network"), node("azurerm_subnet.internal", "azurerm_subnet")];
  const sources: DependencySource[] = [
    { fromBase: "azurerm_subnet.internal", prefix: "", refs: [{ ref: "azurerm_virtual_network.main.name", inferred: true }] },
  ];
  deriveContainment(nodes, sources, ctxFor(nodes));
  assert.equal(nodes[1]!.parent_id, "azurerm_virtual_network.main");
  assert.equal(nodes[0]!.parent_id, undefined); // vnet has no parent
});

test("a NIC is contained by the subnet it references", () => {
  const nodes = [node("azurerm_subnet.internal", "azurerm_subnet"), node("azurerm_network_interface.main", "azurerm_network_interface")];
  const sources: DependencySource[] = [
    { fromBase: "azurerm_network_interface.main", prefix: "", refs: [{ ref: "azurerm_subnet.internal.id", inferred: true }] },
  ];
  deriveContainment(nodes, sources, ctxFor(nodes));
  assert.equal(nodes[1]!.parent_id, "azurerm_subnet.internal");
});

test("a VM referencing only a NIC has no subnet parent", () => {
  const nodes = [node("azurerm_network_interface.main", "azurerm_network_interface"), node("azurerm_virtual_machine.main", "azurerm_virtual_machine")];
  const sources: DependencySource[] = [
    { fromBase: "azurerm_virtual_machine.main", prefix: "", refs: [{ ref: "azurerm_network_interface.main.id", inferred: true }] },
  ];
  deriveContainment(nodes, sources, ctxFor(nodes));
  assert.equal(nodes[1]!.parent_id, undefined);
});

test("an ambiguous (count) subnet reference yields no parent", () => {
  const nodes = [node("azurerm_subnet.extra[0]", "azurerm_subnet"), node("azurerm_subnet.extra[1]", "azurerm_subnet"), node("azurerm_route_table.rt", "azurerm_route_table")];
  const sources: DependencySource[] = [
    { fromBase: "azurerm_route_table.rt", prefix: "", refs: [{ ref: "azurerm_subnet.extra", inferred: true }] },
  ];
  deriveContainment(nodes, sources, ctxFor(nodes));
  assert.equal(nodes[2]!.parent_id, undefined);
});
```

- [ ] **Step 2: Run — expect FAIL** (module not found).

Run: `pnpm --filter @groundplan/backend exec env NODE_ENV=test node --import tsx --test src/graph/containment.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement `containment.ts`.**

```ts
/**
 * Shared containment derivation (GP-42): set a single nullable `parent_id` per
 * node expressing network containment (vnet⊃subnet⊃resource). Reuses the same
 * reference resolver as the dependency-edge builder, so both producers (plan.json
 * and static HCL) get containment for free. Never guesses: a node keeps no
 * parent unless exactly one of its references resolves to a node of the expected
 * parent type. Distinct from the module `contains` edges.
 */
import {
  resolveReference,
  stripInstanceIndex,
  type DependencySource,
  type EdgeContext,
} from "./dependency-edges.js";
import type { GraphNode } from "./graph.js";

/** A containment rule: which children look for which parent type. */
type ContainmentRule = {
  /** True when this rule applies to `node`. */
  childMatches: (node: GraphNode) => boolean;
  /** The resource type a resolved reference must have to be the parent. */
  parentType: string;
};

// Data-driven, ordered; first matching rule with a unique target wins.
const RULES: ContainmentRule[] = [
  // A subnet is contained by its virtual network.
  { childMatches: (n) => n.type === "azurerm_subnet", parentType: "azurerm_virtual_network" },
  // Anything else (NIC via ip_configuration.subnet_id, AKS vnet_subnet_id,
  // bastion, app gateway, private endpoint, …) is contained by its subnet.
  {
    childMatches: (n) =>
      n.type !== "azurerm_subnet" && n.type !== "azurerm_virtual_network" && n.type !== "module",
    parentType: "azurerm_subnet",
  },
];

/** Set `parent_id` on every node with exactly one qualifying container ref. */
export function deriveContainment(
  nodes: GraphNode[],
  sources: readonly DependencySource[],
  ctx: EdgeContext,
): void {
  const typeById = new Map(nodes.map((n) => [n.id, n.type]));
  const sourceByBase = new Map(sources.map((s) => [s.fromBase, s]));

  for (const node of nodes) {
    const rule = RULES.find((r) => r.childMatches(node));
    if (!rule) continue;
    const source = sourceByBase.get(stripInstanceIndex(node.id));
    if (!source) continue;

    const targets = new Set<string>();
    for (const { ref } of source.refs) {
      for (const id of resolveReference(source.prefix, ref, ctx)) {
        if (id !== node.id && typeById.get(id) === rule.parentType) targets.add(id);
      }
    }
    if (targets.size === 1) node.parent_id = [...targets][0];
  }
}
```

- [ ] **Step 4: Run — expect PASS.**

Run: `pnpm --filter @groundplan/backend exec env NODE_ENV=test node --import tsx --test src/graph/containment.test.ts`
Expected: PASS.

### Task 42.3: Wire containment into both producers + fixtures, then commit GP-42

**Files:**
- Modify: `apps/backend/src/graph/plan-parser.ts:267-279`
- Modify: `apps/backend/src/graph/hcl-parser.ts:365-380`
- Modify: `apps/backend/src/graph/__fixtures__/graphs/plan-expressions.graph.json` (regenerate expectation)
- Create: `apps/backend/src/graph/__fixtures__/hcl-network/main.tf`
- Test: `apps/backend/src/graph/plan-parser.test.ts`, `hcl-parser.test.ts`

**Interfaces:**
- Consumes: `deriveContainment` (Task 42.2).

- [ ] **Step 1: Write the failing plan test.** In `plan-parser.test.ts`, add (the `plan-expressions` fixture already contains vnet→subnet→NIC→VM + a count subnet):

```ts
test("parsePlanToGraph derives vnet⊃subnet⊃NIC containment and escalates to v4", () => {
  const plan = readFixture("plans/plan-expressions.plan.json");
  const graph = parsePlanToGraph(plan);
  const byId = new Map(graph.nodes.map((n) => [n.id, n]));
  assert.equal(graph.version, 4);
  assert.equal(byId.get("azurerm_subnet.internal")!.parent_id, "azurerm_virtual_network.main");
  assert.equal(byId.get("azurerm_network_interface.main")!.parent_id, "azurerm_subnet.internal");
  assert.equal(byId.get("azurerm_virtual_machine.main")!.parent_id, undefined); // NIC, not subnet
  assert.equal(byId.get("azurerm_route_table.rt")!.parent_id, undefined); // ambiguous count subnet
});
```

(Use the file's existing fixture-reading helper; match its `readFixture`/import style.)

- [ ] **Step 2: Run — expect FAIL** (version 2, no parent_id).

Run: `pnpm --filter @groundplan/backend exec env NODE_ENV=test node --import tsx --test src/graph/plan-parser.test.ts`
Expected: FAIL.

- [ ] **Step 3: Wire the plan parser.** In `plan-parser.ts`, add the import beside the others:

```ts
import { deriveContainment } from "./containment.js";
```

Immediately after `dependsOnEdges` is built (after line ~265, before `const nodes = …`), insert:

```ts
  const nodesForContainment = [...nodesById.values()];
  deriveContainment(nodesForContainment, sources, {
    resourceIds,
    moduleIds,
    instancesByBase: buildInstancesByBase(resourceIds),
  });
```

(`deriveContainment` mutates the same node objects held in `nodesById`, so the later `nodes` sort sees `parent_id`.) Then change the version computation to prefer 4:

```ts
  const hasParent = withImpact.nodes.some((n) => n.parent_id !== undefined);
  const version: Graph["version"] = hasParent
    ? 4
    : withImpact.nodes.some((n) => n.attribute_diff !== undefined)
      ? 3
      : 2;
```

- [ ] **Step 4: Run the plan test — expect PASS.**

Run: `pnpm --filter @groundplan/backend exec env NODE_ENV=test node --import tsx --test src/graph/plan-parser.test.ts`
Expected: PASS.

- [ ] **Step 5: Create the HCL fixture** `__fixtures__/hcl-network/main.tf`:

```hcl
resource "azurerm_virtual_network" "main" {
  name          = "main"
  address_space = ["10.0.0.0/16"]
}

resource "azurerm_subnet" "internal" {
  name                 = "internal"
  virtual_network_name = azurerm_virtual_network.main.name
  address_prefixes     = ["10.0.1.0/24"]
}

resource "azurerm_network_interface" "main" {
  name = "main"
  ip_configuration {
    name      = "primary"
    subnet_id = azurerm_subnet.internal.id
  }
}
```

- [ ] **Step 6: Write the failing HCL test.** In `hcl-parser.test.ts`:

```ts
test("parseHclRepo derives vnet⊃subnet⊃NIC containment and escalates to v4", () => {
  const files = readTfDir("hcl-network"); // match the file's existing fixture loader
  const { graph } = parseHclRepo(files);
  const byId = new Map(graph.nodes.map((n) => [n.id, n]));
  assert.equal(graph.version, 4);
  assert.equal(byId.get("azurerm_subnet.internal")!.parent_id, "azurerm_virtual_network.main");
  assert.equal(byId.get("azurerm_network_interface.main")!.parent_id, "azurerm_subnet.internal");
});
```

If the test file has no directory loader, read the single file inline: `parseHclRepo([{ path: "main.tf", content: readFileSync(new URL("./__fixtures__/hcl-network/main.tf", import.meta.url), "utf8") }])`.

- [ ] **Step 7: Run — expect FAIL** (version 1, no parent_id).

- [ ] **Step 8: Wire the HCL parser.** In `hcl-parser.ts`, add `import { deriveContainment } from "./containment.js";`. After `dependsOnEdges` is built (after line ~365), before building `nodes`, insert:

```ts
  const nodesForContainment = [...ctx.nodes.values()];
  deriveContainment(nodesForContainment, sources, edgeCtx);
```

Change the return's version from the literal `1`:

```ts
  const version: Graph["version"] = nodesForContainment.some((n) => n.parent_id !== undefined) ? 4 : 1;
  return { graph: { version, nodes, edges }, warnings: warnings.sort(compareStrings) };
```

- [ ] **Step 9: Run the HCL test — expect PASS.** Then update any existing fixture-graph snapshots that now legitimately carry `parent_id`/`version` (e.g. `plan-expressions.graph.json`): run the full backend suite, inspect diffs, and regenerate the committed expected-graph JSON to match (these fixtures are expected outputs, so update them deliberately).

- [ ] **Step 10: Full backend suite + typecheck green.**

Run: `pnpm --filter @groundplan/backend test` then `pnpm typecheck`
Expected: PASS.

- [ ] **Step 11: Commit GP-42.**

```bash
git add apps/backend
git commit -m "$(printf 'feat(backend): network containment via parent_id in GraphSnapshot (GP-42)\n\nCo-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>')"
```

---

## Story GP-43 — NSG rules + `internet_exposed`

### Task 43.1: Types, schema, and the shared NSG compute

**Files:**
- Modify: `apps/backend/schema/graph.v1.schema.json`
- Modify: `apps/backend/src/graph/graph.ts`
- Create: `apps/backend/src/graph/nsg.ts`
- Test: `apps/backend/src/graph/nsg.test.ts`

**Interfaces:**
- Produces:
  - `type NsgRule = { name: string; priority: number; direction: string; access: string; protocol: string; ports: string; source: string; destination: string }`
  - `GraphNode.rules?: NsgRule[]`, `GraphNode.internet_exposed?: boolean`, `GraphNode.associated_ids?: string[]`
  - `computeInternetExposed(rules: NsgRule[]): boolean`
  - `normalizePorts(raw: unknown): string`

- [ ] **Step 1: Write the failing test.** Create `nsg.test.ts`:

```ts
import { test } from "node:test";
import assert from "node:assert/strict";

import { computeInternetExposed, normalizePorts } from "./nsg.js";
import type { NsgRule } from "./graph.js";

function rule(p: Partial<NsgRule>): NsgRule {
  return { name: "r", priority: 100, direction: "Inbound", access: "Allow", protocol: "Tcp", ports: "*", source: "*", destination: "*", ...p };
}

test("internet_exposed is true for an inbound Allow from an internet source", () => {
  for (const source of ["*", "0.0.0.0/0", "Internet", "internet"]) {
    assert.equal(computeInternetExposed([rule({ source })]), true, source);
  }
});

test("internet_exposed is false for specific CIDR / outbound / deny", () => {
  assert.equal(computeInternetExposed([rule({ source: "10.0.0.0/8" })]), false);
  assert.equal(computeInternetExposed([rule({ source: "*", direction: "Outbound" })]), false);
  assert.equal(computeInternetExposed([rule({ source: "*", access: "Deny" })]), false);
  assert.equal(computeInternetExposed([]), false);
});

test("normalizePorts renders single, range, and any", () => {
  assert.equal(normalizePorts("80"), "80");
  assert.equal(normalizePorts("80-443"), "80-443");
  assert.equal(normalizePorts("*"), "*");
  assert.equal(normalizePorts(443), "443");
});
```

- [ ] **Step 2: Run — expect FAIL.**

Run: `pnpm --filter @groundplan/backend exec env NODE_ENV=test node --import tsx --test src/graph/nsg.test.ts`
Expected: FAIL.

- [ ] **Step 3: Add types to `graph.ts`.** After the `GraphNode` type (or near `AttributeDiffRow` import), add:

```ts
/** v4: one NSG security rule, values raw as written; ports normalized (GP-43). */
export type NsgRule = {
  name: string;
  priority: number;
  direction: string; // Inbound | Outbound (raw)
  access: string; // Allow | Deny (raw)
  protocol: string; // raw
  ports: string; // "80" | "80-443" | "*"
  source: string; // raw source address prefix
  destination: string; // raw destination address prefix
};
```

Add to `GraphNode` (after `parent_id?`):

```ts
  /** v4: security rules on an azurerm_network_security_group node (GP-43). */
  rules?: NsgRule[];
  /** v4: true iff an NSG has an inbound Allow rule from an internet source. */
  internet_exposed?: boolean;
  /** v4: node ids of subnets/NICs this NSG is associated with (GP-43/45). */
  associated_ids?: string[];
```

- [ ] **Step 4: Extend the schema.** In `definitions.node.properties` (after `parent_id`), add:

```json
"rules": {
  "type": "array",
  "description": "v4: NSG security rules (GP-43).",
  "items": {
    "type": "object",
    "required": ["name", "priority", "direction", "access", "protocol", "ports", "source", "destination"],
    "additionalProperties": false,
    "properties": {
      "name": { "type": "string" },
      "priority": { "type": "integer" },
      "direction": { "type": "string" },
      "access": { "type": "string" },
      "protocol": { "type": "string" },
      "ports": { "type": "string" },
      "source": { "type": "string" },
      "destination": { "type": "string" }
    }
  }
},
"internet_exposed": { "type": "boolean", "description": "v4: NSG has an inbound Allow from an internet source (GP-43)." },
"associated_ids": { "type": "array", "items": { "type": "string" }, "description": "v4: subnet/NIC node ids this NSG is attached to (GP-43)." }
```

- [ ] **Step 5: Implement `nsg.ts`.**

```ts
/**
 * NSG payload derivation (GP-43): the security-group rules, the computed
 * `internet_exposed` flag, and the subnet/NIC associations. Extraction differs by
 * producer (structured plan `after` vs. HCL text), but the flag, port
 * normalization, and attach step are shared here so both producers agree.
 */
import type { GraphNode, NsgRule } from "./graph.js";

const INTERNET_SOURCES = new Set(["*", "0.0.0.0/0", "internet"]);

/** Whole heuristic: any inbound Allow from an internet source ⇒ exposed. */
export function computeInternetExposed(rules: readonly NsgRule[]): boolean {
  return rules.some(
    (r) =>
      r.direction.toLowerCase() === "inbound" &&
      r.access.toLowerCase() === "allow" &&
      INTERNET_SOURCES.has(r.source.trim().toLowerCase()),
  );
}

/** Normalize a port range value to "80", "80-443", or "*". Passthrough. */
export function normalizePorts(raw: unknown): string {
  if (raw === undefined || raw === null) return "*";
  return String(raw).trim() || "*";
}

/** Per-NSG extracted data keyed by NSG node id (from a producer). */
export type ExtractedNsg = { rules: NsgRule[]; associatedIds: string[] };

/**
 * Attach `rules`, `internet_exposed`, `associated_ids` to the matching NSG nodes.
 * Rules are sorted by priority for stable output. Mutates nodes in place.
 */
export function attachNsg(nodes: GraphNode[], extracted: Map<string, ExtractedNsg>): void {
  const byId = new Map(nodes.map((n) => [n.id, n]));
  for (const [nsgId, data] of extracted) {
    const node = byId.get(nsgId);
    if (!node) continue;
    const rules = [...data.rules].sort((a, b) => a.priority - b.priority || a.name.localeCompare(b.name));
    node.rules = rules;
    node.internet_exposed = computeInternetExposed(rules);
    if (data.associatedIds.length > 0) {
      node.associated_ids = [...new Set(data.associatedIds)].sort();
    }
  }
}
```

- [ ] **Step 6: Run — expect PASS.**

Run: `pnpm --filter @groundplan/backend exec env NODE_ENV=test node --import tsx --test src/graph/nsg.test.ts`
Expected: PASS.

### Task 43.2: Plan-parser NSG extraction

**Files:**
- Modify: `apps/backend/src/graph/plan-parser.ts`
- Create: `apps/backend/src/graph/__fixtures__/plans/nsg.plan.json`
- Test: `apps/backend/src/graph/plan-parser.test.ts`

**Interfaces:**
- Consumes: `attachNsg`, `normalizePorts`, `type ExtractedNsg` (Task 43.1); `resolveReference` for associations.

- [ ] **Step 1: Create the fixture** `__fixtures__/plans/nsg.plan.json` — a subnet, an NSG with one internet-open inbound Allow rule + one closed rule, a second closed NSG, and a subnet↔NSG association. Rule values live in `change.after.security_rule`; the association references live in `configuration`:

```json
{
  "format_version": "1.2",
  "terraform_version": "1.9.0",
  "resource_changes": [
    { "address": "azurerm_subnet.web", "mode": "managed", "type": "azurerm_subnet", "name": "web", "provider_name": "registry.terraform.io/hashicorp/azurerm", "change": { "actions": ["create"] } },
    { "address": "azurerm_network_security_group.open", "mode": "managed", "type": "azurerm_network_security_group", "name": "open", "provider_name": "registry.terraform.io/hashicorp/azurerm",
      "change": { "actions": ["create"], "after": { "security_rule": [
        { "name": "allow-https", "priority": 100, "direction": "Inbound", "access": "Allow", "protocol": "Tcp", "destination_port_range": "443", "source_address_prefix": "Internet", "destination_address_prefix": "*" },
        { "name": "allow-internal", "priority": 200, "direction": "Inbound", "access": "Allow", "protocol": "Tcp", "destination_port_range": "22", "source_address_prefix": "10.0.0.0/8", "destination_address_prefix": "*" }
      ] } } },
    { "address": "azurerm_network_security_group.closed", "mode": "managed", "type": "azurerm_network_security_group", "name": "closed", "provider_name": "registry.terraform.io/hashicorp/azurerm",
      "change": { "actions": ["create"], "after": { "security_rule": [
        { "name": "deny-all", "priority": 4096, "direction": "Inbound", "access": "Deny", "protocol": "*", "destination_port_range": "*", "source_address_prefix": "*", "destination_address_prefix": "*" }
      ] } } },
    { "address": "azurerm_subnet_network_security_group_association.web", "mode": "managed", "type": "azurerm_subnet_network_security_group_association", "name": "web", "provider_name": "registry.terraform.io/hashicorp/azurerm", "change": { "actions": ["create"] } }
  ],
  "configuration": {
    "root_module": {
      "resources": [
        { "address": "azurerm_subnet_network_security_group_association.web", "mode": "managed", "type": "azurerm_subnet_network_security_group_association", "name": "web",
          "expressions": {
            "subnet_id": { "references": ["azurerm_subnet.web.id", "azurerm_subnet.web"] },
            "network_security_group_id": { "references": ["azurerm_network_security_group.open.id", "azurerm_network_security_group.open"] }
          } }
      ]
    }
  }
}
```

- [ ] **Step 2: Write the failing test.** In `plan-parser.test.ts`:

```ts
test("parsePlanToGraph attaches NSG rules, internet_exposed, and associations", () => {
  const graph = parsePlanToGraph(readFixture("plans/nsg.plan.json"));
  const byId = new Map(graph.nodes.map((n) => [n.id, n]));
  const open = byId.get("azurerm_network_security_group.open")!;
  assert.equal(open.rules?.length, 2);
  assert.deepEqual(open.rules?.[0], { name: "allow-https", priority: 100, direction: "Inbound", access: "Allow", protocol: "Tcp", ports: "443", source: "Internet", destination: "*" });
  assert.equal(open.internet_exposed, true);
  assert.deepEqual(open.associated_ids, ["azurerm_subnet.web"]);
  assert.equal(byId.get("azurerm_network_security_group.closed")!.internet_exposed, false);
});
```

- [ ] **Step 3: Run — expect FAIL.**

- [ ] **Step 4: Implement plan extraction.** In `plan-parser.ts` add imports:

```ts
import { attachNsg, normalizePorts, type ExtractedNsg } from "./nsg.js";
```

Add a helper near the top-level helpers:

```ts
/** Map a plan `after.security_rule[]` entry to an NsgRule (raw values). */
function planRule(raw: unknown): import("./nsg.js").NsgRule | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.name !== "string") return null;
  const ports = r.destination_port_range ?? (Array.isArray(r.destination_port_ranges) ? (r.destination_port_ranges as unknown[]).join(",") : "*");
  return {
    name: r.name,
    priority: typeof r.priority === "number" ? r.priority : Number(r.priority) || 0,
    direction: asString(r.direction),
    access: asString(r.access),
    protocol: asString(r.protocol),
    ports: normalizePorts(ports),
    source: asString(r.source_address_prefix) || (Array.isArray(r.source_address_prefixes) ? (r.source_address_prefixes as unknown[]).join(",") : "*"),
    destination: asString(r.destination_address_prefix) || "*",
  };
}
```

(Import `NsgRule` as a type at the top instead of the inline `import(...)` if the file style prefers; either compiles.)

After nodes/edges are built and `deriveContainment` runs, build the NSG map and attach. Collect inline rules while iterating `resource_changes` (add a second pass over `changes` before the final sort), and associations from `sources`:

```ts
  const extractedNsg = new Map<string, ExtractedNsg>();
  const nsgOf = (id: string): ExtractedNsg => {
    let e = extractedNsg.get(id);
    if (!e) { e = { rules: [], associatedIds: [] }; extractedNsg.set(id, e); }
    return e;
  };
  for (const raw of changes) {
    const rc = raw as ResourceChange;
    const id = asString(rc.address);
    if (rc.type === "azurerm_network_security_group") {
      const after = (rc.change?.after ?? {}) as Record<string, unknown>;
      const inline = Array.isArray(after.security_rule) ? after.security_rule : [];
      for (const r of inline) { const nr = planRule(r); if (nr) nsgOf(id).rules.push(nr); }
    }
  }
  // Associations: an association resource references both a subnet/NIC and an NSG.
  const edgeCtx = { resourceIds, moduleIds, instancesByBase: buildInstancesByBase(resourceIds) };
  for (const source of sources) {
    if (!source.fromBase.includes("_security_group_association")) continue;
    const resolved = source.refs.flatMap((r) => resolveReference(source.prefix, r.ref, edgeCtx));
    const nsgId = resolved.find((rid) => nodesById.get(rid)?.type === "azurerm_network_security_group");
    const targetId = resolved.find((rid) => { const t = nodesById.get(rid)?.type; return t === "azurerm_subnet" || t === "azurerm_network_interface"; });
    if (nsgId && targetId) nsgOf(nsgId).associatedIds.push(targetId);
  }
  attachNsg([...nodesById.values()], extractedNsg);
```

Add `resolveReference` to the existing `./dependency-edges.js` import. Then escalate version to 4 when NSG data exists too:

```ts
  const hasNsg = withImpact.nodes.some((n) => n.rules !== undefined || n.internet_exposed !== undefined);
  const hasParent = withImpact.nodes.some((n) => n.parent_id !== undefined);
  const version: Graph["version"] = hasParent || hasNsg ? 4 : withImpact.nodes.some((n) => n.attribute_diff !== undefined) ? 3 : 2;
```

- [ ] **Step 5: Run — expect PASS.**

Run: `pnpm --filter @groundplan/backend exec env NODE_ENV=test node --import tsx --test src/graph/plan-parser.test.ts`
Expected: PASS.

### Task 43.3: HCL-parser NSG extraction, then commit GP-43

**Files:**
- Modify: `apps/backend/src/graph/hcl-parser.ts`
- Create: `apps/backend/src/graph/__fixtures__/hcl-nsg/main.tf`
- Test: `apps/backend/src/graph/hcl-parser.test.ts`

- [ ] **Step 1: Create the fixture** `__fixtures__/hcl-nsg/main.tf`:

```hcl
resource "azurerm_subnet" "web" {
  name                 = "web"
  virtual_network_name = azurerm_virtual_network.main.name
}

resource "azurerm_virtual_network" "main" { name = "main" }

resource "azurerm_network_security_group" "open" {
  name = "open"
  security_rule {
    name                       = "allow-https"
    priority                   = 100
    direction                  = "Inbound"
    access                     = "Allow"
    protocol                   = "Tcp"
    destination_port_range     = "443"
    source_address_prefix      = "Internet"
    destination_address_prefix = "*"
  }
}

resource "azurerm_subnet_network_security_group_association" "web" {
  subnet_id                 = azurerm_subnet.web.id
  network_security_group_id = azurerm_network_security_group.open.id
}
```

- [ ] **Step 2: Write the failing test.** In `hcl-parser.test.ts`:

```ts
test("parseHclRepo attaches NSG rules, internet_exposed, associations", () => {
  const { graph } = parseHclRepo(readTfDir("hcl-nsg"));
  const byId = new Map(graph.nodes.map((n) => [n.id, n]));
  const open = byId.get("azurerm_network_security_group.open")!;
  assert.equal(open.rules?.length, 1);
  assert.equal(open.rules?.[0]?.ports, "443");
  assert.equal(open.internet_exposed, true);
  assert.deepEqual(open.associated_ids, ["azurerm_subnet.web"]);
});
```

- [ ] **Step 3: Run — expect FAIL.**

- [ ] **Step 4: Implement HCL extraction.** In `hcl-parser.ts` add `import { attachNsg, normalizePorts, type ExtractedNsg } from "./nsg.js";` and `import type { NsgRule } from "./graph.js";`. Add helpers (reuse `scanTopLevelBlocks` on the NSG body to find nested `security_rule` blocks; a small attribute reader for the flat `key = "value"` / `key = 123` pairs inside a rule body):

```ts
/** Read a scalar attribute (`key = "v"` or `key = 123`) from a block body. */
function readAttr(body: string, key: string): string | undefined {
  const m = new RegExp(`(^|\\n)\\s*${key}\\s*=\\s*("([^"]*)"|[0-9]+)`).exec(body);
  if (!m) return undefined;
  return m[3] !== undefined ? m[3] : (m[2] as string);
}

function hclRule(body: string): NsgRule | null {
  const name = readAttr(body, "name");
  if (!name) return null;
  return {
    name,
    priority: Number(readAttr(body, "priority") ?? 0),
    direction: readAttr(body, "direction") ?? "",
    access: readAttr(body, "access") ?? "",
    protocol: readAttr(body, "protocol") ?? "",
    ports: normalizePorts(readAttr(body, "destination_port_range")),
    source: readAttr(body, "source_address_prefix") ?? "*",
    destination: readAttr(body, "destination_address_prefix") ?? "*",
  };
}
```

While parsing resource blocks in `parseModuleDir` (where `block.type === "resource"`), when `type === "azurerm_network_security_group"`, scan its body for nested `security_rule` blocks and stash the rules keyed by the node id; when `type` ends in `_security_group_association`, record its body for later reference resolution. The simplest wiring: collect these in the `ctx` (add `nsgRules: Map<string, NsgRule[]>` and reuse `pendingSources` for associations, since association bodies already push a `pendingSource` with their refs). Then after `dependsOnEdges`:

```ts
  const extractedNsg = new Map<string, ExtractedNsg>();
  const nsgOf = (id: string): ExtractedNsg => { let e = extractedNsg.get(id); if (!e) { e = { rules: [], associatedIds: [] }; extractedNsg.set(id, e); } return e; };
  for (const [id, rules] of ctx.nsgRules) nsgOf(id).rules.push(...rules);
  for (const ps of ctx.pendingSources) {
    if (!ps.fromBase.includes("_security_group_association")) continue;
    const resolved = extractReferences(ps.body).flatMap((ref) => resolveReference(ps.prefix, ref, edgeCtx));
    const nsgId = resolved.find((rid) => ctx.nodes.get(rid)?.type === "azurerm_network_security_group");
    const targetId = resolved.find((rid) => { const t = ctx.nodes.get(rid)?.type; return t === "azurerm_subnet" || t === "azurerm_network_interface"; });
    if (nsgId && targetId) nsgOf(nsgId).associatedIds.push(targetId);
  }
  attachNsg([...ctx.nodes.values()], extractedNsg);
```

Add `resolveReference` to the existing `./dependency-edges.js` import; add `nsgRules: new Map()` to the `ctx` initializer and `nsgRules: Map<string, NsgRule[]>` to the `Ctx` type. Populate `ctx.nsgRules` inside the resource branch:

```ts
        if (type === "azurerm_network_security_group") {
          const rules = scanTopLevelBlocks(block.body).filter((b) => b.type === "security_rule").map((b) => hclRule(b.body)).filter((r): r is NsgRule => r !== null);
          if (rules.length > 0) ctx.nsgRules.set(id, rules);
        }
```

Escalate version to 4 when NSG data exists:

```ts
  const hasV4 = nodesForContainment.some((n) => n.parent_id !== undefined || n.rules !== undefined || n.internet_exposed !== undefined);
  const version: Graph["version"] = hasV4 ? 4 : 1;
```

- [ ] **Step 5: Run — expect PASS.**

Run: `pnpm --filter @groundplan/backend exec env NODE_ENV=test node --import tsx --test src/graph/hcl-parser.test.ts`
Expected: PASS.

- [ ] **Step 6: Full backend suite + typecheck; update any affected expected-graph fixtures deliberately.**

Run: `pnpm --filter @groundplan/backend test` then `pnpm typecheck`
Expected: PASS.

- [ ] **Step 7: Commit GP-43.**

```bash
git add apps/backend
git commit -m "$(printf 'feat(backend): NSG rules + internet_exposed node payload (GP-43)\n\nCo-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>')"
```

---

## Story GP-44 — Network view + view switcher (frontend)

### Task 44.1: Frontend types + `networkProjection` + container generalization

**Files:**
- Modify: `apps/frontend/src/api/types.ts:78-107`
- Modify: `apps/frontend/src/lib/graph-layout.ts`
- Test: `apps/frontend/src/lib/graph-layout.test.ts`

**Interfaces:**
- Produces: `networkProjection(graph: Graph): { graph: Graph; hiddenCount: number }`.

- [ ] **Step 1: Update the frontend type mirror.** In `types.ts`, add to `GraphNode` (after `attribute_diff_truncated?`): `parent_id?: string;` and change `Graph.version` to `1 | 2 | 3 | 4;`.

- [ ] **Step 2: Write the failing test.** In `graph-layout.test.ts`:

```ts
import { networkProjection } from "@/lib/graph-layout";

const netGraph = {
  version: 4 as const,
  nodes: [
    { id: "vn", name: "vn", type: "azurerm_virtual_network", provider: "azurerm", module_path: [], change: null },
    { id: "sn", name: "sn", type: "azurerm_subnet", provider: "azurerm", module_path: [], change: null, parent_id: "vn" },
    { id: "nic", name: "nic", type: "azurerm_network_interface", provider: "azurerm", module_path: [], change: null, parent_id: "sn" },
    { id: "db", name: "db", type: "azurerm_mssql_server", provider: "azurerm", module_path: [], change: null },
  ],
  edges: [{ from: "vn", to: "sn", kind: "contains" as const }],
};

test("networkProjection keeps the containment chain, drops the rest, counts hidden", () => {
  const { graph, hiddenCount } = networkProjection(netGraph);
  const ids = graph.nodes.map((n) => n.id).sort();
  assert.deepEqual(ids, ["nic", "sn", "vn"]);
  assert.equal(hiddenCount, 1); // db
  // containment re-expressed as contains edges for the layout
  assert.ok(graph.edges.some((e) => e.kind === "contains" && e.from === "vn" && e.to === "sn"));
  assert.ok(graph.edges.some((e) => e.kind === "contains" && e.from === "sn" && e.to === "nic"));
});
```

- [ ] **Step 3: Run — expect FAIL.**

Run: `pnpm --filter @groundplan/frontend exec vitest run src/lib/graph-layout.test.ts`
Expected: FAIL.

- [ ] **Step 4: Implement `networkProjection`** in `graph-layout.ts` (after `categoryOptions`):

```ts
/**
 * Project a snapshot to the network view (GP-44): keep nodes in a `parent_id`
 * containment chain, nodes of category "network", and NSGs associated with a kept
 * node (so their rules stay inspectable). Re-express containment as `contains`
 * edges so the existing subflow layout nests vnet⊃subnet⊃resource. Everything else
 * is dropped; the count of dropped resource nodes is returned for the chip.
 */
export function networkProjection(graph: Graph): { graph: Graph; hiddenCount: number } {
  const byId = new Map(graph.nodes.map((n) => [n.id, n]));
  const keep = new Set<string>();
  for (const n of graph.nodes) {
    if (isModule(n)) continue;
    if (n.parent_id || categorize(n.type) === "network") keep.add(n.id);
  }
  // A parent referenced by a kept child is itself kept.
  for (const n of graph.nodes) if (n.parent_id && keep.has(n.id)) keep.add(n.parent_id);
  // NSGs associated with a kept node.
  for (const n of graph.nodes) {
    if (n.associated_ids?.some((id) => keep.has(id))) keep.add(n.id);
  }

  const nodes = graph.nodes.filter((n) => keep.has(n.id));
  const containsEdges = nodes
    .filter((n) => n.parent_id && keep.has(n.parent_id))
    .map((n) => ({ from: n.parent_id!, to: n.id, kind: "contains" as const }));
  const dependsOn = graph.edges.filter(
    (e) => e.kind === "depends_on" && keep.has(e.from) && keep.has(e.to),
  );

  const hiddenCount = graph.nodes.filter((n) => !isModule(n) && !keep.has(n.id)).length;
  return { graph: { version: graph.version, nodes, edges: [...containsEdges, ...dependsOn] }, hiddenCount };
}
```

- [ ] **Step 5: Generalize container detection in `toElkGraph`.** After building `parentOf` (line ~171), add `const parents = new Set(parentOf.values());`. Change the elk-node creation (line ~176-180) so any parent becomes a container:

```ts
  for (const node of graph.nodes) {
    const isContainer = isModule(node) || parents.has(node.id);
    elkById.set(
      node.id,
      isContainer
        ? { id: node.id, layoutOptions: ELK_MODULE_OPTIONS, children: [] }
        : { id: node.id, width: RESOURCE_WIDTH, height: RESOURCE_HEIGHT },
    );
  }
```

- [ ] **Step 6: Choose the container component type in `elkToFlow`.** At line ~260-263, change:

```ts
      const container = Boolean(elk.children && elk.children.length > 0);
      const nodeType = container ? (isModule(graphNode) ? "module" : "container") : "resource";
      nodes.push({
        id: elk.id,
        type: nodeType,
```

- [ ] **Step 7: Run — expect PASS** (and confirm existing layout tests still pass — infra view is unchanged because only modules are parents there).

Run: `pnpm --filter @groundplan/frontend exec vitest run src/lib/graph-layout.test.ts`
Expected: PASS.

### Task 44.2: `NetworkContainerNode` + register `container` type

**Files:**
- Create: `apps/frontend/src/components/network-container-node.tsx`
- Modify: `apps/frontend/src/components/graph-canvas.tsx:57`
- Test: `apps/frontend/src/components/network-container-node.test.tsx`

- [ ] **Step 1: Write the failing test.** Create `network-container-node.test.tsx`:

```tsx
import { render, screen } from "@testing-library/react";
import { describe, expect, test } from "vitest";
import { NetworkContainerNode } from "@/components/network-container-node";

const data = { graphNode: { id: "sn", name: "internal", type: "azurerm_subnet", provider: "azurerm", module_path: [], change: null }, dimmed: false } as never;

describe("NetworkContainerNode", () => {
  test("labels the container with the resource identity", () => {
    render(<NetworkContainerNode data={data} id="sn" type="container" selected={false} zIndex={0} isConnectable={false} xPos={0} yPos={0} dragging={false} />);
    expect(screen.getByText("internal")).toBeInTheDocument();
  });
});
```

(If `NodeProps` requires different props in this React Flow version, match the shape used by `graph-node.test.tsx`.)

- [ ] **Step 2: Run — expect FAIL.**

- [ ] **Step 3: Implement `network-container-node.tsx`** (mirrors `ModuleNode` but shows the resource's icon + name, and reads `exposed` in GP-45):

```tsx
import { memo } from "react";
import { type Node as FlowNode, type NodeProps } from "@xyflow/react";

import { ResourceIcon } from "@/components/resource-icon";
import { categorize, CATEGORY_META, shortType } from "@/lib/resource-category";
import type { GraphNodeData } from "@/lib/graph-layout";
import { cn } from "@/lib/utils";

/** A resource-backed container (vnet / subnet) for the network view (GP-44). */
export const NetworkContainerNode = memo(function NetworkContainerNode({
  data,
}: NodeProps<FlowNode<GraphNodeData>>) {
  const { graphNode } = data;
  const iconClass = CATEGORY_META[categorize(graphNode.type)].className;
  return (
    <div
      className={cn(
        "border-border-strong bg-accent-soft/20 relative h-full w-full rounded-lg border border-dashed transition-opacity",
        data.dimmed && "opacity-40",
      )}
    >
      <span className="bg-canvas absolute -top-2.5 left-3 inline-flex items-center gap-1 px-1.5 font-mono text-[10px] font-medium tracking-wide">
        <ResourceIcon type={graphNode.type} className={cn("size-3", iconClass)} />
        <span className="text-muted-foreground">{shortType(graphNode.type)}</span>
        <span className="text-ink">{graphNode.name}</span>
      </span>
    </div>
  );
});
```

- [ ] **Step 4: Register the type.** In `graph-canvas.tsx`, import `NetworkContainerNode` and change line 57:

```ts
const NODE_TYPES = { resource: ResourceFlowNode, module: ModuleNode, container: NetworkContainerNode };
```

- [ ] **Step 5: Run — expect PASS.**

Run: `pnpm --filter @groundplan/frontend exec vitest run src/components/network-container-node.test.tsx`
Expected: PASS.

### Task 44.3: View switcher + page wiring + hidden-count chip, then commit GP-44

**Files:**
- Create: `apps/frontend/src/components/view-switcher.tsx`
- Modify: `apps/frontend/src/pages/pull-detail-page.tsx`, `apps/frontend/src/pages/docs-page.tsx`
- Test: `apps/frontend/src/components/view-switcher.test.tsx`

**Interfaces:**
- Produces: `type GraphView = "infra" | "network"`; `useGraphView(): { view: GraphView; setView(v: GraphView): void }`; `<ViewSwitcher />`.

- [ ] **Step 1: Write the failing test.** Create `view-switcher.test.tsx`:

```tsx
import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import userEvent from "@testing-library/user-event";
import { describe, expect, test } from "vitest";
import { ViewSwitcher } from "@/components/view-switcher";

describe("ViewSwitcher", () => {
  test("reflects the ?view param and switches", async () => {
    render(<MemoryRouter initialEntries={["/x?view=network"]}><ViewSwitcher /></MemoryRouter>);
    const network = screen.getByRole("button", { name: /network/i });
    expect(network).toHaveAttribute("aria-pressed", "true");
    await userEvent.click(screen.getByRole("button", { name: /plan|infra/i }));
    expect(screen.getByRole("button", { name: /plan|infra/i })).toHaveAttribute("aria-pressed", "true");
  });
});
```

- [ ] **Step 2: Run — expect FAIL.**

- [ ] **Step 3: Implement `view-switcher.tsx`** (URL param following the `?compare` pattern in `docs-page.tsx`):

```tsx
import { useSearchParams } from "react-router-dom";
import { cn } from "@/lib/utils";

export type GraphView = "infra" | "network";

/** Read/write the `?view` param (default "infra"). */
export function useGraphView(): { view: GraphView; setView: (v: GraphView) => void } {
  const [params, setParams] = useSearchParams();
  const view: GraphView = params.get("view") === "network" ? "network" : "infra";
  const setView = (v: GraphView) => {
    const next = new URLSearchParams(params);
    if (v === "network") next.set("view", "network");
    else next.delete("view");
    setParams(next, { replace: true });
  };
  return { view, setView };
}

const OPTIONS: { key: GraphView; label: string }[] = [
  { key: "infra", label: "Plan impact" },
  { key: "network", label: "Network" },
];

/** Segmented Plan-impact ⇄ Network switcher (GP-44). */
export function ViewSwitcher() {
  const { view, setView } = useGraphView();
  return (
    <div className="border-border inline-flex rounded-md border p-0.5" role="group" aria-label="Graph view">
      {OPTIONS.map((o) => (
        <button
          key={o.key}
          type="button"
          aria-pressed={view === o.key}
          onClick={() => setView(o.key)}
          className={cn(
            "rounded px-2.5 py-1 font-mono text-[11px] transition-colors",
            view === o.key ? "bg-accent text-ink" : "text-muted-foreground hover:text-ink",
          )}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}
```

- [ ] **Step 4: Run — expect PASS.**

Run: `pnpm --filter @groundplan/frontend exec vitest run src/components/view-switcher.test.tsx`
Expected: PASS.

- [ ] **Step 5: Wire `pull-detail-page.tsx`.** Import `ViewSwitcher, useGraphView` and `networkProjection`. Where the graph is rendered (~line 188), compute the displayed graph:

```tsx
const { view } = useGraphView();
const projected = useMemo(
  () => (view === "network" ? networkProjection(graph.snapshot.graph) : { graph: graph.snapshot.graph, hiddenCount: 0 }),
  [view, graph],
);
```

Render `<ViewSwitcher />` in the header slot (beside the snapshot `<select>` / export menu) and, when `view === "network" && projected.hiddenCount > 0`, a chip:

```tsx
{view === "network" && projected.hiddenCount > 0 && (
  <span className="text-muted-foreground bg-muted rounded-full px-2 py-0.5 font-mono text-[11px]">
    {projected.hiddenCount} resource{projected.hiddenCount === 1 ? "" : "s"} not in network view
  </span>
)}
```

Change the canvas to `<GraphCanvas graph={projected.graph} variant="plan" />`. (Adjust `graph.snapshot.graph` to match the page's actual variable for the current snapshot's graph.)

- [ ] **Step 6: Wire `docs-page.tsx`** identically: `ViewSwitcher` + `useGraphView` + `networkProjection(current.graph)`; render the chip; pass the projected graph to `<GraphCanvas … variant="docs" />`. Keep the existing `?compare` logic untouched (both params coexist).

- [ ] **Step 7: Full frontend suite + typecheck.**

Run: `pnpm --filter @groundplan/frontend test` then `pnpm typecheck`
Expected: PASS. (If the existing `graph-canvas.test.tsx` mock lists node types, ensure it still passes; it renders nodes generically so `container` needs no mock change.)

- [ ] **Step 8: Commit GP-44.**

```bash
git add apps/frontend
git commit -m "$(printf 'feat(frontend): network view + plan-impact \342\207\204 network switcher (GP-44)\n\nCo-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>')"
```

---

## Story GP-45 — Exposure highlighting & rule inspection (frontend)

### Task 45.1: Types, `exposed` token + status metadata, `exposedNodeIds`, node treatment

**Files:**
- Modify: `apps/frontend/src/api/types.ts`
- Modify: `apps/frontend/src/index.css`
- Modify: `apps/frontend/src/lib/status.ts`
- Modify: `apps/frontend/src/lib/graph-layout.ts`
- Modify: `apps/frontend/src/components/graph-node.tsx`, `network-container-node.tsx`
- Test: `apps/frontend/src/lib/graph-layout.test.ts`, `apps/frontend/src/components/graph-node.test.tsx`

**Interfaces:**
- Produces: `NsgRule` + `rules?`/`internet_exposed?`/`associated_ids?` on the FE `GraphNode`; `exposedNodeIds(graph: Graph): Set<string>`; `GraphNodeData.exposed?: boolean`.

- [ ] **Step 1: Update the FE type mirror.** In `types.ts` add near `AttributeDiffRow`:

```ts
/** v4: one NSG security rule (GP-43). */
export interface NsgRule {
  name: string; priority: number; direction: string; access: string;
  protocol: string; ports: string; source: string; destination: string;
}
```

Add to `GraphNode`: `rules?: NsgRule[];`, `internet_exposed?: boolean;`, `associated_ids?: string[];`.

- [ ] **Step 2: Add the `exposed` token.** In `index.css`, in the `:root` var block (near `--impacted`), add `--exposed: #d4531e;` and `--exposed-soft: #fdece3;`. In the `@theme` block (near `--color-impacted`), add `--color-exposed: var(--exposed);` and `--color-exposed-soft: var(--exposed-soft);`. This generates `text-exposed`, `bg-exposed`, `bg-exposed-soft`, `ring-exposed`, `border-exposed`.

- [ ] **Step 3: Add `exposed` status metadata.** In `status.ts`, extend `StatusKind` to `… | "impacted" | "exposed"` and add to `STATUS_META`:

```ts
  exposed: {
    label: "Internet-exposed",
    glyph: "⚠", // ⚠
    text: "text-exposed",
    bg: "bg-exposed",
    soft: "bg-exposed-soft",
    border: "border-exposed",
  },
```

(`statusOf` is unchanged — `exposed` is not a plan change.)

- [ ] **Step 4: Write the failing helper test.** In `graph-layout.test.ts`:

```ts
import { exposedNodeIds } from "@/lib/graph-layout";

test("exposedNodeIds returns the NSG and its associated targets", () => {
  const g = { version: 4 as const, edges: [], nodes: [
    { id: "nsg", name: "nsg", type: "azurerm_network_security_group", provider: "azurerm", module_path: [], change: null, internet_exposed: true, associated_ids: ["sn"] },
    { id: "sn", name: "sn", type: "azurerm_subnet", provider: "azurerm", module_path: [], change: null },
    { id: "nsg2", name: "nsg2", type: "azurerm_network_security_group", provider: "azurerm", module_path: [], change: null, internet_exposed: false, associated_ids: ["sn2"] },
  ] };
  const ids = exposedNodeIds(g);
  assert.ok(ids.has("nsg") && ids.has("sn"));
  assert.ok(!ids.has("nsg2") && !ids.has("sn2"));
});
```

- [ ] **Step 5: Run — expect FAIL.**

- [ ] **Step 6: Implement `exposedNodeIds`** in `graph-layout.ts`:

```ts
/** Ids to render as internet-exposed: each exposed NSG + its associated targets. */
export function exposedNodeIds(graph: Graph): Set<string> {
  const ids = new Set<string>();
  for (const n of graph.nodes) {
    if (n.internet_exposed) {
      ids.add(n.id);
      for (const id of n.associated_ids ?? []) ids.add(id);
    }
  }
  return ids;
}
```

Add `exposed?: boolean;` to `GraphNodeData`. In `elkToFlow`, compute the set once (near `byId`): `const exposed = exposedNodeIds(graph);` and add `exposed: exposed.has(graphNode.id),` to the node `data` object.

- [ ] **Step 7: Write the failing node test.** In `graph-node.test.tsx`:

```tsx
test("an exposed node shows the exposure badge", () => {
  render(<NodeCard graphNode={{ id: "nsg", name: "open", type: "azurerm_network_security_group", provider: "azurerm", module_path: [], change: null }} exposed />);
  expect(screen.getByLabelText(/internet-exposed/i)).toBeInTheDocument();
});
```

- [ ] **Step 8: Run — expect FAIL.**

- [ ] **Step 9: Render the treatment in `NodeCard`.** Add `exposed = false` to its props (and to the destructured prop type). Add `exposed && "ring-exposed ring-2 ring-offset-1 ring-offset-background"` to the outer `cn(...)`. After the status/impacted badge block, add:

```tsx
      {exposed && (
        <span
          aria-label="Internet-exposed"
          title="Internet-exposed"
          className="bg-exposed text-canvas absolute -top-2 -left-2 inline-flex size-4 items-center justify-center rounded-full text-[10px]"
        >
          {STATUS_META.exposed.glyph}
        </span>
      )}
```

(Import `STATUS_META` — already imported.) Thread it through `ResourceFlowNode`: add `exposed={data.exposed === true}` to the `<NodeCard>` call. Do the same ring on `NetworkContainerNode` (add `data.exposed && "ring-exposed ring-2"` to its outer `cn`).

- [ ] **Step 10: Run both tests — expect PASS.**

Run: `pnpm --filter @groundplan/frontend exec vitest run src/lib/graph-layout.test.ts src/components/graph-node.test.tsx`
Expected: PASS.

### Task 45.2: Security-rules side-panel section, then commit GP-45

**Files:**
- Modify: `apps/frontend/src/lib/node-details.ts`
- Modify: `apps/frontend/src/components/node-details-panel.tsx`
- Test: `apps/frontend/src/components/node-details-panel.test.tsx`

**Interfaces:**
- Produces: `sortedRules(node: GraphNode): { rule: NsgRule; internet: boolean }[]`.

- [ ] **Step 1: Write the failing test.** In `node-details-panel.test.tsx`:

```tsx
test("renders a Security rules section for an NSG, flagging internet rows", () => {
  const nsg = { id: "nsg", name: "open", type: "azurerm_network_security_group", provider: "azurerm", module_path: [], change: null,
    rules: [
      { name: "allow-https", priority: 100, direction: "Inbound", access: "Allow", protocol: "Tcp", ports: "443", source: "Internet", destination: "*" },
      { name: "internal", priority: 200, direction: "Inbound", access: "Allow", protocol: "Tcp", ports: "22", source: "10.0.0.0/8", destination: "*" },
    ] };
  const graph = { version: 4 as const, nodes: [nsg], edges: [] };
  render(<NodeDetailsPanel graph={graph} node={nsg} onClose={() => {}} onSelect={() => {}} />);
  expect(screen.getByText("Security rules")).toBeInTheDocument();
  expect(screen.getByText("allow-https")).toBeInTheDocument();
  expect(screen.getByLabelText(/internet source/i)).toBeInTheDocument(); // one flagged row
});
```

- [ ] **Step 2: Run — expect FAIL.**

- [ ] **Step 3: Implement `sortedRules`** in `node-details.ts`:

```ts
import type { GraphNode, NsgRule } from "@/api/types";

const INTERNET = new Set(["*", "0.0.0.0/0", "internet"]);

/** NSG rules sorted by priority, each flagged if its source is an internet one. */
export function sortedRules(node: GraphNode): { rule: NsgRule; internet: boolean }[] {
  return [...(node.rules ?? [])]
    .sort((a, b) => a.priority - b.priority)
    .map((rule) => ({ rule, internet: INTERNET.has(rule.source.trim().toLowerCase()) }));
}
```

- [ ] **Step 4: Add the section to `NodeDetailsPanel`.** Import `sortedRules`. Compute `const rules = sortedRules(node);` near the other derives. After the Connections section, add:

```tsx
        {rules.length > 0 && (
          <SidePanelSection label="Security rules">
            <div className="border-border divide-border divide-y rounded-md border font-mono text-[11px]">
              {rules.map(({ rule, internet }) => (
                <div key={rule.name} className={cn("flex flex-wrap items-center gap-x-2 gap-y-0.5 px-2.5 py-1.5", internet && "bg-exposed-soft")}>
                  <span className="text-faint w-8">{rule.priority}</span>
                  <span className="text-ink flex-1 break-all">{rule.name}</span>
                  <span className="text-muted-foreground">{rule.direction} {rule.access}</span>
                  <span className="text-muted-foreground">{rule.ports}</span>
                  {internet ? (
                    <span aria-label="internet source" className="text-exposed">{rule.source}</span>
                  ) : (
                    <span className="text-muted-foreground">{rule.source}</span>
                  )}
                </div>
              ))}
            </div>
          </SidePanelSection>
        )}
```

- [ ] **Step 5: Run — expect PASS.**

Run: `pnpm --filter @groundplan/frontend exec vitest run src/components/node-details-panel.test.tsx`
Expected: PASS.

- [ ] **Step 6: Full frontend suite + typecheck; confirm the design-tokens guard passes** (the new `exposed` utilities come from a token, not a hardcoded colour).

Run: `pnpm --filter @groundplan/frontend test` then `pnpm typecheck`
Expected: PASS.

- [ ] **Step 7: Commit GP-45.**

```bash
git add apps/frontend
git commit -m "$(printf 'feat(frontend): exposure highlighting & NSG rule inspection (GP-45)\n\nCo-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>')"
```

---

## Post-implementation

- [ ] Full monorepo check: `pnpm typecheck` and both test suites green.
- [ ] Transition GP-42, GP-43, GP-44, GP-45 to **Done** in Jira (asterius-it site, cloudId `0ab97f56-3223-4deb-b3ce-c3bf9e4a238f`), using the transitions API.

## Self-review notes (author checklist run)

- **Spec coverage:** GP-42 (schema+containment+both producers+fixtures) → Tasks 42.1-42.3. GP-43 (rules+internet_exposed+associations+both producers) → 43.1-43.3. GP-44 (projection+switcher+container+chip) → 44.1-44.3. GP-45 (exposure token+badge/ring+rules section+PR-via-attribute-diff, which needs no new code) → 45.1-45.2. All acceptance criteria mapped.
- **`associated_ids` decision** implemented in 43.1/43.2/43.3 and consumed by `exposedNodeIds` (45.1) and `networkProjection` (44.1) — consistent name throughout.
- **Type consistency:** `deriveContainment`, `attachNsg`, `ExtractedNsg`, `NsgRule`, `computeInternetExposed`, `normalizePorts`, `networkProjection`, `exposedNodeIds`, `sortedRules`, `useGraphView`/`GraphView` — each defined once and referenced with the same signature.
- **Version escalation** to 4 is guarded on a field actually being populated in every producer path (42.3, 43.2, 43.3), preserving backward-compatible byte-identical output for non-network snapshots.
