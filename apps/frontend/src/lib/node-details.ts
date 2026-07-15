/**
 * Deterministic derivations for the node detail panel (GP-33). Everything here is
 * pure graph traversal over the snapshot — no AI, no invented data.
 */
import type { Graph, GraphNode, NsgRule } from "@/api/types";

const CHANGED = new Set(["create", "update", "delete"]);

const INTERNET_SOURCES = new Set(["*", "0.0.0.0/0", "internet"]);

/** One NSG rule paired with whether its source is an internet source (GP-45). */
export interface FlaggedRule {
  rule: NsgRule;
  internet: boolean;
}

/** A node's NSG rules sorted by priority, each flagged if internet-sourced. */
export function sortedRules(node: GraphNode): FlaggedRule[] {
  return [...(node.rules ?? [])]
    .sort((a, b) => a.priority - b.priority)
    .map((rule) => ({
      rule,
      internet: INTERNET_SOURCES.has(rule.source.trim().toLowerCase()),
    }));
}

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
      .sort((a, b) => {
        if (a.id < b.id) return -1;
        if (a.id > b.id) return 1;
        return 0;
      });
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
  for (const list of deps.values()) {
    list.sort((a, b) => {
      if (a < b) return -1;
      if (a > b) return 1;
      return 0;
    });
  }

  const distance = new Map<string, number>([[nodeId, 0]]);
  const firstHop = new Map<string, string>();
  const queue: string[] = [nodeId];
  for (const current of queue) {
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
