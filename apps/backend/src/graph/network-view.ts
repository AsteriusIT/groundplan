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

/** Project a graph to its network view. */
export function networkViewGraph(graph: Graph): Graph {
  const byId = new Map(graph.nodes.map((n) => [n.id, n]));

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

  const kept = graph.nodes.filter((n) => keep.has(n.id));
  const exposed = exposedNodeIds(kept);
  const nodes = kept.map((n) =>
    exposed.has(n.id) && !n.internet_exposed ? { ...n, internet_exposed: true } : n,
  );

  const containerIds = new Set(nodes.filter(isNetworkContainer).map((n) => n.id));
  const containsEdges: GraphEdge[] = nodes
    .filter((n) => n.parent_id !== undefined && containerIds.has(n.parent_id))
    .map((n) => ({ from: n.parent_id!, to: n.id, kind: "contains" }));

  const dependsOn = graph.edges.filter(
    (e) => e.kind === "depends_on" && keep.has(e.from) && keep.has(e.to) && byId.has(e.from),
  );

  return { version: graph.version, nodes, edges: [...containsEdges, ...dependsOn] };
}
