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
import { computeAttributeDiff, type PlanResourceChange } from "./attribute-diff.js";
import { deriveContainment } from "./containment.js";
import {
  buildDependencyEdges,
  buildInstancesByBase,
  resolveReference,
  type DependencySource,
  type EdgeContext,
  type RawRef,
} from "./dependency-edges.js";
import type { ChangeKind, Graph, GraphEdge, GraphNode, NsgRule } from "./graph.js";
import { propagateImpact } from "./impact.js";
import { attachNsg, normalizePorts, type ExtractedNsg } from "./nsg.js";

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
  return segments[segments.length - 1] || null;
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

const compareStrings = (a: string, b: string): number =>
  a < b ? -1 : a > b ? 1 : 0;

const sortEdges = (a: GraphEdge, b: GraphEdge): number =>
  compareStrings(a.kind, b.kind) ||
  compareStrings(a.from, b.from) ||
  compareStrings(a.to, b.to);

/** Join a value that may be a scalar or a string[] into one string. */
function joinValue(value: unknown): string {
  if (Array.isArray(value)) return value.map(String).join(",");
  return typeof value === "string" ? value : "";
}

/** Resolve an association resource's refs to the (NSG, subnet/NIC) it links. */
function associationTargets(
  source: DependencySource,
  edgeCtx: EdgeContext,
  nodesById: ReadonlyMap<string, GraphNode>,
): { nsgId: string; targetId: string } | null {
  const resolved = source.refs.flatMap((r) =>
    resolveReference(source.prefix, r.ref, edgeCtx),
  );
  const nsgId = resolved.find(
    (rid) => nodesById.get(rid)?.type === "azurerm_network_security_group",
  );
  const targetId = resolved.find((rid) => {
    const t = nodesById.get(rid)?.type;
    return t === "azurerm_subnet" || t === "azurerm_network_interface";
  });
  return nsgId && targetId ? { nsgId, targetId } : null;
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
 * Collect per-NSG rules (from `change.after.security_rule`) and NSG↔subnet/NIC
 * associations (resolved from the association resources' config references).
 */
function extractPlanNsg(
  changes: readonly unknown[],
  sources: readonly DependencySource[],
  edgeCtx: EdgeContext,
  nodesById: ReadonlyMap<string, GraphNode>,
): Map<string, ExtractedNsg> {
  const extracted = new Map<string, ExtractedNsg>();
  const nsgOf = (id: string): ExtractedNsg => {
    let e = extracted.get(id);
    if (!e) {
      e = { rules: [], associatedIds: [] };
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

  for (const source of sources) {
    if (!source.fromBase.includes("_security_group_association")) continue;
    const assoc = associationTargets(source, edgeCtx, nodesById);
    if (assoc) nsgOf(assoc.nsgId).associatedIds.push(assoc.targetId);
  }

  return extracted;
}

/** Parse a Terraform plan into a GraphSnapshot graph (deterministic ordering). */
export function parsePlanToGraph(plan: unknown): Graph {
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
      const deepest = chain[chain.length - 1];
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
  for (const node of nodesById.values()) {
    if (node.type === "module") moduleIds.add(node.id);
    else resourceIds.add(node.id);
  }

  const sources: DependencySource[] = [];
  const config = (p.configuration ?? {}) as { root_module?: unknown };
  if (config.root_module && typeof config.root_module === "object") {
    collectSources(config.root_module as ConfigModule, "", sources);
  }
  const edgeCtx = {
    resourceIds,
    moduleIds,
    instancesByBase: buildInstancesByBase(resourceIds),
  };
  const dependsOnEdges = buildDependencyEdges(sources, edgeCtx);

  // Network containment (GP-42): set parent_id on nodes with a single unambiguous
  // vnet/subnet parent. Mutates the node objects still held in nodesById.
  deriveContainment([...nodesById.values()], sources, edgeCtx);

  // NSG payload (GP-43): rules + internet_exposed + associations on NSG nodes.
  attachNsg(
    [...nodesById.values()],
    extractPlanNsg(changes, sources, edgeCtx, nodesById),
  );

  const nodes = [...nodesById.values()].sort((a, b) => compareStrings(a.id, b.id));
  const edges = [...containsEdges.values(), ...dependsOnEdges].sort(sortEdges);

  // Blast radius: mark unchanged dependents of the change set (GP-22). Emits v2.
  const withImpact = propagateImpact({ version: 1, nodes, edges });
  // Highest applicable version wins: v4 (containment or NSG payload, GP-42/43) >
  // v3 (attribute diff, GP-32) > v2. Non-network/-NSG snapshots stay
  // byte-identical to their prior version.
  const isV4 = (n: GraphNode): boolean =>
    n.parent_id !== undefined ||
    n.rules !== undefined ||
    n.internet_exposed !== undefined;
  let version: Graph["version"] = 2;
  if (withImpact.nodes.some((n) => n.attribute_diff !== undefined)) version = 3;
  if (withImpact.nodes.some(isV4)) version = 4;
  return { ...withImpact, version };
}
