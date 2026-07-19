/**
 * The "changed only" lens (GP-154): a diffed graph reduced to what changed
 * plus one hop of context — enough to see where a change sits, without the
 * unchanged estate around it. A pure fold; the renderer draws the result as
 * an ordinary (smaller) snapshot.
 */
import type { Graph } from "@groundplan/graph-parser";

const CHANGED = new Set(["create", "update", "delete"]);

/** Keep changed nodes and their direct neighbors (any edge kind, both ways). */
export function changedOnly(graph: Graph): Graph {
  // Expand from a frozen seed set, or a chain of edges would walk two hops.
  const seeds = new Set<string>();
  for (const node of graph.nodes) {
    if (node.change !== null && CHANGED.has(node.change)) seeds.add(node.id);
  }
  const keep = new Set(seeds);
  for (const edge of graph.edges) {
    if (seeds.has(edge.from)) keep.add(edge.to);
    if (seeds.has(edge.to)) keep.add(edge.from);
  }
  return {
    ...graph,
    nodes: graph.nodes.filter((node) => keep.has(node.id)),
    edges: graph.edges.filter((edge) => keep.has(edge.from) && keep.has(edge.to)),
  };
}
