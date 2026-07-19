/**
 * Node ↔ code resolution (GP-149), both directions, purely off the ranges the
 * last good snapshot already carries (`node.source`, GP-120) — no re-parsing,
 * no persistent mapping structures.
 */
import type { Graph, GraphNode, NodeSource } from "@groundplan/graph-parser";

/** Where a node's HCL block lives, or null (synthetic/module nodes). */
export function sourceOf(snapshot: Graph, address: string): NodeSource | null {
  return snapshot.nodes.find((n) => n.id === address)?.source ?? null;
}

/**
 * The resource whose block the cursor sits in (1-based line), or null for
 * comments, variables/outputs, unparsed files — anything the graph has no
 * node for. Overlapping spans resolve to the innermost (smallest) block.
 */
export function nodeAtPosition(
  snapshot: Graph,
  relPath: string,
  line: number,
): GraphNode | null {
  let best: GraphNode | null = null;
  let bestSpan = Number.POSITIVE_INFINITY;
  for (const node of snapshot.nodes) {
    const source = node.source;
    if (!source || source.file !== relPath) continue;
    if (line < source.start_line || line > source.end_line) continue;
    const span = source.end_line - source.start_line;
    if (span < bestSpan) {
      best = node;
      bestSpan = span;
    }
  }
  return best;
}
