/**
 * The static-diff producer (GP-153): `diff(before, after)` — two docs
 * snapshots of the same Terraform in, the "after" graph annotated the way a
 * plan snapshot would be out: `change` on every node, deleted nodes re-added
 * as ghosts carrying their former edges, GP-32-shaped attribute before/after
 * rows, and GP-22 impact propagation. A renderer that knows the PR view needs
 * to learn nothing new.
 *
 * Matching is by Terraform address — the stable key everywhere in Groundplan.
 * A rename is therefore a delete + a create, by design; heuristic matching is
 * a later story. Content comparison uses the canonical attribute form
 * (`canonicalize.ts`), so formatting-only edits are `noop` by construction.
 *
 * It is not the plan flow and never claims to be: no state, no count/for_each
 * expansion, no computed values. The UI wears that caption permanently.
 */
import type {
  ChangeKind,
  Graph,
  GraphEdge,
  GraphNode,
} from "@groundplan/graph-parser";

import { computeAttributeDiff } from "./attribute-diff.js";
import { canonicalAttributes } from "./canonicalize.js";
import { propagateImpact } from "./impact.js";

const compareStrings = (a: string, b: string): number => {
  if (a < b) return -1;
  return a > b ? 1 : 0;
};

/** Are two canonical attribute maps identical? */
function sameAttributes(
  before: Record<string, string>,
  after: Record<string, string>,
): boolean {
  const keys = new Set([...Object.keys(before), ...Object.keys(after)]);
  for (const key of keys) if (before[key] !== after[key]) return false;
  return true;
}

/** The GP-32 rows for a change, from the two canonical bags. */
function diffRows(
  before: Record<string, string> | undefined,
  after: Record<string, string> | undefined,
  kind: ChangeKind,
): Pick<GraphNode, "attribute_diff" | "attribute_diff_truncated"> {
  const { rows, truncated } = computeAttributeDiff({ before, after }, kind);
  if (rows.length === 0) return {};
  return {
    attribute_diff: rows,
    ...(truncated ? { attribute_diff_truncated: true } : {}),
  };
}

/**
 * Annotate `after` against `before`. Pure; safe on every debounced keystroke.
 */
export function diff(before: Graph, after: Graph): Graph {
  const beforeById = new Map(before.nodes.map((node) => [node.id, node]));
  const afterIds = new Set(after.nodes.map((node) => node.id));

  const nodes: GraphNode[] = after.nodes.map((node) => {
    const prior = beforeById.get(node.id);
    const bag = canonicalAttributes(node);
    if (!prior) {
      return { ...node, change: "create", ...diffRows(undefined, bag, "create") };
    }
    const priorBag = canonicalAttributes(prior);
    if (sameAttributes(priorBag, bag)) return { ...node, change: "noop" };
    return { ...node, change: "update", ...diffRows(priorBag, bag, "update") };
  });

  // Ghosts: what the edit removed, back on the diagram so the removal is
  // reviewable — with the attributes it had, as delete rows.
  const ghostIds = new Set<string>();
  for (const node of before.nodes) {
    if (afterIds.has(node.id)) continue;
    ghostIds.add(node.id);
    nodes.push({
      ...node,
      change: "delete",
      ...diffRows(canonicalAttributes(node), undefined, "delete"),
    });
  }

  // The after graph's edges, plus the former edges that made sense of a ghost.
  // A before-edge between two surviving nodes is *not* revived — if the code no
  // longer states it, drawing it would show a dependency the change removed.
  const present = new Set(nodes.map((node) => node.id));
  const edges: GraphEdge[] = [];
  const seen = new Set<string>();
  const push = (edge: GraphEdge): void => {
    if (!present.has(edge.from) || !present.has(edge.to)) return;
    const key = `${edge.kind} ${edge.from} ${edge.to}`;
    if (seen.has(key)) return;
    seen.add(key);
    edges.push(edge);
  };
  for (const edge of after.edges) push(edge);
  for (const edge of before.edges) {
    if (ghostIds.has(edge.from) || ghostIds.has(edge.to)) push(edge);
  }

  const annotated = propagateImpact({ version: after.version, nodes, edges });
  return {
    version: Math.max(3, after.version) as Graph["version"],
    nodes: annotated.nodes.toSorted((a, b) => compareStrings(a.id, b.id)),
    edges: annotated.edges.toSorted(
      (a, b) =>
        compareStrings(a.kind, b.kind) ||
        compareStrings(a.from, b.from) ||
        compareStrings(a.to, b.to),
    ),
  };
}

/** True when a diff found nothing: every node is `noop` (ghosts are not). */
export function isAllNoop(graph: Graph): boolean {
  return graph.nodes.every((node) => node.change === "noop");
}
