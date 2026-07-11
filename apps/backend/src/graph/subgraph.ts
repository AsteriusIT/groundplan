/**
 * "Changes only" subgraph (GP-37 `?scope=changes`): the changed and impacted
 * nodes plus their 1-hop neighbours — small enough to embed in a PR comment,
 * still enough context to read. Module containers of included resources come
 * along so nesting survives. Pure set selection; node/edge order is preserved
 * for deterministic layout + rendering.
 */
import type { Graph, GraphNode } from "./graph.js";

const isModule = (node: GraphNode): boolean => node.type === "module";

const isChangedOrImpacted = (node: GraphNode): boolean =>
  node.change === "create" ||
  node.change === "update" ||
  node.change === "delete" ||
  node.impacted === true;

/**
 * Reduce a graph to the changed/impacted nodes, their direct dependency
 * neighbours, and the module containers that hold any of them.
 */
export function changesSubgraph(graph: Graph): Graph {
  const byId = new Map(graph.nodes.map((n) => [n.id, n]));

  // Seed: every changed or impacted resource.
  const keep = new Set<string>();
  for (const node of graph.nodes) {
    if (!isModule(node) && isChangedOrImpacted(node)) keep.add(node.id);
  }

  // Grow by one dependency hop in either direction.
  for (const edge of graph.edges) {
    if (edge.kind !== "depends_on") continue;
    if (keep.has(edge.from)) keep.add(edge.to);
    else if (keep.has(edge.to)) keep.add(edge.from);
  }

  // Pull in the module containers of everything kept (walk contains-parents up).
  const parentOf = new Map<string, string>();
  for (const edge of graph.edges) {
    if (edge.kind === "contains") parentOf.set(edge.to, edge.from);
  }
  for (const id of [...keep]) {
    let parent = parentOf.get(id);
    while (parent && !keep.has(parent)) {
      keep.add(parent);
      parent = parentOf.get(parent);
    }
  }

  const nodes = graph.nodes.filter((n) => keep.has(n.id));
  const edges = graph.edges.filter((e) => keep.has(e.from) && keep.has(e.to) && byId.has(e.from));

  return { version: graph.version, nodes, edges };
}
