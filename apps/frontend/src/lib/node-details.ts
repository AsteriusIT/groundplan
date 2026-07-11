/**
 * Deterministic derivations for the node detail panel (GP-33). Everything here is
 * pure graph traversal over the snapshot — no AI, no invented data.
 */
import type { Graph, GraphNode } from "@/api/types";

const CHANGED = new Set(["create", "update", "delete"]);

/** The resources a node depends on, and the resources that depend on it. */
export interface Connections {
  dependencies: GraphNode[];
  dependents: GraphNode[];
}

/** Split a node's `depends_on` edges into its dependencies and dependents. */
export function connectionsOf(graph: Graph, nodeId: string): Connections {
  const byId = new Map(graph.nodes.map((n) => [n.id, n]));
  const depIds = new Set<string>();
  const dependentIds = new Set<string>();
  for (const edge of graph.edges) {
    if (edge.kind !== "depends_on") continue;
    if (edge.from === nodeId) depIds.add(edge.to);
    else if (edge.to === nodeId) dependentIds.add(edge.from);
  }
  const resolve = (ids: Set<string>): GraphNode[] =>
    [...ids]
      .map((id) => byId.get(id))
      .filter((n): n is GraphNode => n !== undefined)
      .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return { dependencies: resolve(depIds), dependents: resolve(dependentIds) };
}

/** The nearest changed resource this node (transitively) depends on. */
export interface ChangedAncestor {
  node: GraphNode;
  distance: number;
  /** The direct dependency on the path to `node` (equals `node` at distance 1). */
  firstHop: GraphNode;
}

/**
 * Why is an unchanged node impacted? Breadth-first over `depends_on` edges in the
 * dependency direction, returning the nearest changed resource it reaches. The
 * distance matches the node's stored `impact_distance` (GP-22). Deterministic:
 * adjacency is sorted, so ties resolve by id.
 */
export function nearestChangedAncestor(
  graph: Graph,
  nodeId: string,
): ChangedAncestor | null {
  const byId = new Map(graph.nodes.map((n) => [n.id, n]));
  const deps = new Map<string, string[]>();
  for (const edge of graph.edges) {
    if (edge.kind !== "depends_on") continue;
    const list = deps.get(edge.from);
    if (list) list.push(edge.to);
    else deps.set(edge.from, [edge.to]);
  }
  for (const list of deps.values()) list.sort();

  const distance = new Map<string, number>([[nodeId, 0]]);
  const firstHop = new Map<string, string>();
  const queue: string[] = [nodeId];
  for (let head = 0; head < queue.length; head++) {
    const current = queue[head] as string;
    const d = distance.get(current) as number;
    for (const next of deps.get(current) ?? []) {
      if (distance.has(next)) continue;
      distance.set(next, d + 1);
      firstHop.set(next, current === nodeId ? next : (firstHop.get(current) as string));
      const node = byId.get(next);
      if (node && CHANGED.has(node.change ?? "")) {
        return {
          node,
          distance: d + 1,
          firstHop: byId.get(firstHop.get(next) as string) as GraphNode,
        };
      }
      queue.push(next);
    }
  }
  return null;
}
