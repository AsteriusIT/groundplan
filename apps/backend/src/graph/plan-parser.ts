/**
 * Producer A: turn a Terraform `plan.json` (the output of `terraform show -json`,
 * ingested via the CI webhook) into a GraphSnapshot graph. Pure function — plan
 * JSON in, graph out; no I/O, no side effects.
 *
 * Scope decisions (documented per GP-13):
 *  - **Data resources are skipped.** In a plan, `data` sources appear as reads
 *    on every run and carry no change impact; the plan-impact view is about
 *    managed-resource changes, so we exclude `mode: "data"` entries. (The docs
 *    flow — Producer B, GP-15 — *does* include data blocks, for a different,
 *    static-documentation purpose.)
 *  - **Dependencies are best-effort.** We resolve explicit `depends_on` and
 *    expression `references` from `configuration` (GP-20). Expression-derived
 *    edges are flagged `inferred: true`; count/for_each targets expand to all
 *    instances; `module.x.output` references edge to the module node. Anything
 *    unresolved (vars, locals) is silently skipped. The resolution itself lives
 *    in the shared `dependency-edges` builder (reused by Producer B).
 */
import {
  attachAssociations,
  attachIam,
  attachNsg,
  buildDependencyEdges,
  buildInstancesByBase,
  classifyJoins,
  deriveContainment,
  inlineScaleSetLinks,
  inlineVmAttachLinks,
  joinEdgeAdditions,
  joinEffects,
  normalizePorts,
  resolveReference,
  type DependencySource,
  type EdgeContext,
  type ExtractedIam,
  type ExtractedNsg,
  type JoinLink,
  type RawRef,
} from "@groundplan/graph-parser";

import { computeAttributeDiff, type PlanResourceChange } from "./attribute-diff.js";
import type {
  ChangeKind,
  Graph,
  GraphEdge,
  GraphNode,
  Identity,
  NsgRule,
  RoleAssignment,
  UnresolvedReference,
} from "./graph.js";
import { propagateImpact } from "./impact.js";

type PlanChange = PlanResourceChange & { actions?: unknown };
type ResourceChange = {
  address?: unknown;
  module_address?: unknown;
  mode?: unknown;
  type?: unknown;
  name?: unknown;
  provider_name?: unknown;
  change?: PlanChange;
};

type ConfigResource = {
  address?: unknown;
  depends_on?: unknown;
  expressions?: unknown;
};
type ConfigModule = {
  resources?: unknown;
  module_calls?: unknown;
};

/** True when a webhook payload looks like a `terraform show -json` plan. */
export function isTerraformPlan(payload: unknown): boolean {
  if (!payload || typeof payload !== "object") return false;
  const p = payload as Record<string, unknown>;
  return "format_version" in p && Array.isArray(p["resource_changes"]);
}

/** Map a plan's `change.actions` array to our single change kind. */
function actionsToChange(actions: string[]): ChangeKind {
  const key = actions.join(",");
  if (key === "create") return "create";
  if (key === "delete") return "delete";
  if (key === "update") return "update";
  if (key === "no-op" || key === "read") return "noop";
  // Replace, in either order (delete-then-create or create-then-delete).
  if (actions.includes("delete") && actions.includes("create")) return "update";
  return "noop";
}

/** Strip an instance index (`a[0]`, `a["k"]`) from a module segment name. */
function stripIndex(segment: string): string {
  return segment.replace(/\[.*\]$/, "");
}

/** Module names from a `module_address` ("module.a.module.b" -> ["a","b"]). */
function moduleParts(moduleAddress: string): string[] {
  const parts = moduleAddress.split(".");
  const names: string[] = [];
  for (let i = 0; i < parts.length - 1; i++) {
    if (parts[i] === "module") names.push(stripIndex(parts[i + 1] as string));
  }
  return names;
}

/** The chain of synthetic module nodes implied by a `module_address`. */
function moduleNodeChain(moduleAddress: string): GraphNode[] {
  const parts = moduleAddress.split(".");
  const chain: GraphNode[] = [];
  const idParts: string[] = [];
  const path: string[] = [];
  for (let i = 0; i < parts.length - 1; i++) {
    if (parts[i] !== "module") continue;
    const segment = parts[i + 1] as string;
    idParts.push("module", segment);
    const name = stripIndex(segment);
    chain.push({
      id: idParts.join("."),
      name,
      type: "module",
      provider: null,
      module_path: [...path],
      change: null,
    });
    path.push(name);
  }
  return chain;
}

/** Normalize a provider name ("registry.terraform.io/hashicorp/aws" -> "aws"). */
function shortProvider(providerName: unknown): string | null {
  if (typeof providerName !== "string" || providerName === "") return null;
  const segments = providerName.split("/");
  return segments.at(-1) || null;
}

function asString(value: unknown): string {
  return typeof value === "string" ? value : "";
}

/** Recursively collect every `references: string[]` under a config node. */
function collectReferences(node: unknown, out: Set<string>): void {
  if (!node || typeof node !== "object") return;
  if (Array.isArray(node)) {
    for (const item of node) collectReferences(item, out);
    return;
  }
  for (const [key, value] of Object.entries(node)) {
    if (key === "references" && Array.isArray(value)) {
      for (const ref of value) if (typeof ref === "string") out.add(ref);
    } else {
      collectReferences(value, out);
    }
  }
}

/**
 * Walk the configuration tree collecting each resource's outgoing references:
 * explicit `depends_on` (inferred: false) and expression `references`
 * (inferred: true). Resolution to node ids happens in the shared edge builder.
 */
function collectSources(
  mod: ConfigModule,
  prefix: string,
  out: DependencySource[],
): void {
  const resources = Array.isArray(mod.resources) ? mod.resources : [];
  for (const raw of resources) {
    const res = raw as ConfigResource;
    const refs: RawRef[] = [];
    if (Array.isArray(res.depends_on)) {
      for (const d of res.depends_on) {
        if (typeof d === "string") refs.push({ ref: d, inferred: false });
      }
    }
    const exprRefs = new Set<string>();
    collectReferences(res.expressions, exprRefs);
    for (const ref of exprRefs) refs.push({ ref, inferred: true });

    if (refs.length > 0) {
      out.push({ fromBase: prefix + asString(res.address), prefix, refs });
    }
  }

  const calls = mod.module_calls;
  if (calls && typeof calls === "object") {
    for (const [name, raw] of Object.entries(calls)) {
      const child = (raw as { module?: unknown }).module;
      if (child && typeof child === "object") {
        collectSources(child as ConfigModule, `${prefix}module.${name}.`, out);
      }
    }
  }
}

const compareStrings = (a: string, b: string): number => {
  if (a < b) return -1;
  return a > b ? 1 : 0;
};

const sortEdges = (a: GraphEdge, b: GraphEdge): number =>
  compareStrings(a.kind, b.kind) ||
  compareStrings(a.from, b.from) ||
  compareStrings(a.to, b.to);

/** Join a value that may be a scalar or a string[] into one string. */
function joinValue(value: unknown): string {
  if (Array.isArray(value)) return value.map(String).join(",");
  return typeof value === "string" ? value : "";
}

/** Map a plan `after.security_rule[]` entry to an NsgRule (raw values). */
function planRule(raw: unknown): NsgRule | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.name !== "string") return null;
  const ports = r.destination_port_range ?? r.destination_port_ranges;
  const source = joinValue(r.source_address_prefix ?? r.source_address_prefixes);
  return {
    name: r.name,
    priority: typeof r.priority === "number" ? r.priority : Number(r.priority) || 0,
    direction: asString(r.direction),
    access: asString(r.access),
    protocol: asString(r.protocol),
    ports: normalizePorts(ports),
    source: source || "*",
    destination: joinValue(r.destination_address_prefix) || "*",
  };
}

/**
 * Collect per-NSG rules from `change.after.security_rule`. The subnet/NIC
 * associations that used to be resolved here now come from the join catalog
 * (`azurerm-joins.ts`).
 */
function extractPlanNsg(changes: readonly unknown[]): Map<string, ExtractedNsg> {
  const extracted = new Map<string, ExtractedNsg>();
  const nsgOf = (id: string): ExtractedNsg => {
    let e = extracted.get(id);
    if (!e) {
      e = { rules: [] };
      extracted.set(id, e);
    }
    return e;
  };

  for (const raw of changes) {
    const rc = raw as ResourceChange;
    if (rc.type !== "azurerm_network_security_group") continue;
    const after = (rc.change?.after ?? {}) as Record<string, unknown>;
    const inline = Array.isArray(after.security_rule) ? after.security_rule : [];
    for (const r of inline) {
      const nr = planRule(r);
      if (nr) nsgOf(asString(rc.address)).rules.push(nr);
    }
  }

  return extracted;
}

/** v7 attributes a network frame carries: its CIDRs, from the plan's `after`. */
function planNetworkAttributes(
  type: string,
  after: Record<string, unknown>,
): Record<string, string> | undefined {
  let key: string | null = null;
  if (type === "azurerm_subnet") key = "address_prefixes";
  else if (type === "azurerm_virtual_network") key = "address_space";
  if (!key) return undefined;
  const value = after[key];
  if (!Array.isArray(value) || value.length === 0) return undefined;
  return { [key]: value.map(String).join(", ") };
}

/** One configuration resource's module prefix + raw per-attribute expressions. */
type ConfigEntry = { prefix: string; expressions: Record<string, unknown> };

/** Index every configuration resource by full address (module prefix applied). */
function indexConfigResources(
  mod: ConfigModule,
  prefix: string,
  out: Map<string, ConfigEntry>,
): void {
  const resources = Array.isArray(mod.resources) ? mod.resources : [];
  for (const raw of resources) {
    const res = raw as ConfigResource;
    const expressions =
      res.expressions && typeof res.expressions === "object"
        ? (res.expressions as Record<string, unknown>)
        : {};
    out.set(prefix + asString(res.address), { prefix, expressions });
  }
  const calls = mod.module_calls;
  if (calls && typeof calls === "object") {
    for (const [name, raw] of Object.entries(calls)) {
      const child = (raw as { module?: unknown }).module;
      if (child && typeof child === "object") {
        indexConfigResources(child as ConfigModule, `${prefix}module.${name}.`, out);
      }
    }
  }
}

/** First reference under an expression that resolves to an existing node id. */
function resolveExprNode(
  expr: unknown,
  prefix: string,
  edgeCtx: EdgeContext,
  nodesById: ReadonlyMap<string, GraphNode>,
): string | null {
  const refs = new Set<string>();
  collectReferences(expr, refs);
  for (const ref of refs) {
    for (const id of resolveReference(prefix, ref, edgeCtx)) {
      if (nodesById.has(id)) return id;
    }
  }
  return null;
}

/** Resolve an `identity {}` block's refs to the user-assigned-identity node ids. */
function resolveIdentityIds(
  expr: unknown,
  prefix: string,
  edgeCtx: EdgeContext,
  nodesById: ReadonlyMap<string, GraphNode>,
): string[] {
  const refs = new Set<string>();
  collectReferences(expr, refs);
  const ids = new Set<string>();
  for (const ref of refs) {
    for (const id of resolveReference(prefix, ref, edgeCtx)) {
      if (nodesById.get(id)?.type === "azurerm_user_assigned_identity") ids.add(id);
    }
  }
  return [...ids].sort(compareStrings);
}

/** The first `identity {}` block object from a plan `after.identity` value. */
function firstIdentityBlock(value: unknown): Record<string, unknown> | null {
  const block = Array.isArray(value) ? value[0] : value;
  return block && typeof block === "object"
    ? (block as Record<string, unknown>)
    : null;
}

/**
 * Collect role-assignment triples (with references resolved to addresses) and
 * managed-identity payloads. The `privileged` flag is computed later by the
 * shared `attachIam` step so both producers agree.
 */
function extractPlanIam(
  changes: readonly unknown[],
  configByAddress: ReadonlyMap<string, ConfigEntry>,
  edgeCtx: EdgeContext,
  nodesById: ReadonlyMap<string, GraphNode>,
): Map<string, ExtractedIam> {
  const extracted = new Map<string, ExtractedIam>();
  const iamOf = (id: string): ExtractedIam => {
    let e = extracted.get(id);
    if (!e) {
      e = {};
      extracted.set(id, e);
    }
    return e;
  };

  for (const raw of changes) {
    const rc = raw as ResourceChange;
    if (rc.mode === "data") continue;
    const type = asString(rc.type);
    const address = asString(rc.address);
    const after = (rc.change?.after ?? {}) as Record<string, unknown>;
    const cfg = configByAddress.get(address);
    const prefix = cfg?.prefix ?? "";
    const expr = cfg?.expressions ?? {};

    if (type === "azurerm_role_assignment") {
      const role =
        asString(after.role_definition_name) || asString(after.role_definition_id);
      const principal =
        resolveExprNode(expr.principal_id, prefix, edgeCtx, nodesById) ??
        asString(after.principal_id);
      const scope =
        resolveExprNode(expr.scope, prefix, edgeCtx, nodesById) ??
        asString(after.scope);
      const roleAssignment: RoleAssignment = { role, principal, scope };
      const principalType = asString(after.principal_type);
      if (principalType) roleAssignment.principal_type = principalType;
      iamOf(address).role = roleAssignment;
      continue;
    }

    if (type === "azurerm_user_assigned_identity") {
      iamOf(address).identity = { type: "UserAssigned" };
      continue;
    }

    const block = firstIdentityBlock(after.identity);
    if (block) {
      const identity: Identity = { type: asString(block.type) };
      const ids = resolveIdentityIds(expr.identity, prefix, edgeCtx, nodesById);
      if (ids.length > 0) identity.identity_ids = ids;
      iamOf(address).identity = identity;
    }
  }

  return extracted;
}

/**
 * Would this reference point at a managed resource in the plan (vs. an attribute
 * name, a `var.`/`local.`, or a `data.` source)? Data reads are excluded from a
 * plan's graph on purpose (they carry no change), so a reference to one is not a
 * dangling reference — only a ref to a real resource type or module that is
 * absent counts as one worth reporting.
 */
function planReferenceable(ref: string, resourceTypes: ReadonlySet<string>): boolean {
  if (ref.startsWith("data.")) return false;
  if (ref.startsWith("module.")) return true;
  const firstType = (ref.split(".")[0] ?? "").replace(/\[.*\]$/, "");
  return resourceTypes.has(firstType);
}

/**
 * The join links a plan states: every association/attachment resource classified
 * through the catalog, plus the scale sets' inline NSG/ASG duality read from
 * their configuration expressions.
 */
function planJoinLinks(
  sources: readonly DependencySource[],
  configByAddress: ReadonlyMap<string, ConfigEntry>,
  edgeCtx: EdgeContext,
  typeById: ReadonlyMap<string, string>,
): JoinLink[] {
  const links = classifyJoins(sources, edgeCtx, typeById);
  for (const [address, entry] of configByAddress) {
    if (!address.includes("_virtual_machine")) continue;
    const refs = new Set<string>();
    collectReferences(entry.expressions, refs);
    links.push(
      ...inlineScaleSetLinks(address, entry.prefix, refs, edgeCtx, typeById),
      ...inlineVmAttachLinks(address, entry.prefix, refs, edgeCtx, typeById),
    );
  }
  return links;
}

/**
 * Parse a Terraform plan into a GraphSnapshot graph (deterministic ordering).
 * When `out` is given, references that resolve to no node in the plan are
 * collected into `out.unresolved` (the "could not resolve" list, GP).
 */
export function parsePlanToGraph(
  plan: unknown,
  out?: { unresolved: UnresolvedReference[] },
): Graph {
  const p = (plan ?? {}) as { resource_changes?: unknown; configuration?: unknown };
  const changes = Array.isArray(p.resource_changes) ? p.resource_changes : [];

  const nodesById = new Map<string, GraphNode>();
  const containsEdges = new Map<string, GraphEdge>();

  for (const raw of changes) {
    const rc = raw as ResourceChange;
    if (rc.mode === "data") continue; // documented: data reads excluded

    const id = asString(rc.address);
    const actions = Array.isArray(rc.change?.actions)
      ? (rc.change.actions.filter((a) => typeof a === "string") as string[])
      : [];
    const moduleAddress = asString(rc.module_address);
    const change = actionsToChange(actions);

    const node: GraphNode = {
      id,
      name: asString(rc.name),
      type: asString(rc.type),
      provider: shortProvider(rc.provider_name),
      module_path: moduleAddress ? moduleParts(moduleAddress) : [],
      change,
    };

    // Masked before/after attribute diff for changed managed resources (GP-32).
    // Appended last so node key order stays stable for byte-stable output.
    if (change !== "noop") {
      const { rows, truncated } = computeAttributeDiff(rc.change, change);
      if (rows.length > 0) {
        node.attribute_diff = rows;
        if (truncated) node.attribute_diff_truncated = true;
      }
    }

    // v7 CIDR attributes for network frames, read from the planned `after`.
    const after = (rc.change?.after ?? {}) as Record<string, unknown>;
    const attrs = planNetworkAttributes(node.type, after);
    if (attrs) node.attributes = attrs;

    nodesById.set(id, node);

    // Synthetic module nodes + contains edges for the module hierarchy.
    if (moduleAddress) {
      const chain = moduleNodeChain(moduleAddress);
      for (let i = 0; i < chain.length; i++) {
        const node = chain[i] as GraphNode;
        if (!nodesById.has(node.id)) nodesById.set(node.id, node);
        const parent = chain[i - 1];
        if (parent) {
          containsEdges.set(`${parent.id} ${node.id}`, {
            from: parent.id,
            to: node.id,
            kind: "contains",
          });
        }
      }
      const deepest = chain.at(-1);
      if (deepest) {
        containsEdges.set(`${deepest.id} ${id}`, {
          from: deepest.id,
          to: id,
          kind: "contains",
        });
      }
    }
  }

  // Resource / module id sets + instance map for dependency resolution.
  const resourceIds = new Set<string>();
  const moduleIds = new Set<string>();
  const resourceTypes = new Set<string>();
  for (const node of nodesById.values()) {
    if (node.type === "module") moduleIds.add(node.id);
    else {
      resourceIds.add(node.id);
      resourceTypes.add(node.type);
    }
  }

  const sources: DependencySource[] = [];
  const configByAddress = new Map<string, ConfigEntry>();
  const config = (p.configuration ?? {}) as { root_module?: unknown };
  if (config.root_module && typeof config.root_module === "object") {
    collectSources(config.root_module as ConfigModule, "", sources);
    indexConfigResources(config.root_module as ConfigModule, "", configByAddress);
  }
  const edgeCtx = {
    resourceIds,
    moduleIds,
    instancesByBase: buildInstancesByBase(resourceIds),
  };
  const collected: UnresolvedReference[] = [];
  const dependsOnEdges = buildDependencyEdges(
    sources,
    edgeCtx,
    out
      ? {
          referenceable: (ref) => planReferenceable(ref, resourceTypes),
          out: collected,
        }
      : undefined,
  );

  // The azurerm join catalog (docs/azurerm-connection-catalog.md): classify every
  // association/attachment resource — plus the scale sets' inline NSG/ASG duality
  // — into containment parents, `associated_ids`, and direct edges.
  const typeById = new Map<string, string>(
    [...nodesById.values()].map((n) => [n.id, n.type]),
  );
  const joins = joinEffects(
    planJoinLinks(sources, configByAddress, edgeCtx, typeById),
    typeById,
  );

  // Network containment (GP-42): parents the join catalog stated, then nodes with
  // a single unambiguous vnet/subnet parent; ambiguous multi-anchor sets degrade
  // to their nearest common ancestor. Mutates the nodes in nodesById.
  deriveContainment([...nodesById.values()], sources, edgeCtx, joins);

  // NSG payload (GP-43): rules + internet_exposed on NSG nodes.
  attachNsg([...nodesById.values()], extractPlanNsg(changes));

  // Attachments (GP-43/89 + the join catalog): associated_ids on every satellite.
  attachAssociations([...nodesById.values()], joins.attachments);

  // IAM payload (GP-47): role-assignment triples, managed identities, and the
  // computed privileged flag on the relevant nodes.
  attachIam(
    [...nodesById.values()],
    extractPlanIam(changes, configByAddress, edgeCtx, nodesById),
  );

  const nodes = [...nodesById.values()].sort((a, b) => compareStrings(a.id, b.id));
  const edges = [
    ...containsEdges.values(),
    ...dependsOnEdges,
    // Direct edges the joins state (a peering, a NIC → pool binding), unless a
    // reference already drew the same pair.
    ...joinEdgeAdditions(joins, dependsOnEdges),
  ].sort(sortEdges);

  // Blast radius: mark unchanged dependents of the change set (GP-22). Emits v2.
  const withImpact = propagateImpact({ version: 1, nodes, edges });
  // Highest applicable version wins: v4 (containment or NSG payload, GP-42/43) >
  // v3 (attribute diff, GP-32) > v2. Non-network/-NSG snapshots stay
  // byte-identical to their prior version.
  const isV4 = (n: GraphNode): boolean =>
    n.parent_id !== undefined ||
    n.rules !== undefined ||
    n.internet_exposed !== undefined ||
    n.associated_ids !== undefined ||
    n.role_assignment !== undefined ||
    n.identity !== undefined;
  let version: Graph["version"] = 2;
  if (withImpact.nodes.some((n) => n.attribute_diff !== undefined)) version = 3;
  if (withImpact.nodes.some(isV4)) version = 4;
  // v7 when any node carries `attributes` (a subnet/vnet CIDR).
  if (withImpact.nodes.some((n) => n.attributes !== undefined)) version = 7;

  if (out) {
    out.unresolved.push(
      ...collected
        .map((u) => ({ ...u, reason: "no matching resource or module in the plan" }))
        .sort((a, b) => compareStrings(a.from, b.from) || compareStrings(a.ref, b.ref)),
    );
  }

  return { ...withImpact, version };
}
