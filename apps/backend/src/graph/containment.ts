/**
 * Shared containment derivation (GP-42): set a single nullable `parent_id` per
 * node expressing network containment (vnet⊃subnet⊃resource). Reuses the same
 * reference resolver as the dependency-edge builder, so both producers (plan.json
 * and static HCL) get containment for free. Never guesses: a node keeps no parent
 * unless exactly one of its references resolves to a node of the expected parent
 * type. Distinct from the module `contains` edges (which model module hierarchy).
 */
import {
  resolveReference,
  stripInstanceIndex,
  type DependencySource,
  type EdgeContext,
} from "./dependency-edges.js";
import type { GraphNode } from "./graph.js";

/** A containment rule: which children look for which parent resource type. */
type ContainmentRule = {
  /** True when this rule applies to `node`. */
  childMatches: (node: GraphNode) => boolean;
  /** The resource type a resolved reference must have to be the parent. */
  parentType: string;
};

// Data-driven, ordered; the first matching rule with a unique target wins.
const RULES: ContainmentRule[] = [
  // A subnet is contained by its virtual network (virtual_network_name ref).
  {
    childMatches: (n) => n.type === "azurerm_subnet",
    parentType: "azurerm_virtual_network",
  },
  // Anything else that references a subnet (NIC ip_configuration.subnet_id, AKS
  // vnet_subnet_id, bastion, app gateway, private endpoint, …) is contained by
  // that subnet.
  {
    childMatches: (n) =>
      n.type !== "azurerm_subnet" &&
      n.type !== "azurerm_virtual_network" &&
      n.type !== "module",
    parentType: "azurerm_subnet",
  },
];

/**
 * Set `parent_id` on every node that has exactly one qualifying container
 * reference. Mutates the nodes in place.
 */
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
        if (id !== node.id && typeById.get(id) === rule.parentType) {
          targets.add(id);
        }
      }
    }
    if (targets.size === 1) node.parent_id = [...targets][0];
  }
}
