/**
 * Node, edge and change counts over a snapshot.
 *
 * Deliberately its own module, with nothing but type imports. It used to live
 * beside the JSON Schema validator, which meant reaching for a count dragged
 * Ajv along — and Ajv builds validators with `new Function`, which a webview's
 * CSP forbids. A pure fold has no business being that hard to import.
 */
import type { Graph } from "./graph.js";

export type GraphStats = {
  nodes: number;
  edges: number;
  /** How many of the `depends_on` edges were expression-inferred (GP-20). */
  inferredEdges: number;
  /** How many unchanged nodes are impacted by the change set (GP-22). */
  impactedCount: number;
  changes: {
    create: number;
    update: number;
    delete: number;
    noop: number;
    /** Nodes with a null `change` (module nodes, docs-flow snapshots). */
    unchanged: number;
  };
};

/** Node/edge/change counts, computed once and stored alongside the snapshot. */
export function computeGraphStats(graph: Graph): GraphStats {
  const changes = { create: 0, update: 0, delete: 0, noop: 0, unchanged: 0 };
  for (const node of graph.nodes) {
    if (node.change === null) changes.unchanged += 1;
    else changes[node.change] += 1;
  }
  const inferredEdges = graph.edges.filter((e) => e.inferred === true).length;
  const impactedCount = graph.nodes.filter((n) => n.impacted === true).length;
  return {
    nodes: graph.nodes.length,
    edges: graph.edges.length,
    inferredEdges,
    impactedCount,
    changes,
  };
}
