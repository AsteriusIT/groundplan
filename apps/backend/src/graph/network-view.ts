/**
 * Server-side network-view projection for exports — the backend twin of the
 * canvas `networkProjection` (packages/canvas/src/lib/graph-layout.ts), kept
 * in sync the way categories.ts mirrors resource-category.ts. It returns an
 * ordinary Graph: vnet/subnet containment expressed as `contains` edges (so
 * the layout nests them), NSG internet-exposure propagated onto associated
 * nodes, modules and join-plumbing dropped. Canvas-only affordances (satellite
 * stacks, header chips) are deliberately not mirrored — an export is static.
 */
import { NETWORK_EDGE_JOIN_TYPES } from "@groundplan/graph-parser";

import { categorize } from "./categories.js";
import type { Graph, GraphEdge, GraphNode } from "./graph.js";

const isModule = (node: GraphNode): boolean => node.type === "module";

/** Association/join resources whose meaning is already an edge or containment. */
const isNetworkPlumbing = (node: GraphNode): boolean =>
  node.type.endsWith("_association") || NETWORK_EDGE_JOIN_TYPES.has(node.type);

/** The two structural containers of the network view. */
const isNetworkContainer = (node: GraphNode): boolean =>
  node.type === "azurerm_virtual_network" || node.type === "azurerm_subnet";

/** Nodes with an exposed NSG, plus everything that NSG is associated with. */
function exposedNodeIds(nodes: GraphNode[]): Set<string> {
  const ids = new Set<string>();
  for (const node of nodes) {
    if (!node.internet_exposed) continue;
    ids.add(node.id);
    for (const id of node.associated_ids ?? []) ids.add(id);
  }
  return ids;
}

/** The three keep passes, mirroring the canvas `keptNetworkIds`. */
function keptNetworkIds(graph: Graph): Set<string> {
  const keep = new Set<string>();
  for (const node of graph.nodes) {
    if (isModule(node) || isNetworkPlumbing(node)) continue;
    if (node.parent_id !== undefined || categorize(node.type) === "network") keep.add(node.id);
  }
  // A parent referenced by a kept child is itself kept.
  for (const node of graph.nodes) {
    if (node.parent_id !== undefined && keep.has(node.id)) keep.add(node.parent_id);
  }
  // Keep NSGs associated with a kept node so their exposure is visible.
  for (const node of graph.nodes) {
    if (node.associated_ids?.some((id) => keep.has(id))) keep.add(node.id);
  }
  return keep;
}

/**
 * The canvas renders an associated NSG as a chip on its anchor, not a node
 * (GP-44); the export mirrors that by folding the NSG into the anchor's label
 * — the exposure ring still carries the risk signal.
 */
function chipFold(
  kept: GraphNode[],
  keep: Set<string>,
): { chipIds: Set<string>; namesByAnchor: Map<string, string[]> } {
  const chips = kept.filter((n) => n.associated_ids?.some((id) => keep.has(id)));
  const namesByAnchor = new Map<string, string[]>();
  for (const chip of chips) {
    for (const id of chip.associated_ids ?? []) {
      if (keep.has(id)) namesByAnchor.set(id, [...(namesByAnchor.get(id) ?? []), chip.name]);
    }
  }
  return { chipIds: new Set(chips.map((n) => n.id)), namesByAnchor };
}

/** Project a graph to its network view. */
export function networkViewGraph(graph: Graph): Graph {
  const byId = new Map(graph.nodes.map((n) => [n.id, n]));
  const keep = keptNetworkIds(graph);
  const kept = graph.nodes.filter((n) => keep.has(n.id));
  const exposed = exposedNodeIds(kept);
  const { chipIds, namesByAnchor } = chipFold(kept, keep);

  const nodes = kept
    .filter((n) => !chipIds.has(n.id))
    .map((n) => {
      const extra: Partial<GraphNode> = {};
      if (exposed.has(n.id) && !n.internet_exposed) extra.internet_exposed = true;
      const chipNames = namesByAnchor.get(n.id);
      if (chipNames) extra.display_label = `${n.name} · NSG ${chipNames.join(", ")}`;
      return Object.keys(extra).length > 0 ? { ...n, ...extra } : n;
    });

  const containerIds = new Set(nodes.filter(isNetworkContainer).map((n) => n.id));
  const containsEdges: GraphEdge[] = nodes
    .filter((n) => n.parent_id !== undefined && containerIds.has(n.parent_id))
    .map((n) => ({ from: n.parent_id!, to: n.id, kind: "contains" }));

  // A dependency on your own container (or vice versa) restates the nesting —
  // the canvas hides those, and so do we.
  const parentOf = new Map(
    graph.nodes.filter((n) => n.parent_id !== undefined).map((n) => [n.id, n.parent_id!]),
  );
  const isAncestor = (ancestor: string, id: string): boolean => {
    for (let cur = parentOf.get(id); cur !== undefined; cur = parentOf.get(cur)) {
      if (cur === ancestor) return true;
    }
    return false;
  };

  const dependsOn = graph.edges.filter(
    (e) =>
      e.kind === "depends_on" &&
      keep.has(e.from) &&
      keep.has(e.to) &&
      byId.has(e.from) &&
      !chipIds.has(e.from) &&
      !chipIds.has(e.to) &&
      !isAncestor(e.from, e.to) &&
      !isAncestor(e.to, e.from),
  );

  return { version: graph.version, nodes, edges: [...containsEdges, ...dependsOn] };
}
