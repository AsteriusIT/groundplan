/**
 * Shared containment derivation (GP-42, extended GP-86): set a single nullable
 * `parent_id` per node expressing containment — the network chain
 * (vnet⊃subnet⊃resource) plus resource stacking (a satellite nests under its host,
 * `probe → lb → subnet → vnet`). Reuses the same reference resolver as the
 * dependency-edge builder, so both producers (plan.json and static HCL) get it for
 * free. Never guesses: a node keeps no parent unless exactly one candidate
 * resolves; when a satellite rule finds none it falls back to the generic rules,
 * so an unresolved satellite lands wherever it would today (its subnet, or none).
 * Distinct from the module `contains` edges (which model module hierarchy).
 */
import {
  resolveReference,
  stripInstanceIndex,
  type DependencySource,
  type EdgeContext,
} from "./dependency-edges.js";
import type { GraphNode } from "./graph.js";

/**
 * A containment rule: which children look for which parent resource type(s), and
 * in which reference direction. Azure points both ways: a probe references its LB
 * (`down`), but a VM references its NICs and an app gateway references its public
 * IP (`up`), so the child is found by walking references *back* to it.
 */
type ContainmentRule = {
  /** True when this rule applies to `node`. */
  childMatches: (node: GraphNode) => boolean;
  /** The resource type(s) a resolved parent must have. */
  parentTypes: readonly string[];
  /**
   * `"down"` (default): the child references the parent (subnet→vnet, probe→lb).
   * `"up"`: the parent references the child (VM→NIC, appgw→public_ip) — the parent
   * is the single node whose references point at this child.
   */
  direction?: "down" | "up";
  /** Resolve through an intermediate hop: child → refs of these types → each
   * hop's own refs of `parentTypes` (a VM never references a subnet; its NIC's
   * ip_configuration does). */
  via?: readonly string[];
  /** On 2+ candidates, defer to the common-ancestor pass instead of falling
   * through to a lower-priority rule. */
  ancestorFallback?: boolean;
};

// Data-driven, ordered; for each node the first rule that yields a *unique* parent
// wins. Satellite rules precede the generic subnet rule, so a probe nests under
// its LB rather than beside it in the subnet; when a satellite rule resolves
// nothing the node falls through to the generic rule (today's behaviour).
const LB_SATELLITES = new Set([
  "azurerm_lb_probe",
  "azurerm_lb_backend_address_pool",
  "azurerm_lb_rule",
  "azurerm_lb_nat_rule",
  "azurerm_lb_outbound_rule",
]);

const VM_HOST_TYPES = new Set([
  "azurerm_linux_virtual_machine",
  "azurerm_windows_virtual_machine",
  "azurerm_virtual_machine",
]);

const RULES: ContainmentRule[] = [
  // A subnet is contained by its virtual network (virtual_network_name ref).
  {
    childMatches: (n) => n.type === "azurerm_subnet",
    parentTypes: ["azurerm_virtual_network"],
  },
  // GP-86: an LB satellite nests under the load balancer it references.
  {
    childMatches: (n) => LB_SATELLITES.has(n.type),
    parentTypes: ["azurerm_lb"],
  },
  // GP-86: a public IP nests under the one resource that references it (reverse).
  {
    childMatches: (n) => n.type === "azurerm_public_ip",
    parentTypes: [
      "azurerm_application_gateway",
      "azurerm_bastion_host",
      "azurerm_nat_gateway",
      "azurerm_lb",
    ],
    direction: "up",
  },
  // GP-86: a NIC nests under the VM that references it (reverse), not its subnet.
  {
    childMatches: (n) => n.type === "azurerm_network_interface",
    parentTypes: [
      "azurerm_linux_virtual_machine",
      "azurerm_windows_virtual_machine",
    ],
    direction: "up",
  },
  // A VM is placed through its NICs (VM → NIC → subnet). Several distinct
  // subnets (a multi-homed VM) degrade to the nearest common ancestor.
  {
    childMatches: (n) => VM_HOST_TYPES.has(n.type),
    parentTypes: ["azurerm_subnet"],
    via: ["azurerm_network_interface"],
    ancestorFallback: true,
  },
  // Anything else that references a subnet (NIC ip_configuration.subnet_id, AKS
  // vnet_subnet_id, bastion, app gateway, private endpoint, …) is contained by
  // that subnet. Reached by satellites only as a fallback (see above).
  {
    childMatches: (n) =>
      n.type !== "azurerm_subnet" &&
      n.type !== "azurerm_virtual_network" &&
      n.type !== "module",
    parentTypes: ["azurerm_subnet"],
  },
];

/**
 * Reverse index for `"up"` rules: node id → the node ids that reference it. A
 * source's `fromBase` may fan out to count/for_each instances, so each is a
 * distinct referrer.
 */
function buildReferrers(
  sources: readonly DependencySource[],
  ctx: EdgeContext,
): Map<string, Set<string>> {
  const referrersOf = new Map<string, Set<string>>();
  const add = (targetId: string, fromId: string): void => {
    if (fromId === targetId) return;
    const set = referrersOf.get(targetId) ?? new Set<string>();
    set.add(fromId);
    referrersOf.set(targetId, set);
  };
  for (const source of sources) {
    const fromIds =
      ctx.instancesByBase.get(source.fromBase) ?? [source.fromBase];
    for (const { ref } of source.refs) {
      for (const targetId of resolveReference(source.prefix, ref, ctx)) {
        for (const fromId of fromIds) add(targetId, fromId);
      }
    }
  }
  return referrersOf;
}

/** Resolvers a `deriveContainment` pass shares across every node. */
type ResolveCtx = {
  ctx: EdgeContext;
  typeById: ReadonlyMap<string, string>;
  sourceByBase: ReadonlyMap<string, DependencySource>;
  referrersOf: ReadonlyMap<string, ReadonlySet<string>>;
};

/** Add every node a source references whose type is wanted (excluding `exclude`). */
function collectRefsOfType(
  source: DependencySource,
  exclude: string,
  wanted: ReadonlySet<string>,
  r: ResolveCtx,
  out: Set<string>,
): void {
  for (const { ref } of source.refs) {
    for (const id of resolveReference(source.prefix, ref, r.ctx)) {
      if (id !== exclude && wanted.has(r.typeById.get(id) ?? "")) out.add(id);
    }
  }
}

/** Candidates for a `via` rule: the node's refs of the via types, then each
 * hop's own refs of the wanted parent types (VM → NIC → subnet). */
function viaCandidates(
  node: GraphNode,
  via: readonly string[],
  wanted: ReadonlySet<string>,
  r: ResolveCtx,
): Set<string> {
  const out = new Set<string>();
  const mids = new Set<string>();
  const source = r.sourceByBase.get(stripInstanceIndex(node.id));
  if (source) collectRefsOfType(source, node.id, new Set(via), r, mids);
  for (const mid of mids) {
    const midSource = r.sourceByBase.get(stripInstanceIndex(mid));
    if (midSource) collectRefsOfType(midSource, mid, wanted, r, out);
  }
  return out;
}

/** The parent nodes a single rule proposes for `node` (0, 1, or many). */
function parentCandidates(
  node: GraphNode,
  rule: ContainmentRule,
  r: ResolveCtx,
): Set<string> {
  const wanted = new Set(rule.parentTypes);
  const out = new Set<string>();
  if (rule.via) return viaCandidates(node, rule.via, wanted, r);
  if (rule.direction === "up") {
    for (const refId of r.referrersOf.get(node.id) ?? []) {
      const refType = r.typeById.get(refId) ?? "";
      if (wanted.has(refType)) {
        out.add(refId); // the host references the child directly (appgw, bastion, lb)
      } else if (refType.includes("_association")) {
        // The child is bound to its host by a dedicated association resource
        // (e.g. azurerm_nat_gateway_public_ip_association, which references both a
        // public IP and a NAT gateway) — resolve *through* it to the host.
        const assoc = r.sourceByBase.get(stripInstanceIndex(refId));
        if (assoc) collectRefsOfType(assoc, node.id, wanted, r, out);
      }
    }
    return out;
  }
  const source = r.sourceByBase.get(stripInstanceIndex(node.id));
  if (source) collectRefsOfType(source, node.id, wanted, r, out);
  return out;
}

/** Pre-assign the parents the join catalog stated (target must exist). */
function applyJoinParents(
  nodes: GraphNode[],
  joinParents: ReadonlyMap<string, string> | undefined,
  typeById: ReadonlyMap<string, string>,
): void {
  if (!joinParents) return;
  for (const node of nodes) {
    const parent = joinParents.get(node.id);
    if (parent !== undefined && typeById.has(parent)) node.parent_id = parent;
  }
}

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

/**
 * Set `parent_id` on every node that has exactly one qualifying container
 * reference. Mutates the nodes in place. Two phases:
 *
 * Phase 1 — `joins.parents` (GP: azurerm join catalog) are parents stated by a
 * dedicated association/attachment resource; what a join resource says outranks
 * what a reference implies, so those land first and the rules never override
 * them. Then each node takes the first rule yielding a unique candidate.
 *
 * Phase 2 — an ambiguous multi-anchor set (`joins.ambiguous`, or a rule marked
 * `ancestorFallback`) resolves to the nearest common ancestor of its anchors
 * along the freshly-derived chains — a NAT gateway serving two subnets of one
 * vnet lands in that vnet. No common ancestor leaves the node unplaced,
 * degraded, never guessed.
 */
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

  const deferred = new Map<string, readonly string[]>(joins?.ambiguous ?? []);
  for (const node of nodes) {
    if (node.parent_id !== undefined) continue; // a join already placed it
    applyRules(node, r, (id, anchors) => deferred.set(id, anchors));
  }
  applyAncestorFallback(nodes, deferred);
}

const compareStrings = (a: string, b: string): number => {
  if (a < b) return -1;
  return a > b ? 1 : 0;
};

/** Phase 1 for one node: the first rule yielding a unique candidate places it;
 * a rule marked `ancestorFallback` defers its multi-candidate set instead. */
function applyRules(
  node: GraphNode,
  r: ResolveCtx,
  defer: (id: string, anchors: readonly string[]) => void,
): void {
  for (const rule of RULES) {
    if (!rule.childMatches(node)) continue;
    const targets = parentCandidates(node, rule, r);
    if (targets.size === 1) {
      node.parent_id = [...targets][0];
      return; // resolved — do not fall through to a lower-priority rule
    }
    if (targets.size > 1 && rule.ancestorFallback) {
      defer(node.id, [...targets].sort(compareStrings));
      return;
    }
    // Zero or 2+ candidates: never guess. Fall through to the next matching
    // rule (a satellite's fallback is the generic subnet rule).
  }
}

/** Phase 2: resolve each deferred set to its anchors' nearest common ancestor. */
function applyAncestorFallback(
  nodes: GraphNode[],
  deferred: ReadonlyMap<string, readonly string[]>,
): void {
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
