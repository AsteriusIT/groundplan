/**
 * GP-72: the **adapted** projection — the generated graph seen through the
 * annotation layer.
 *
 * The whole point of ADR #2 is that renderers consume one shape. So an adapted
 * diagram is not a new kind of thing the frontend must learn: it is a plain
 * `Graph`, produced here by folding a repository's accepted annotations into the
 * generated one. Groups become container nodes, hidden nodes (and their edges)
 * disappear, logical edges are drawn in, renames become `display_label`, notes
 * ride on the node they describe.
 *
 * Pure and side-effect free — no DB, no I/O. Given the same snapshot and the
 * same annotations it returns a byte-identical graph, including ordering, which
 * is what makes it safe to render in CI.
 *
 * Only **accepted** annotations participate. A `proposed` suggestion (GP-75) has
 * not been agreed to and an `orphaned` one no longer has anywhere to attach, so
 * neither may bend the picture.
 */
import type { Graph, GraphEdge, GraphNode } from "./graph.js";

/** An annotation reduced to what the projection needs (mirrors `AnnotationRow`). */
export type AdaptableAnnotation = {
  id: string;
  type: "note" | "link" | "group" | "hide" | "rename";
  anchors: string[];
  label: string | null;
  body: string | null;
  status: "resolved" | "orphaned" | "proposed";
  parentGroupId: string | null;
};

/**
 * The node id of a group's container. Terraform addresses cannot contain a
 * colon, so this can never collide with a generated node.
 */
export const groupNodeId = (annotationId: string): string => `group:${annotationId}`;

const isModule = (node: GraphNode): boolean => node.type === "module";

/** Stable order: nodes by id, edges by kind then endpoints. Ordering is output. */
function sortGraph(nodes: GraphNode[], edges: GraphEdge[]): Graph {
  return {
    version: 5,
    nodes: [...nodes].sort((a, b) => a.id.localeCompare(b.id)),
    edges: [...edges].sort(
      (a, b) =>
        a.kind.localeCompare(b.kind) ||
        a.from.localeCompare(b.from) ||
        a.to.localeCompare(b.to),
    ),
  };
}

/**
 * Fold a repository's accepted annotations into a snapshot's graph.
 *
 * The one structural subtlety: a node has exactly one parent in the render tree,
 * so a node that joins a group **leaves its module box**. A module container that
 * is emptied this way is dropped rather than left behind as a labelled empty
 * frame — it is synthetic scaffolding, and the group is now the answer to "what
 * is this part of".
 */
export function projectAdapted(
  graph: Graph,
  annotations: AdaptableAnnotation[],
): Graph {
  const accepted = annotations.filter((a) => a.status === "resolved");
  const byType = <T extends AdaptableAnnotation["type"]>(type: T) =>
    accepted.filter((a) => a.type === type);

  // --- 1. Hide: the node, and everything that touched it, is simply not here.
  const hidden = new Set(byType("hide").flatMap((a) => a.anchors));

  const surviving = new Map<string, GraphNode>();
  for (const node of graph.nodes) {
    if (hidden.has(node.id)) continue;
    surviving.set(node.id, { ...node });
  }

  // --- 2. Rename / note: decorate the nodes that survived.
  for (const rename of byType("rename")) {
    const target = surviving.get(rename.anchors[0] ?? "");
    if (target && rename.label) target.display_label = rename.label;
  }
  for (const note of byType("note")) {
    const target = surviving.get(note.anchors[0] ?? "");
    if (!target || !note.body) continue;
    target.notes = [...(target.notes ?? []), note.body];
  }

  // --- 3. Groups: container nodes, with their members reparented into them.
  //
  // A group survives iff it still holds something — a member node that was not
  // hidden, or a nested child group that itself survived. Order the groups
  // parents-first so a child's survival is known before its parent is judged.
  const groups = byType("group");
  const groupById = new Map(groups.map((g) => [g.id, g]));
  const childrenOf = new Map<string, AdaptableAnnotation[]>();
  for (const group of groups) {
    // A parent that is not itself an accepted group is no parent at all.
    const parentId =
      group.parentGroupId && groupById.has(group.parentGroupId)
        ? group.parentGroupId
        : null;
    if (!parentId) continue;
    childrenOf.set(parentId, [...(childrenOf.get(parentId) ?? []), group]);
  }

  const liveMembers = (group: AdaptableAnnotation): string[] =>
    group.anchors.filter((anchor) => surviving.has(anchor));

  const survivingGroups = new Set<string>();
  // One level of nesting (GP-71), so a single bottom-up pass settles it: judge
  // the children, then the parents that may be held up by them.
  for (const group of groups) {
    if (childrenOf.has(group.id)) continue; // parents, next pass
    if (liveMembers(group).length > 0) survivingGroups.add(group.id);
  }
  for (const group of groups) {
    if (!childrenOf.has(group.id)) continue;
    const holdsAChild = (childrenOf.get(group.id) ?? []).some((c) =>
      survivingGroups.has(c.id),
    );
    if (liveMembers(group).length > 0 || holdsAChild) survivingGroups.add(group.id);
  }

  const containerEdges: GraphEdge[] = [];
  // The node ids that a group took ownership of — they must lose their module
  // parent, or the render tree would give them two.
  const regrouped = new Set<string>();

  for (const group of groups) {
    if (!survivingGroups.has(group.id)) continue;
    const id = groupNodeId(group.id);
    surviving.set(id, {
      id,
      name: group.label ?? "Group",
      type: "group",
      provider: null,
      module_path: [],
      change: null,
      annotation_group: true,
    });

    for (const member of liveMembers(group)) {
      containerEdges.push({ from: id, to: member, kind: "contains" });
      regrouped.add(member);
    }
    const parentId = group.parentGroupId;
    if (parentId && survivingGroups.has(parentId)) {
      containerEdges.push({
        from: groupNodeId(parentId),
        to: id,
        kind: "contains",
      });
    }
  }

  // --- 4. Structural edges: keep what still has both ends, minus the module
  // `contains` edges the groups took over.
  const structural = graph.edges.filter((edge) => {
    if (!surviving.has(edge.from) || !surviving.has(edge.to)) return false;
    if (edge.kind === "contains" && regrouped.has(edge.to)) return false;
    return true;
  });

  const edges = [...structural, ...containerEdges];

  // --- 5. Logical edges: what a human drew. Endpoints are addresses or groups.
  const endpointOf = (anchor: string): string | null => {
    if (survivingGroups.has(anchor)) return groupNodeId(anchor);
    return surviving.has(anchor) ? anchor : null;
  };
  for (const link of byType("link")) {
    const from = endpointOf(link.anchors[0] ?? "");
    const to = endpointOf(link.anchors[1] ?? "");
    if (!from || !to) continue; // an endpoint was hidden — draw nothing
    edges.push({
      from,
      to,
      kind: "logical",
      ...(link.label ? { label: link.label } : {}),
    });
  }

  // --- 6. Drop module containers that the regrouping emptied. Synthetic
  // scaffolding with nothing left inside is noise, not structure.
  const holdsSomething = new Set(
    edges.filter((e) => e.kind === "contains").map((e) => e.from),
  );
  const nodes = [...surviving.values()].filter((node) => {
    if (!isModule(node)) return true;
    // A module that never contained anything in the first place was already
    // being drawn (an empty module box is legitimate); only one we emptied goes.
    const emptiedByUs =
      graph.edges.some((e) => e.kind === "contains" && e.from === node.id) &&
      !holdsSomething.has(node.id);
    return !emptiedByUs;
  });

  const nodeIds = new Set(nodes.map((n) => n.id));
  const connected = edges.filter((e) => nodeIds.has(e.from) && nodeIds.has(e.to));

  return sortGraph(nodes, connected);
}
