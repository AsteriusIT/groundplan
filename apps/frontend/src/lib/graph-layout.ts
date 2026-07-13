/**
 * Turn a GraphSnapshot graph into the elements React Flow renders, using ELK for
 * a layered hierarchical layout. Pure and side-effect free (the async ELK call
 * itself lives in the GraphCanvas component) so the mapping is unit-testable.
 *
 * `contains` edges become node nesting (module = container / group node);
 * `depends_on` edges become drawn edges between resources. Filters + neighbourhood
 * highlight (GP-24) are applied here as per-node/edge `dimmed` flags — a pure
 * data transform the node components render via CSS (no re-layout).
 */
import type { Edge as FlowEdge, Node as FlowNode } from "@xyflow/react";

import type { ChangeKind, Graph, GraphEdge, GraphNode } from "@/api/types";
import type { Point } from "@/lib/edge-path";
import { categorize, type Category } from "@/lib/resource-category";
import { hubEdgeRevealed, isHubEdge } from "@/lib/hub";

// changeLabel now lives with the shared status metadata (GP-28); re-exported here
// so existing importers (node-details-panel, …) keep working.
export { changeLabel } from "@/lib/status";

const RESOURCE_WIDTH = 220;
const RESOURCE_HEIGHT = 56;
const MODULE_LEAF_WIDTH = 200;
// Minimum footprint for an empty structural container (e.g. a subnet with no
// resources) so it still reads as a labelled frame (GP-44).
const EMPTY_CONTAINER_WIDTH = 200;
const EMPTY_CONTAINER_HEIGHT = 84;

/** One routed edge as ELK hands it back: endpoints plus its right-angle turns. */
export interface ElkEdgeSection {
  id: string;
  startPoint: Point;
  endPoint: Point;
  bendPoints?: Point[];
}

export interface ElkGraphEdge {
  id: string;
  sources: string[];
  targets: string[];
  /** Filled in by ELK when it has routed the edge (elk.edgeRouting). */
  sections?: ElkEdgeSection[];
}

/** Minimal shape of the ELK graph we send and get back (x/y/w/h filled in). */
export interface ElkGraphNode {
  id: string;
  width?: number;
  height?: number;
  x?: number;
  y?: number;
  layoutOptions?: Record<string, string>;
  children?: ElkGraphNode[];
  edges?: ElkGraphEdge[];
}

/**
 * Stable id for a dependency edge, shared by the ELK input, the ELK output and
 * the React Flow edge. Keyed on the endpoints rather than an array index: the
 * layout and the render filter the edge list differently (hub edges are left out
 * of the layout), so positional ids would silently drift apart and we would
 * attach one edge's route to another edge.
 */
export function depEdgeId(edge: GraphEdge): string {
  return `${edge.kind === "logical" ? "log" : "dep"}|${edge.from}|${edge.to}`;
}

/**
 * The edges we actually draw: generated dependencies, and the logical edges a
 * human drew in the adapted view (GP-72). `contains` is structure — it becomes
 * nesting, not a line.
 */
const isDrawnEdge = (edge: GraphEdge): boolean =>
  edge.kind === "depends_on" || edge.kind === "logical";

// Layered, left→right. We lay out in impact-flow direction (a dependency points
// at its dependents), so roots (vpc/vnet-level) land on the left and leaves /
// services / deletes on the right — "impact flows along arrows" (GP-31). Layer
// and node spacing are generous enough for edge labels to sit without overlap.
export const ELK_ROOT_OPTIONS: Record<string, string> = {
  "elk.algorithm": "layered",
  "elk.direction": "RIGHT",
  "elk.hierarchyHandling": "INCLUDE_CHILDREN",
  "elk.layered.spacing.nodeNodeBetweenLayers": "96",
  "elk.layered.spacing.edgeNodeBetweenLayers": "24",
  "elk.spacing.nodeNode": "40",
  "elk.spacing.edgeNode": "24",
  "elk.padding": "[top=28,left=28,bottom=28,right=28]",
  // Right-angle routing. On a dense many-to-many graph, curves cross at
  // arbitrary angles and the eye loses the thread; orthogonal segments share
  // lanes and cross cleanly. ELK computes the bend points — we render them
  // ourselves (see lib/edge-path), because React Flow would otherwise throw the
  // route away and draw its own bezier between the handles.
  "elk.edgeRouting": "ORTHOGONAL",
  // Give the router lanes to work with, so parallel edges stack instead of
  // overlapping into a single thick cable.
  "elk.spacing.edgeEdge": "12",
  "elk.layered.spacing.edgeEdgeBetweenLayers": "12",
};

const ELK_MODULE_OPTIONS: Record<string, string> = {
  "elk.padding": "[top=36,left=16,bottom=16,right=16]",
};

export type GraphNodeData = {
  graphNode: GraphNode;
  /** True when filters / the selection highlight should visually mute this node. */
  dimmed: boolean;
  /** True for the currently selected node (drives the accent ring; GP-30). */
  selected?: boolean;
  /** True when this node is a hub (high-degree / fan-out type; GP-35). */
  isHub?: boolean;
  /** Number of this hub's edges currently hidden — drives the counter chip. */
  hubHiddenCount?: number;
  /** True when this node is internet-exposed (an exposed NSG or its target; GP-45). */
  exposed?: boolean;
  [key: string]: unknown;
};

/**
 * How an edge relates to the change set (GP-30), driving its colour + arrowhead:
 * `new` (target created), `removed` (an endpoint deleted), `impact` (carries the
 * blast radius), `neutral` (plain dependency).
 */
export type EdgeRel = "new" | "removed" | "impact" | "neutral";

function edgeRel(from: GraphNode | undefined, to: GraphNode | undefined): EdgeRel {
  if (from?.change === "delete" || to?.change === "delete") return "removed";
  if (to?.change === "create") return "new";
  if (from?.impacted || to?.impacted) return "impact";
  return "neutral";
}

export type FlowElements = {
  nodes: FlowNode<GraphNodeData>[];
  edges: FlowEdge[];
};

/** Change/impact filter keys (GP-24). */
export type FilterKey = "create" | "update" | "delete" | "noop" | "impacted";
export const ALL_FILTERS: FilterKey[] = [
  "create",
  "update",
  "delete",
  "noop",
  "impacted",
];

export type ViewState = {
  activeFilters: ReadonlySet<FilterKey>;
  /** Active resource categories (GP-25). Undefined = all pass. */
  activeCategories?: ReadonlySet<Category>;
  /** Active module keys (module_path[0] or "root"; GP-25). Undefined = all pass. */
  activeModules?: ReadonlySet<string>;
  /** Currently selected node id, or null. Drives the neighbourhood highlight. */
  selectedId: string | null;
  /**
   * Node under the cursor, or null. Focuses the diagram exactly as a selection
   * does, but transiently: the resting state is calm and you *reveal* a node's
   * relationships by pointing at it, rather than reading them off a wall of
   * edges that are all drawn at once.
   */
  hoveredId?: string | null;
  /** Hub node ids (GP-35). Their edges are hidden unless revealed. */
  hubs?: ReadonlySet<string>;
  /** When true, draw every hub edge (the "Show hub connections" toggle). */
  showHubEdges?: boolean;
  /** vnet/subnet ids that render as containers even when empty (GP-44). */
  containerIds?: ReadonlySet<string>;
};

const isModule = (node: GraphNode) => node.type === "module";

/** The module a node is filtered under: its top-level module, or "root". */
export function moduleKeyOf(node: GraphNode): string {
  return node.module_path[0] ?? "root";
}

/** Top-level module names present, plus "root" if any resource sits at root. */
export function moduleOptions(graph: Graph): string[] {
  const set = new Set<string>();
  for (const node of graph.nodes) {
    if (isModule(node) && node.module_path.length === 0) set.add(node.name);
  }
  if (graph.nodes.some((n) => !isModule(n) && n.module_path.length === 0)) {
    set.add("root");
  }
  return [...set].sort((a, b) => a.localeCompare(b));
}

/** Resource categories present in the graph. */
export function categoryOptions(graph: Graph): Category[] {
  const set = new Set<Category>();
  for (const node of graph.nodes) {
    if (!isModule(node)) set.add(categorize(node.type));
  }
  return [...set];
}

/**
 * How many resources sit behind each filter option. A checkbox that says
 * "Network (4)" tells you what unticking it will cost you; a bare "Network"
 * makes you toggle it to find out.
 */
export function categoryCounts(graph: Graph): Map<Category, number> {
  const counts = new Map<Category, number>();
  for (const node of graph.nodes) {
    if (isModule(node)) continue;
    const key = categorize(node.type);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return counts;
}

export function moduleCounts(graph: Graph): Map<string, number> {
  const counts = new Map<string, number>();
  for (const node of graph.nodes) {
    if (isModule(node)) continue;
    const key = moduleKeyOf(node);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return counts;
}

/** How many resources carry each change kind — the plan view's filter counts. */
export function changeCounts(graph: Graph): Map<FilterKey, number> {
  const counts = new Map<FilterKey, number>();
  for (const node of graph.nodes) {
    if (isModule(node)) continue;
    if (node.impacted) counts.set("impacted", (counts.get("impacted") ?? 0) + 1);
    const change = node.change;
    if (change) counts.set(change, (counts.get(change) ?? 0) + 1);
  }
  return counts;
}

// `*_association` resources are pure plumbing (they wire an NSG/route table to a
// subnet); their effect is captured in `associated_ids`, so the network view
// drops them rather than drawing them as nested boxes.
const isNetworkPlumbing = (node: GraphNode): boolean =>
  node.type.endsWith("_association");

// The two structural container types in the network view. They render as frames
// even when empty (a subnet with no resources is still a subnet).
const isNetworkContainer = (node: GraphNode): boolean =>
  node.type === "azurerm_virtual_network" || node.type === "azurerm_subnet";

/** Ids the network view keeps: containment chains + network category + NSGs. */
function keptNetworkIds(graph: Graph): Set<string> {
  const keep = new Set<string>();
  for (const node of graph.nodes) {
    if (isModule(node) || isNetworkPlumbing(node)) continue;
    if (node.parent_id || categorize(node.type) === "network") keep.add(node.id);
  }
  // A parent referenced by a kept child is itself kept.
  for (const node of graph.nodes) {
    if (node.parent_id !== undefined && keep.has(node.id)) keep.add(node.parent_id);
  }
  // Keep NSGs associated with a kept node so their rules can be inspected.
  for (const node of graph.nodes) {
    if (node.associated_ids?.some((id) => keep.has(id))) keep.add(node.id);
  }
  return keep;
}

/**
 * Project a snapshot to the network view (GP-44): keep nodes that sit in a
 * `parent_id` containment chain, nodes of category "network", and NSGs
 * associated with a kept node (so their rules stay inspectable). Re-express
 * containment as `contains` edges so the existing subflow layout nests
 * vnet⊃subnet⊃resource. Everything else is dropped; the count of dropped,
 * user-meaningful resource nodes is returned for the "not in network view" chip.
 */
export function networkProjection(graph: Graph): {
  graph: Graph;
  hiddenCount: number;
  /** vnet/subnet ids to render as containers — even when they hold nothing. */
  containerIds: Set<string>;
} {
  const keep = keptNetworkIds(graph);
  const nodes = graph.nodes.filter((node) => keep.has(node.id));
  const containsEdges: GraphEdge[] = nodes
    .filter((node) => node.parent_id !== undefined && keep.has(node.parent_id))
    .map((node) => ({ from: node.parent_id as string, to: node.id, kind: "contains" }));
  const dependsOn = graph.edges.filter(
    (e) => e.kind === "depends_on" && keep.has(e.from) && keep.has(e.to),
  );
  const hiddenCount = graph.nodes.filter(
    (node) => !isModule(node) && !isNetworkPlumbing(node) && !keep.has(node.id),
  ).length;
  const containerIds = new Set(nodes.filter(isNetworkContainer).map((n) => n.id));

  return {
    graph: { version: graph.version, nodes, edges: [...containsEdges, ...dependsOn] },
    hiddenCount,
    containerIds,
  };
}

/**
 * Ids to render as internet-exposed (GP-45): every NSG whose `internet_exposed`
 * flag is set, plus the subnets/NICs it is associated with — so the warning
 * treatment lands on both the security group and what it (fails to) protect.
 */
export function exposedNodeIds(graph: Graph): Set<string> {
  const ids = new Set<string>();
  for (const node of graph.nodes) {
    if (!node.internet_exposed) continue;
    ids.add(node.id);
    for (const id of node.associated_ids ?? []) ids.add(id);
  }
  return ids;
}

/**
 * Does a node pass the active change/impact filters? Modules and docs-flow
 * resources (no change data) always pass — filters only apply to plan changes.
 */
export function nodePassesFilters(
  node: GraphNode,
  active: ReadonlySet<FilterKey>,
): boolean {
  if (isModule(node) || node.change === null) return true;
  if (active.has(node.change)) return true;
  if (node.impacted && active.has("impacted")) return true;
  return false;
}

/** The selected node plus every node sharing an edge with it. */
export function neighborhood(graph: Graph, selectedId: string): Set<string> {
  const set = new Set<string>([selectedId]);
  for (const edge of graph.edges) {
    if (edge.from === selectedId) set.add(edge.to);
    else if (edge.to === selectedId) set.add(edge.from);
  }
  return set;
}

/** Build the nested ELK input graph (no positions yet). Hub edges are excluded
 * from the layout so the graph lays out cleanly without the hub's edge wall
 * (GP-35); revealed hub edges are drawn over the resulting layout. */
/**
 * Finalize a container that ended up with no children. A forced (structural)
 * container keeps its frame, floored to a minimum size; an empty module collapses
 * to a leaf-sized node (the infra-view behaviour, unchanged).
 */
function resolveEmptyContainer(elk: ElkGraphNode, forced: boolean): void {
  if (forced) {
    elk.layoutOptions = {
      ...ELK_MODULE_OPTIONS,
      "elk.nodeSize.constraints": "MINIMUM_SIZE",
      "elk.nodeSize.minimum": `(${EMPTY_CONTAINER_WIDTH}, ${EMPTY_CONTAINER_HEIGHT})`,
    };
    return;
  }
  delete elk.children;
  delete elk.layoutOptions;
  elk.width = MODULE_LEAF_WIDTH;
  elk.height = RESOURCE_HEIGHT;
}

export function toElkGraph(
  graph: Graph,
  hubs?: ReadonlySet<string>,
  forceContainers?: ReadonlySet<string>,
): ElkGraphNode {
  const parentOf = new Map<string, string>();
  for (const edge of graph.edges) {
    if (edge.kind === "contains") parentOf.set(edge.to, edge.from);
  }
  // Any node that contains others is a container (module hierarchy, or a
  // vnet/subnet in the network view); it's laid out as a group/subflow node. The
  // caller can force extra containers (structural vnets/subnets that happen to be
  // empty) so they still render as frames. For the infra view both are empty, so
  // behaviour is unchanged there.
  const forced = forceContainers ?? new Set<string>();
  const containerIds = new Set(parentOf.values());
  for (const id of forced) containerIds.add(id);

  const elkById = new Map<string, ElkGraphNode>();
  for (const node of graph.nodes) {
    elkById.set(
      node.id,
      isModule(node) || containerIds.has(node.id)
        ? { id: node.id, layoutOptions: ELK_MODULE_OPTIONS, children: [] }
        : { id: node.id, width: RESOURCE_WIDTH, height: RESOURCE_HEIGHT },
    );
  }

  const roots: ElkGraphNode[] = [];
  for (const node of graph.nodes) {
    const elk = elkById.get(node.id)!;
    const parentId = parentOf.get(node.id);
    const parent = parentId ? elkById.get(parentId) : undefined;
    if (parent?.children) parent.children.push(elk);
    else roots.push(elk);
  }

  for (const [id, elk] of elkById) {
    if (elk.children && elk.children.length === 0) {
      resolveEmptyContainer(elk, forced.has(id));
    }
  }

  // Reverse the dependency for layout (dependency → dependent) so roots sit on
  // the left and impact reads left→right (GP-31). Hub edges (GP-35) are left out
  // entirely so the hub node doesn't drag its whole neighbourhood together.
  //
  // Logical edges (GP-72) go through ELK like any other: a relationship a human
  // drew is a real relationship, and the layout should place its endpoints near
  // each other rather than route a line across the whole diagram afterwards.
  const edges = graph.edges
    .filter((edge) => isDrawnEdge(edge) && !(hubs && isHubEdge(edge, hubs)))
    .map((edge) => ({
      id: depEdgeId(edge),
      sources: [edge.to],
      targets: [edge.from],
    }));

  return { id: "root", layoutOptions: ELK_ROOT_OPTIONS, children: roots, edges };
}

const DEFAULT_VIEW: ViewState = {
  activeFilters: new Set(ALL_FILTERS),
  selectedId: null,
};

const EMPTY_HUBS: ReadonlySet<string> = new Set<string>();

const ROOT = " root"; // can't collide with a Terraform address

/**
 * Where every laid-out node actually sits, and who contains it. ELK reports a
 * node's `x`/`y` relative to its parent, so the absolute position is the sum
 * along the parent chain.
 */
function indexLayout(root: ElkGraphNode): {
  origin: Map<string, Point>;
  parent: Map<string, string>;
} {
  const origin = new Map<string, Point>([[ROOT, { x: 0, y: 0 }]]);
  const parent = new Map<string, string>();

  const walk = (node: ElkGraphNode, parentId: string, ox: number, oy: number) => {
    const x = ox + (node.x ?? 0);
    const y = oy + (node.y ?? 0);
    origin.set(node.id, { x, y });
    parent.set(node.id, parentId);
    for (const child of node.children ?? []) walk(child, node.id, x, y);
  };
  for (const child of root.children ?? []) walk(child, ROOT, 0, 0);

  return { origin, parent };
}

/** The chain of containers above a node, innermost first, ending at the root. */
function containerChain(id: string, parent: ReadonlyMap<string, string>): string[] {
  const chain: string[] = [];
  let current = parent.get(id);
  while (current !== undefined) {
    chain.push(current);
    if (current === ROOT) break;
    current = parent.get(current);
  }
  return chain.length > 0 ? chain : [ROOT];
}

/**
 * The coordinate system an ELK edge's route is expressed in.
 *
 * **This is the trap.** ELK reports edge coordinates relative to the *lowest
 * common ancestor* of the edge's two endpoints — not relative to the node the
 * edge was declared under, and not absolutely. Declare every edge on the root, as
 * we do, and a root-level or container-crossing edge comes back in absolute
 * coordinates (its LCA *is* the root) while an edge **between two nodes of the
 * same container** comes back relative to that container. Read the second kind as
 * absolute and it is drawn shifted up and to the left by the container's origin —
 * which is exactly a diagram whose edges hang off the outside of the box that
 * owns them.
 */
function routeOrigin(
  edge: ElkGraphEdge,
  parent: ReadonlyMap<string, string>,
  origin: ReadonlyMap<string, Point>,
): Point {
  const source = edge.sources[0];
  const target = edge.targets[0];
  if (!source || !target) return { x: 0, y: 0 };

  const above = new Set(containerChain(source, parent));
  const lca = containerChain(target, parent).find((id) => above.has(id)) ?? ROOT;
  return origin.get(lca) ?? { x: 0, y: 0 };
}

/** Every edge ELK laid out, wherever in the tree it chose to hand it back. */
function* elkEdges(node: ElkGraphNode): Generator<ElkGraphEdge> {
  yield* node.edges ?? [];
  for (const child of node.children ?? []) yield* elkEdges(child);
}

/**
 * The routes ELK computed, resolved into absolute (flow) coordinates and keyed by
 * the same endpoint-derived id we sent in.
 *
 * A route is ELK's *whole* polyline — where it left the source, its bends, and
 * where it reached the target. Taking only the bends and pinning the ends to
 * React Flow's left/right handles assumes the router always leaves a node on its
 * right and arrives on its left; give it containers to route around and it does
 * not, and the line then doubles back across the diagram to meet a bend it was
 * never going to start from.
 */
export function elkRoutes(layout: ElkGraphNode): Map<string, Point[]> {
  const { origin, parent } = indexLayout(layout);
  const routes = new Map<string, Point[]>();

  for (const edge of elkEdges(layout)) {
    const section = edge.sections?.[0];
    if (!section) continue;
    const { x, y } = routeOrigin(edge, parent, origin);
    const points = [
      section.startPoint,
      ...(section.bendPoints ?? []),
      section.endPoint,
    ];
    routes.set(
      edge.id,
      points.map((p) => ({ x: p.x + x, y: p.y + y })),
    );
  }
  return routes;
}

/** Map a laid-out ELK graph back to React Flow nodes + edges, applying filters. */
export function elkToFlow(
  layout: ElkGraphNode,
  graph: Graph,
  view: ViewState = DEFAULT_VIEW,
): FlowElements {
  const { activeFilters, activeCategories, activeModules, selectedId } = view;
  const hubs = view.hubs ?? EMPTY_HUBS;
  const showHubEdges = view.showHubEdges ?? false;
  const containerIds = view.containerIds ?? EMPTY_HUBS;
  // A selection is sticky, a hover is transient — but both focus the same way.
  // Selection wins, so hovering elsewhere can't yank you out of what you pinned.
  const focusId = selectedId ?? view.hoveredId ?? null;
  const neighbors = focusId ? neighborhood(graph, focusId) : null;
  const byId = new Map(graph.nodes.map((n) => [n.id, n]));

  // Absent for hub edges (deliberately left out of the layout, GP-35) — those
  // fall back to a curve, drawn over the layout as they always were.
  const routes = elkRoutes(layout);
  const exposed = exposedNodeIds(graph); // internet-exposure treatment (GP-45)

  // Count each hub's currently-hidden edges so the node can show a counter chip
  // (GP-35). A hub edge is hidden unless revealed by the toggle or the selection.
  const hubHiddenCount = new Map<string, number>();
  for (const edge of graph.edges) {
    if (!isHubEdge(edge, hubs)) continue;
    if (hubEdgeRevealed(edge, focusId, showHubEdges)) continue;
    for (const endpoint of [edge.from, edge.to]) {
      if (hubs.has(endpoint)) {
        hubHiddenCount.set(endpoint, (hubHiddenCount.get(endpoint) ?? 0) + 1);
      }
    }
  }

  const dimmedOf = (node: GraphNode): boolean => {
    if (isModule(node)) return false; // containers stay lit
    if (!nodePassesFilters(node, activeFilters)) return true;
    if (activeCategories && !activeCategories.has(categorize(node.type))) return true;
    if (activeModules && !activeModules.has(moduleKeyOf(node))) return true;
    if (neighbors && !neighbors.has(node.id)) return true;
    return false;
  };

  const nodes: FlowNode<GraphNodeData>[] = [];
  const walk = (elk: ElkGraphNode, parentId?: string) => {
    const graphNode = byId.get(elk.id);
    if (graphNode) {
      // A node is a container if it holds laid-out children, or it's a forced
      // structural container (an empty vnet/subnet still draws its frame, GP-44).
      const container =
        (elk.children?.length ?? 0) > 0 || containerIds.has(elk.id);
      // Module-backed containers render as the dashed module box; resource-backed
      // containers (vnet/subnet in the network view) render with their own
      // identity via the `container` node type (GP-44). A container that came
      // from a `group` annotation is a third thing again (GP-74) — and it must
      // never be mistaken for either, because one is what a human said about the
      // system and the others are what the code says.
      let nodeType = "resource";
      if (graphNode.annotation_group) nodeType = "groupContainer";
      else if (container) nodeType = isModule(graphNode) ? "module" : "container";
      // Hand React Flow the size ELK computed, as `width`/`height` *and*
      // `measured`. It hides any node it thinks is unmeasured, and it reads
      // `measured` only off the node object we give it — so every rebuild of this
      // list (a hover focuses the diagram, and rebuilds it) would blank the whole
      // graph for a frame while a ResizeObserver re-measured what we already knew.
      const width = elk.width ?? RESOURCE_WIDTH;
      const height = elk.height ?? RESOURCE_HEIGHT;
      nodes.push({
        id: elk.id,
        type: nodeType,
        position: { x: elk.x ?? 0, y: elk.y ?? 0 },
        data: {
          graphNode,
          dimmed: dimmedOf(graphNode),
          selected: selectedId === graphNode.id,
          isHub: hubs.has(graphNode.id),
          hubHiddenCount: hubHiddenCount.get(graphNode.id) ?? 0,
          exposed: exposed.has(graphNode.id),
        },
        width,
        height,
        measured: { width, height },
        style: { width, height },
        ...(parentId ? { parentId, extent: "parent" as const } : {}),
      });
    }
    for (const child of elk.children ?? []) walk(child, elk.id);
  };
  for (const child of layout.children ?? []) walk(child);

  const edges: FlowEdge[] = graph.edges
    .filter(isDrawnEdge)
    // Drop hub edges that are currently hidden (GP-35); revealed ones are drawn
    // over the layout (which was computed without them).
    // Focus reveals a hub's hidden edges — hovering the hub is how you ask what
    // it connects to, and lighting its neighbours while drawing no line to them
    // is a worse lie than hiding both.
    .filter((edge) => !isHubEdge(edge, hubs) || hubEdgeRevealed(edge, focusId, showHubEdges))
    .map((edge) => {
      const touchesFocus =
        Boolean(focusId) && (edge.from === focusId || edge.to === focusId);
      const logical = edge.kind === "logical";
      // Colour/dash come from the relationship + inferred flag (GP-30), applied
      // by the RelationshipEdge component — no re-layout on selection. Drawn in
      // impact-flow direction (dependency → dependent) to match the layout
      // (GP-31); the relationship is still computed from the true dependency.
      return {
        id: depEdgeId(edge),
        source: edge.to,
        target: edge.from,
        type: "relationship",
        data: {
          rel: edgeRel(byId.get(edge.from), byId.get(edge.to)),
          dimmed: Boolean(focusId) && !touchesFocus,
          // Lit: this edge belongs to the node you are pointing at. Everything
          // else recedes, so one relationship can be traced through a crossing.
          active: touchesFocus,
          inferred: edge.inferred === true,
          route: routes.get(depEdgeId(edge)),
          // A logical edge wears the annotation treatment — dashed, accent-toned,
          // no arrowhead — because it is exactly that: a human relationship drawn
          // over a generated diagram, and it must not pass for a dependency the
          // code declares.
          annotation: logical,
          ...(edge.label ? { label: edge.label } : {}),
        },
      };
    });

  return { nodes, edges };
}

/** Border/background/text classes for a node's change kind (GP-28 tokens). */
export const CHANGE_STYLES: Record<ChangeKind | "none", string> = {
  create: "border-create bg-create-soft text-ink",
  update: "border-update bg-update-soft text-ink",
  delete: "border-delete bg-delete-soft text-ink border-dashed",
  noop: "border-border bg-panel text-ink",
  none: "border-border bg-panel text-ink",
};

export function changeClasses(change: ChangeKind | null): string {
  return CHANGE_STYLES[change ?? "none"];
}
