/**
 * Server-side IAM-view projection for exports. The app's IAM view is a table
 * (canvas `toIamRows`); an export wants a diagram, so the same rows become a
 * grant graph: one node per principal and per scope, one labelled edge per
 * role assignment. Principals/scopes that resolve to a snapshot node keep that
 * node (type, icon, change); anything else becomes a synthetic `principal` /
 * `scope` node. The assignment resource itself is the edge, not a node.
 */
import type { Graph, GraphEdge, GraphNode } from "./graph.js";

function synthetic(id: string, type: "principal" | "scope"): GraphNode {
  return { id, name: id, type, provider: null, module_path: [], change: null };
}

/** Project a graph to its IAM grant view. */
export function iamViewGraph(graph: Graph): Graph {
  const byId = new Map(graph.nodes.map((n) => [n.id, n]));
  const nodes = new Map<string, GraphNode>();
  const edges: GraphEdge[] = [];

  for (const node of graph.nodes) {
    const ra = node.role_assignment;
    if (!ra) continue;
    nodes.set(ra.principal, byId.get(ra.principal) ?? synthetic(ra.principal, "principal"));
    nodes.set(ra.scope, byId.get(ra.scope) ?? synthetic(ra.scope, "scope"));
    // Emitted scope→principal: the converter reverses depends_on (GP-31), so
    // the drawn arrow reads principal → scope — "granted role on".
    edges.push({
      from: ra.scope,
      to: ra.principal,
      kind: "depends_on",
      label: node.privileged ? `${ra.role} — privileged` : ra.role,
    });
  }

  return { version: graph.version, nodes: [...nodes.values()], edges };
}
