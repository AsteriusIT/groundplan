/**
 * Change colours without a plan (GP-103): given the graph of a base (what main
 * says) and the graph of a head (what a pull request would make main say), colour
 * the head — created, updated, deleted, unchanged — and hand back an ordinary
 * GraphSnapshot the renderer already knows how to draw.
 *
 * Terraform never needs this: `terraform plan` *is* the answer, and Producer A
 * reads the colours straight out of it (GP-13). Kubernetes has no such artefact —
 * `kubectl diff` needs a live cluster, whose credentials we deliberately do not
 * hold — so the honest way to say "what would this pull request do" is to compare
 * what the repository says now against what it would say. That is what this does,
 * and the snapshot records the base it compared against, because a diff you cannot
 * name the other side of is not a diff, it is an assertion.
 *
 * It is **not** `diff.ts` (GP-40), and the two are not merged. That one answers a
 * question for a person ("what appeared since last week, what moved module") and
 * pairs a create with a delete of the same bare address to call it a *move*. Here
 * the same pairing would be a bug: a workload deleted from `staging` and one
 * created in `prod` share a bare address and are not the same object moving, and
 * "move" is not a colour a renderer has. Same inputs, different question, and
 * forcing one function to answer both would make each answer worse.
 */
import { computeAttributeDiff } from "./attribute-diff.js";
import type { ChangeKind, Graph, GraphEdge, GraphNode } from "./graph.js";

/** What a node's content is compared by. Absent (a Terraform node) → nothing. */
function attributesOf(node: GraphNode): Record<string, string> {
  return node.attributes ?? {};
}

/**
 * Did anything about this object change?
 *
 * Note what this cannot see: a Secret's *values* are masked identically on both
 * sides (`(sensitive)` — see the mapper), so rotating a password is invisible
 * here, while adding or removing one of its keys is not. That is the price of
 * never holding the value, and it is the right way round: a product whose trust
 * model is "we ingest data, not access" does not get to keep a hash of your
 * password so that its diagram can be more interesting.
 */
function changed(base: GraphNode, head: GraphNode): boolean {
  const before = attributesOf(base);
  const after = attributesOf(head);
  const keys = new Set([...Object.keys(before), ...Object.keys(after)]);
  for (const key of keys) if (before[key] !== after[key]) return true;
  return false;
}

/** The attribute rows for a change, computed from the two flattened bags. */
function diffRows(
  base: GraphNode | undefined,
  head: GraphNode | undefined,
  kind: ChangeKind,
): Pick<GraphNode, "attribute_diff" | "attribute_diff_truncated"> {
  const { rows, truncated } = computeAttributeDiff(
    {
      before: base ? attributesOf(base) : undefined,
      after: head ? attributesOf(head) : undefined,
    },
    kind,
  );
  if (rows.length === 0) return {};
  return {
    attribute_diff: rows,
    ...(truncated ? { attribute_diff_truncated: true } : {}),
  };
}

/**
 * Colour `head` against `base`. A missing base (a repository's first pull request,
 * or one whose main branch has no diagram yet) means everything in the head is
 * new — which is true, and is not the same as nothing having changed.
 *
 * Deleted nodes come back onto the graph, carrying the edges that made sense of
 * them: a diagram that drops what a pull request removes shows you everything
 * except the part worth reviewing.
 */
export function changesFromBase(base: Graph | null, head: Graph): Graph {
  const baseNodes = new Map((base?.nodes ?? []).map((node) => [node.id, node]));
  const headNodes = new Map(head.nodes.map((node) => [node.id, node]));

  const nodes: GraphNode[] = head.nodes.map((node) => {
    const before = baseNodes.get(node.id);
    if (!before) {
      return { ...node, change: "create" as const, ...diffRows(undefined, node, "create") };
    }
    if (!changed(before, node)) return { ...node, change: "noop" as const };
    return { ...node, change: "update" as const, ...diffRows(before, node, "update") };
  });

  for (const node of baseNodes.values()) {
    if (headNodes.has(node.id)) continue;
    nodes.push({ ...node, change: "delete" as const, ...diffRows(node, undefined, "delete") });
  }

  // Edges of both graphs, kept only where both ends are still on the diagram —
  // the same rule the mapper draws by. A deleted workload keeps the line to the
  // config it read; a line to something that was never there is not drawn.
  const present = new Set(nodes.map((node) => node.id));
  const edges: GraphEdge[] = [];
  const seen = new Set<string>();
  for (const edge of [...head.edges, ...(base?.edges ?? [])]) {
    if (!present.has(edge.from) || !present.has(edge.to)) continue;
    const key = `${edge.kind} ${edge.from} ${edge.to}`;
    if (seen.has(key)) continue;
    seen.add(key);
    edges.push(edge);
  }

  return {
    version: 7,
    nodes: nodes.sort((a, b) => a.id.localeCompare(b.id)),
    edges: edges.sort(
      (a, b) =>
        a.kind.localeCompare(b.kind) ||
        a.from.localeCompare(b.from) ||
        a.to.localeCompare(b.to),
    ),
  };
}
