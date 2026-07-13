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

/** The bucket ungrouped resources fall into once there are too many to draw. */
export const UNGROUPED_ID = "group:ungrouped";

/**
 * How many ungrouped resources C4 will still draw individually. Above this they
 * collapse into one "Ungrouped (n)" node: a handful of loose resources is useful
 * detail, forty of them is the very noise the view exists to remove.
 */
export const UNGROUPED_INLINE_MAX = 5;

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

/** Rename and note annotations decorate the nodes they are anchored to. */
function decorate(
  surviving: Map<string, GraphNode>,
  renames: AdaptableAnnotation[],
  notes: AdaptableAnnotation[],
): void {
  for (const rename of renames) {
    const target = surviving.get(rename.anchors[0] ?? "");
    if (target && rename.label) target.display_label = rename.label;
  }
  for (const note of notes) {
    const target = surviving.get(note.anchors[0] ?? "");
    if (!target || !note.body) continue;
    target.notes = [...(target.notes ?? []), note.body];
  }
}

/**
 * Which groups still hold something. A group survives iff it has a member node
 * that was not hidden, or a nested child group that itself survived — an empty
 * frame is not structure, it is a labelled hole.
 *
 * Groups nest one level (GP-71), so one bottom-up pass settles it: judge the
 * childless groups, then the parents that may be held up by them.
 */
function survivingGroupIds(
  groups: AdaptableAnnotation[],
  childrenOf: ReadonlyMap<string, AdaptableAnnotation[]>,
  hasLiveMember: (group: AdaptableAnnotation) => boolean,
): Set<string> {
  const alive = new Set<string>();
  for (const group of groups) {
    if (!childrenOf.has(group.id) && hasLiveMember(group)) alive.add(group.id);
  }
  for (const group of groups) {
    if (!childrenOf.has(group.id)) continue;
    const holdsAChild = (childrenOf.get(group.id) ?? []).some((c) => alive.has(c.id));
    if (hasLiveMember(group) || holdsAChild) alive.add(group.id);
  }
  return alive;
}

/** Group annotations indexed by their parent, ignoring parents that are not groups. */
function groupChildren(
  groups: AdaptableAnnotation[],
): Map<string, AdaptableAnnotation[]> {
  const groupById = new Map(groups.map((g) => [g.id, g]));
  const childrenOf = new Map<string, AdaptableAnnotation[]>();
  for (const group of groups) {
    // A parent that is not itself an accepted group is no parent at all.
    const parentId = group.parentGroupId;
    if (!parentId || !groupById.has(parentId)) continue;
    childrenOf.set(parentId, [...(childrenOf.get(parentId) ?? []), group]);
  }
  return childrenOf;
}

/**
 * Add a container node per surviving group and re-parent its members into it.
 * Returns the `contains` edges to add, and the members that were re-parented —
 * they must lose their module container, or the render tree would give them two.
 */
function injectGroupContainers(input: {
  groups: AdaptableAnnotation[];
  survivingGroups: ReadonlySet<string>;
  surviving: Map<string, GraphNode>;
  liveMembers: (group: AdaptableAnnotation) => string[];
}): { containerEdges: GraphEdge[]; regrouped: Set<string> } {
  const { groups, survivingGroups, surviving, liveMembers } = input;
  const containerEdges: GraphEdge[] = [];
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
      containerEdges.push({ from: groupNodeId(parentId), to: id, kind: "contains" });
    }
  }
  return { containerEdges, regrouped };
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
  const byType = (type: AdaptableAnnotation["type"]) =>
    accepted.filter((a) => a.type === type);

  // --- 1. Hide: the node, and everything that touched it, is simply not here.
  const hidden = new Set(byType("hide").flatMap((a) => a.anchors));

  const surviving = new Map<string, GraphNode>();
  for (const node of graph.nodes) {
    if (!hidden.has(node.id)) surviving.set(node.id, { ...node });
  }

  // --- 2. Rename / note: decorate the nodes that survived.
  decorate(surviving, byType("rename"), byType("note"));

  // --- 3. Groups: container nodes, with their members reparented into them.
  const groups = byType("group");
  const childrenOf = groupChildren(groups);
  const liveMembers = (group: AdaptableAnnotation): string[] =>
    group.anchors.filter((anchor) => surviving.has(anchor));
  const survivingGroups = survivingGroupIds(
    groups,
    childrenOf,
    (g) => liveMembers(g).length > 0,
  );

  const { containerEdges, regrouped } = injectGroupContainers({
    groups,
    survivingGroups,
    surviving,
    liveMembers,
  });

  // --- 4. Structural edges: keep what still has both ends, minus the module
  // `contains` edges the groups took over.
  const structural = graph.edges.filter((edge) => {
    if (!surviving.has(edge.from) || !surviving.has(edge.to)) return false;
    return !(edge.kind === "contains" && regrouped.has(edge.to));
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

// --- C4: group granularity (GP-77) -------------------------------------------

export type CollapseOptions = {
  /** Annotation id of the one group to leave open. Everything else collapses. */
  expandGroup?: string;
};

/** A node's identity in the collapsed graph: itself, or the group that swallowed it. */
type Representatives = ReadonlyMap<string, string>;

/** The resource nodes a group holds, following its child groups down. */
function resourcesOf(
  groupId: string,
  childrenOf: ReadonlyMap<string, string[]>,
  isGroup: (id: string) => boolean,
  isModuleId: (id: string) => boolean,
): string[] {
  const out: string[] = [];
  for (const child of childrenOf.get(groupId) ?? []) {
    if (isGroup(child)) out.push(...resourcesOf(child, childrenOf, isGroup, isModuleId));
    else if (!isModuleId(child)) out.push(child);
  }
  return out;
}

/** A group as a single point: its name, what it holds, and the notes inside it. */
function collapsedNode(
  group: GraphNode,
  members: string[],
  byId: ReadonlyMap<string, GraphNode>,
): GraphNode {
  const notes = members.flatMap((id) => byId.get(id)?.notes ?? []);
  return {
    ...group,
    member_count: members.length,
    ...(notes.length > 0 ? { notes } : {}),
  };
}

/**
 * Collapse an adapted graph to **group granularity** — the C4 view (GP-77).
 *
 * Each top-level group becomes one node (a C4 system); the edges between two
 * groups' members are aggregated into a single edge carrying how many underlying
 * dependencies it stands for; edges *inside* a group disappear, because at this
 * altitude they are internal detail.
 *
 * Two judgement calls, both about not trading one kind of noise for another:
 *
 *   - **Module containers are dropped.** C4 is a picture of the systems a human
 *     declared, not of how the Terraform happens to be filed. A module box here
 *     would be answering a question nobody asked at this zoom level.
 *   - **Ungrouped resources** are drawn individually while there are few enough
 *     to be useful (≤ 5), and collapse into one "Ungrouped (n)" node beyond that.
 *     A handful of loose resources is a to-do list; forty of them is the very
 *     noise this view exists to remove.
 *
 * `expandGroup` opens exactly one group in place, leaving its siblings collapsed
 * — the drill-down, which is a way of *looking*, not a different projection.
 *
 * Pure and deterministic, like everything else here.
 */
export function collapseToGroups(graph: Graph, opts: CollapseOptions = {}): Graph {
  const byId = new Map(graph.nodes.map((n) => [n.id, n]));
  const isGroup = (id: string) => byId.get(id)?.annotation_group === true;
  const isModuleId = (id: string) => byId.get(id)?.type === "module";

  // Group containment only — a module `contains` edge says nothing at this altitude.
  const childrenOf = new Map<string, string[]>();
  const parentOf = new Map<string, string>();
  for (const edge of graph.edges) {
    if (edge.kind !== "contains" || !isGroup(edge.from)) continue;
    childrenOf.set(edge.from, [...(childrenOf.get(edge.from) ?? []), edge.to]);
    parentOf.set(edge.to, edge.from);
  }

  const topGroups = graph.nodes.filter((n) => n.annotation_group && !parentOf.has(n.id));
  const expandedId = opts.expandGroup ? groupNodeId(opts.expandGroup) : null;
  const members = (id: string) => resourcesOf(id, childrenOf, isGroup, isModuleId);

  const nodes: GraphNode[] = [];
  const containerEdges: GraphEdge[] = [];
  const rep = new Map<string, string>();

  for (const group of topGroups) {
    if (group.id === expandedId) {
      // Opened in place: keep the frame, and show what is directly inside it —
      // its resources as themselves, its child groups still collapsed.
      nodes.push({ ...group });
      rep.set(group.id, group.id);
      for (const child of childrenOf.get(group.id) ?? []) {
        containerEdges.push({ from: group.id, to: child, kind: "contains" });
        if (isGroup(child)) {
          const inner = members(child);
          nodes.push(collapsedNode(byId.get(child)!, inner, byId));
          rep.set(child, child);
          for (const id of inner) rep.set(id, child);
          continue;
        }
        const node = byId.get(child);
        if (node) {
          nodes.push({ ...node });
          rep.set(child, child);
        }
      }
      continue;
    }

    const held = members(group.id);
    nodes.push(collapsedNode(group, held, byId));
    rep.set(group.id, group.id);
    for (const id of held) rep.set(id, group.id);
    for (const child of childrenOf.get(group.id) ?? []) {
      if (isGroup(child)) rep.set(child, group.id);
    }
  }

  // Whatever nobody grouped. Modules are not resources — they are filing.
  const ungrouped = graph.nodes.filter(
    (n) => !rep.has(n.id) && !n.annotation_group && n.type !== "module",
  );
  if (ungrouped.length > UNGROUPED_INLINE_MAX) {
    nodes.push({
      id: UNGROUPED_ID,
      name: "Ungrouped",
      type: "group",
      provider: null,
      module_path: [],
      change: null,
      annotation_group: true,
      member_count: ungrouped.length,
    });
    for (const node of ungrouped) rep.set(node.id, UNGROUPED_ID);
  } else {
    for (const node of ungrouped) {
      nodes.push({ ...node });
      rep.set(node.id, node.id);
    }
  }

  return sortGraph(nodes, [...aggregateEdges(graph.edges, rep), ...containerEdges]);
}

/**
 * Lift every edge to the collapsed graph and merge the duplicates that fall out.
 * Ten resources in "Storefront" talking to eight in "Data" is *one* relationship
 * at this altitude — drawn once, carrying the count, so the aggregate is visible
 * rather than implied by a thicket of parallel lines.
 *
 * Edges within a single collapsed node vanish: they are internal detail. Kind is
 * part of the key, so a logical edge is never merged into a structural one — a
 * relationship a human asserted and one the code declares are different claims.
 */
function aggregateEdges(edges: GraphEdge[], rep: Representatives): GraphEdge[] {
  type Agg = { from: string; to: string; kind: GraphEdge["kind"]; count: number; labels: Set<string> };
  const merged = new Map<string, Agg>();

  for (const edge of edges) {
    if (edge.kind === "contains") continue; // structure is rebuilt, not carried
    const from = rep.get(edge.from);
    const to = rep.get(edge.to);
    if (!from || !to || from === to) continue;

    const key = `${edge.kind}|${from}|${to}`;
    const existing = merged.get(key);
    if (existing) {
      existing.count += 1;
      if (edge.label) existing.labels.add(edge.label);
      continue;
    }
    merged.set(key, {
      from,
      to,
      kind: edge.kind,
      count: 1,
      labels: new Set(edge.label ? [edge.label] : []),
    });
  }

  return [...merged.values()].map(({ from, to, kind, count, labels }) => {
    // One label survives a merge only when it is the only thing being said.
    // Otherwise the honest label is how many relationships this line stands for.
    const label =
      labels.size === 1 && count === 1 ? [...labels][0] : count > 1 ? `×${count}` : undefined;
    return {
      from,
      to,
      kind,
      ...(count > 1 ? { count } : {}),
      ...(label ? { label } : {}),
    };
  });
}
