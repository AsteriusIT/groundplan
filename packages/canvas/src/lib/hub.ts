/**
 * Hub detection + hub-edge visibility rules (GP-35). A hub's edges are true but
 * carry no reading value (a resource_group fanning out to ~80 resources is a
 * wall in any layout), so they are hidden by default and revealed on demand:
 *   - the toggle "Show hub connections" reveals every hub edge, or
 *   - selecting a node reveals the hub edges that touch it (so "depends on
 *     resource_group" is never lost for the node you're looking at).
 */
import type { Graph, GraphEdge } from "../types";
import { HUB_DEGREE_THRESHOLD, HUB_TYPES } from "../lib/hub-config";

const isModule = (type: string): boolean => type === "module";

/** Ids of the hub nodes: high dependency degree, or a known fan-out type. */
export function detectHubs(graph: Graph): Set<string> {
  const degree = new Map<string, number>();
  for (const edge of graph.edges) {
    if (edge.kind !== "depends_on") continue;
    degree.set(edge.from, (degree.get(edge.from) ?? 0) + 1);
    degree.set(edge.to, (degree.get(edge.to) ?? 0) + 1);
  }

  const hubs = new Set<string>();
  for (const node of graph.nodes) {
    if (isModule(node.type)) continue;
    const highDegree = (degree.get(node.id) ?? 0) > HUB_DEGREE_THRESHOLD;
    if (highDegree || HUB_TYPES.has(node.type)) hubs.add(node.id);
  }
  return hubs;
}

/** Is this a depends_on edge touching a hub (a candidate for hiding)? */
export function isHubEdge(edge: GraphEdge, hubs: ReadonlySet<string>): boolean {
  return edge.kind === "depends_on" && (hubs.has(edge.from) || hubs.has(edge.to));
}

/** Should a hub edge be drawn, given the toggle and the current selection? */
export function hubEdgeRevealed(
  edge: GraphEdge,
  selectedId: string | null,
  showHubEdges: boolean,
): boolean {
  if (showHubEdges) return true;
  return selectedId !== null && (edge.from === selectedId || edge.to === selectedId);
}
