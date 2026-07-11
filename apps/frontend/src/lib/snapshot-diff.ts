/**
 * Turn a docs-snapshot diff (GP-40) into a synthetic graph the existing
 * GraphCanvas can render directly — reusing all the ELK layout + change-colour
 * machinery instead of a bespoke compare renderer.
 *
 * Mapping onto the `change` field the canvas already colours:
 *   added   → "create" (green)
 *   removed → "delete" (red dashed) — injected as standalone "ghost" nodes,
 *             positioned by the same ELK pass (no edges, so they float free)
 *   moved / unchanged → "noop" (neutral); moved is surfaced in the summary only
 */
import type { Graph, GraphNode, SnapshotDiff } from "@/api/types";

const isModule = (node: GraphNode): boolean => node.type === "module";

/** Build the compare graph: the target snapshot recoloured + removed ghosts. */
export function buildCompareGraph(target: Graph, diff: SnapshotDiff): Graph {
  const addedIds = new Set(diff.added.map((n) => n.id));

  const nodes: GraphNode[] = target.nodes.map((node) => {
    if (isModule(node)) return { ...node, change: null };
    return { ...node, change: addedIds.has(node.id) ? "create" : "noop" };
  });

  // Inject each removed resource as a red dashed ghost (no edges → floats).
  for (const removed of diff.removed) {
    nodes.push({
      id: removed.id,
      name: removed.name,
      type: removed.type,
      provider: null,
      module_path: [],
      change: "delete",
    });
  }

  // Keep only target edges whose endpoints still exist (ghosts have none).
  const present = new Set(nodes.map((n) => n.id));
  const edges = target.edges.filter((e) => present.has(e.from) && present.has(e.to));

  return { version: 2, nodes, edges };
}

/** Whether a diff has anything to show. */
export function diffIsEmpty(diff: SnapshotDiff): boolean {
  return diff.added.length === 0 && diff.removed.length === 0 && diff.moved.length === 0;
}
