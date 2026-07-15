/**
 * Impact propagation (GP-22): blast radius, deterministically. Mark unchanged
 * (`noop`) nodes that depend — directly or transitively — on a changed node as
 * `impacted`, tagged with the hop distance to the nearest changed node. Pure
 * graph traversal, no AI. Runs at the end of plan snapshot production.
 *
 * v1 scope (documented): only *dependents of changed nodes* are impacted. A
 * delete does not additionally propagate to its dependencies' dependents; richer
 * semantic impact is a later epic.
 */
import type { Graph, GraphNode } from "./graph.js";

const CHANGED = new Set<GraphNode["change"]>(["create", "update", "delete"]);

/**
 * Return a v2 graph with `impacted` / `impact_distance` set on the unchanged
 * nodes that transitively depend on a changed node.
 */
export function propagateImpact(graph: Graph): Graph {
  // Reverse the depends_on edges: dependentsOf[B] = nodes that depend on B.
  const dependentsOf = new Map<string, string[]>();
  for (const edge of graph.edges) {
    if (edge.kind !== "depends_on") continue;
    const list = dependentsOf.get(edge.to);
    if (list) list.push(edge.from);
    else dependentsOf.set(edge.to, [edge.from]);
  }

  // Multi-source BFS seeded from every changed node (distance 0). A visited
  // (distance) map both records the shortest hop count and breaks cycles.
  const distance = new Map<string, number>();
  const queue: string[] = [];
  for (const node of graph.nodes) {
    if (CHANGED.has(node.change)) {
      distance.set(node.id, 0);
      queue.push(node.id);
    }
  }
  for (const id of queue) {
    const next = distance.get(id)! + 1;
    for (const dependent of dependentsOf.get(id) ?? []) {
      if (!distance.has(dependent)) {
        distance.set(dependent, next);
        queue.push(dependent);
      }
    }
  }

  const nodes = graph.nodes.map((node) => {
    const d = distance.get(node.id);
    if (node.change === "noop" && d !== undefined && d > 0) {
      return { ...node, impacted: true, impact_distance: d };
    }
    return node;
  });

  return { ...graph, version: 2, nodes };
}
