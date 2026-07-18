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

// GP-87: a resource host card grows to fit its stacked satellite rows. ELK
// reserves the collapsed height — up to STACK_MAX_ROWS rows plus a "+n more" row;
// expanding past that overflows the card at render time, which is fine (an
// on-demand reveal, not part of the layout).
const STACK_ROW_HEIGHT = 22;
export const STACK_MAX_ROWS = 6;
const STACK_TOP_PAD = 6;

/** The laid-out height of a host card given how many satellite children it stacks. */
export function stackHostHeight(childCount: number): number {
  if (childCount === 0) return RESOURCE_HEIGHT;
  const rows =
    Math.min(childCount, STACK_MAX_ROWS) + (childCount > STACK_MAX_ROWS ? 1 : 0);
  return RESOURCE_HEIGHT + STACK_TOP_PAD + rows * STACK_ROW_HEIGHT;
}

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

const MODULE_TOP_PAD = 36;
const ELK_MODULE_OPTIONS: Record<string, string> = {
  "elk.padding": `[top=${MODULE_TOP_PAD},left=16,bottom=16,right=16]`,
};
// GP-89: extra top band inside a subnet frame for its NSG / route-table chip row.
const CHIP_BAND = 30;
// Extra band on a resource card carrying attachment chips (avset on its VM).
const CARD_CHIP_BAND = 26;

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
  /** GP-87: satellite children stacked inside this host card (network view). */
  stack?: GraphNode[];
  /** GP-87: true when a stacked child changed — the host wears the impacted ring. */
  stackChanged?: boolean;
  /** GP-89: NSG / route-table chips attached to this subnet container's header. */
  chips?: GraphNode[];
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
  /** GP-87: host id → its stacked satellite children (network view only). */
  stacks?: ReadonlyMap<string, GraphNode[]>;
  /** GP-89: subnet id → the NSG / route-table chips on its header (network view). */
  chips?: ReadonlyMap<string, GraphNode[]>;
  /**
   * GP-79: the nodes the current tour stop is about. When a tour is running this
   * is the focus — it outranks hover and selection, because a narration that
   * flickers every time the cursor drifts is not a narration.
   *
   * The spotlight is the existing dim, turned up: no scrim, no z-index surgery,
   * just everything-but-this pushed back. An *empty* set is the whole-diagram
   * stop (the opener and the closer), where nothing should dim at all.
   */
  tourAnchors?: ReadonlySet<string> | null;
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
  // Every option a node can fall under, always — the canvas seeds `activeModules`
  // from this list, so a key missing here is a node dimmed forever with no
  // checkbox to bring it back. Whether a one-option list is worth *showing* is the
  // canvas's business, not this function's (see the Module filter section).
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

// The `edge`-semantic azurerm join types (mirrors the backend's
// `graph/azurerm-joins.ts` NETWORK_EDGE_JOIN_TYPES): resources whose whole
// purpose is to bind two others. The backend emits the direct edge between the
// endpoints, so the network view draws the line, not the binder's box.
const EDGE_JOIN_TYPES = new Set([
  "azurerm_network_interface_backend_address_pool_association",
  "azurerm_network_interface_application_gateway_backend_address_pool_association",
  "azurerm_network_interface_nat_rule_association",
  "azurerm_virtual_network_peering",
  "azurerm_databricks_virtual_network_peering",
  "azurerm_virtual_hub_connection",
  "azurerm_virtual_network_gateway_connection",
  "azurerm_vpn_gateway_connection",
  "azurerm_express_route_connection",
  "azurerm_express_route_circuit_connection",
  "azurerm_private_dns_zone_virtual_network_link",
  "azurerm_private_dns_resolver_virtual_network_link",
  "azurerm_app_service_virtual_network_swift_connection",
  "azurerm_app_service_slot_virtual_network_swift_connection",
]);

// `*_association` resources are pure plumbing (they wire an NSG/route table/NAT
// gateway to a subnet or NIC); their effect is captured in `associated_ids` /
// `parent_id` / a direct edge, so the network view drops them rather than
// drawing them as nested boxes. Same for the edge-join types above.
const isNetworkPlumbing = (node: GraphNode): boolean =>
  node.type.endsWith("_association") || EDGE_JOIN_TYPES.has(node.type);

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
  /** GP-87: host id → its stacked satellite children (kept out of the layout). */
  stacks: Map<string, GraphNode[]>;
  /** GP-89: subnet id → the NSG / route-table chips on its header. */
  chips: Map<string, GraphNode[]>;
} {
  const keep = keptNetworkIds(graph);
  const nodes = graph.nodes.filter((node) => keep.has(node.id));
  const containerIds = new Set(nodes.filter(isNetworkContainer).map((n) => n.id));
  // Containment nests via ELK only under a container (vnet/subnet). A node
  // parented to a *resource host* is stacked into that host's card instead
  // (GP-87) — it gets no contains edge and is pulled out of the layout later.
  const containsEdges: GraphEdge[] = nodes
    .filter((node) => node.parent_id !== undefined && containerIds.has(node.parent_id))
    .map((node) => ({ from: node.parent_id as string, to: node.id, kind: "contains" }));
  const dependsOn = graph.edges.filter(
    (e) => e.kind === "depends_on" && keep.has(e.from) && keep.has(e.to),
  );
  const hiddenCount = graph.nodes.filter(
    (node) => !isModule(node) && !isNetworkPlumbing(node) && !keep.has(node.id),
  ).length;

  const projected: Graph = {
    version: graph.version,
    nodes,
    edges: [...containsEdges, ...dependsOn],
  };
  const stacks = resourceStacks(projected, containerIds);
  return {
    graph: projected,
    hiddenCount,
    containerIds,
    stacks,
    chips: attachmentChips(projected, containerIds, stacks),
  };
}

/**
 * GP-89, generalized: attachments render as chips on their anchor — an NSG /
 * route table on its subnet frame header, an availability set on each member
 * VM's card. An eligible anchor is a kept subnet container or a top-level
 * resource card; an anchor that is itself stacked inside a host (a NIC row) or
 * absent offers no chip home, so a satellite with no eligible anchor stays a
 * floating node — a chip is never lost to a missing anchor. A node associated
 * with several anchors appears on each (one chip per anchor, one identity).
 */
export function attachmentChips(
  graph: Graph,
  containerIds: ReadonlySet<string>,
  stacks: ReadonlyMap<string, GraphNode[]>,
): Map<string, GraphNode[]> {
  const byId = new Map(graph.nodes.map((n) => [n.id, n]));
  const stacked = new Set<string>();
  for (const list of stacks.values()) for (const c of list) stacked.add(c.id);
  const eligible = (anchor: string): boolean => {
    const node = byId.get(anchor);
    if (!node || isModule(node)) return false;
    if (containerIds.has(anchor)) return node.type === "azurerm_subnet";
    return !stacked.has(anchor); // a top-level resource card
  };
  const chips = new Map<string, GraphNode[]>();
  for (const node of graph.nodes) {
    for (const anchor of node.associated_ids ?? []) {
      if (!eligible(anchor)) continue;
      const list = chips.get(anchor);
      if (list) list.push(node);
      else chips.set(anchor, [node]);
    }
  }
  for (const list of chips.values()) list.sort((a, b) => a.id.localeCompare(b.id));
  return chips;
}

/** Every attached node id — stacked satellite children and subnet chips alike.
 * None is laid out by ELK; each rides on its host card / subnet header instead. */
function attachedNodeIds(
  stacks?: ReadonlyMap<string, GraphNode[]>,
  chips?: ReadonlyMap<string, GraphNode[]>,
): Set<string> {
  const ids = new Set<string>();
  for (const list of stacks?.values() ?? []) for (const c of list) ids.add(c.id);
  for (const list of chips?.values() ?? []) for (const c of list) ids.add(c.id);
  return ids;
}

/** attached node id → the node its edges re-anchor onto (GP-88/89): a stacked
 * child's host, or a chip's subnet (the first it was listed under). */
function attachmentAnchors(
  stacks?: ReadonlyMap<string, GraphNode[]>,
  chips?: ReadonlyMap<string, GraphNode[]>,
): Map<string, string> {
  const map = new Map<string, string>();
  for (const [host, list] of stacks ?? []) for (const c of list) map.set(c.id, host);
  for (const [subnet, list] of chips ?? []) {
    for (const c of list) if (!map.has(c.id)) map.set(c.id, subnet);
  }
  return map;
}

/**
 * GP-87: satellite children stacked inside their resource host in the network
 * view. A host is a non-container node that is some kept node's `parent_id`; its
 * children are the nodes parented to it. A node parented directly to a
 * vnet/subnet container nests via ELK instead (not here). Children are sorted by
 * id so the stack renders deterministically.
 */
export function resourceStacks(
  graph: Graph,
  containerIds: ReadonlySet<string>,
): Map<string, GraphNode[]> {
  const byId = new Map(graph.nodes.map((n) => [n.id, n]));
  const stacks = new Map<string, GraphNode[]>();
  for (const node of graph.nodes) {
    const parentId = node.parent_id;
    if (parentId === undefined || containerIds.has(parentId)) continue;
    const host = byId.get(parentId);
    if (!host || isModule(host)) continue;
    const list = stacks.get(parentId);
    if (list) list.push(node);
    else stacks.set(parentId, [node]);
  }
  for (const list of stacks.values()) list.sort((a, b) => a.id.localeCompare(b.id));
  return stacks;
}

/** GP-87: true when any stacked child carries a real change or is impacted — the
 * host must wear the impacted ring so a diff inside the stack stays visible. */
function stackChanged(children?: readonly GraphNode[]): boolean {
  return (
    children?.some(
      (c) => (c.change !== null && c.change !== "noop") || c.impacted === true,
    ) ?? false
  );
}

/**
 * GP-88: once satellites live inside a host card, every edge that touched a
 * satellite must touch the host instead — without turning into a fan of parallel
 * lines. Re-anchor each drawable edge's endpoints (a stacked child becomes its
 * host), drop the self-loops that collapse out (host ↔ its own child — the stack
 * already says that), and merge the parallels that fall together, carrying a
 * `count`. `members` records every original endpoint behind each merged edge, so
 * selecting a stacked child can still light exactly the edges it takes part in —
 * the merge is visual, never a data rewrite.
 */
export function reanchorStackEdges(
  edges: readonly GraphEdge[],
  childToHost: ReadonlyMap<string, string>,
): { edges: GraphEdge[]; members: Map<string, Set<string>> } {
  const anchor = (id: string): string => childToHost.get(id) ?? id;
  type Merged = { edge: GraphEdge; count: number; inferred: boolean; members: Set<string> };
  const byKey = new Map<string, Merged>();

  for (const edge of edges) {
    if (!isDrawnEdge(edge)) continue;
    const from = anchor(edge.from);
    const to = anchor(edge.to);
    if (from === to) continue; // self-loop: the stack itself already says this
    const key = `${edge.kind}|${from}|${to}`;
    const existing = byKey.get(key);
    if (existing) {
      existing.count += 1;
      existing.inferred = existing.inferred && edge.inferred === true;
      existing.members.add(edge.from).add(edge.to);
    } else {
      byKey.set(key, {
        edge: { ...edge, from, to },
        count: 1,
        inferred: edge.inferred === true,
        members: new Set([edge.from, edge.to]),
      });
    }
  }

  const out: GraphEdge[] = [];
  const members = new Map<string, Set<string>>();
  for (const m of byKey.values()) {
    // Preserve the input shape when nothing collapsed (a lone edge with no
    // stacked endpoint is returned untouched — `inferred` only where it was set).
    const merged: GraphEdge = {
      ...m.edge,
      ...(m.edge.inferred === undefined && m.count === 1 ? {} : { inferred: m.inferred }),
      ...(m.count > 1 ? { count: m.count } : {}),
    };
    out.push(merged);
    members.set(depEdgeId(merged), m.members);
  }
  return { edges: out, members };
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

/**
 * The lit set for a focus, stack-aware (GP-88). The base is the ordinary
 * neighbourhood (containment + real dependencies); on top of it a selected node
 * lights every *drawn* (re-anchored, merged) edge it takes part in — so selecting
 * a host lights the merged edges that came from its children, and selecting a
 * stacked child lights the host card plus the merged edges the child is behind.
 * With nothing stacked this collapses back to `neighborhood`.
 */
function litNeighborhood(
  graph: Graph,
  drawnEdges: readonly GraphEdge[],
  focusId: string,
  edgeTouches: (edge: GraphEdge, id: string) => boolean,
  childToHost: ReadonlyMap<string, string>,
): Set<string> {
  const set = neighborhood(graph, focusId);
  const host = childToHost.get(focusId);
  if (host) set.add(host);
  for (const edge of drawnEdges) {
    if (edgeTouches(edge, focusId)) {
      set.add(edge.from);
      set.add(edge.to);
    }
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

/** Nest each ELK node under its `contains` parent, returning the roots; then
 * finalize any container that ended up empty. */
function nestElkNodes(
  graph: Graph,
  elkById: ReadonlyMap<string, ElkGraphNode>,
  parentOf: ReadonlyMap<string, string>,
  forced: ReadonlySet<string>,
): ElkGraphNode[] {
  const roots: ElkGraphNode[] = [];
  for (const node of graph.nodes) {
    const elk = elkById.get(node.id);
    if (!elk) continue; // stacked child — not laid out
    const parentId = parentOf.get(node.id);
    const parent = parentId ? elkById.get(parentId) : undefined;
    if (parent?.children) parent.children.push(elk);
    else roots.push(elk);
  }
  for (const [id, elk] of elkById) {
    if (elk.children?.length === 0) resolveEmptyContainer(elk, forced.has(id));
  }
  return roots;
}

/** The ELK node for a graph node: a subflow container, or a sized resource box
 * (taller when it hosts a satellite stack, GP-87). */
function elkNodeFor(
  node: GraphNode,
  containerIds: ReadonlySet<string>,
  stacks?: ReadonlyMap<string, GraphNode[]>,
  chips?: ReadonlyMap<string, GraphNode[]>,
): ElkGraphNode {
  if (isModule(node) || containerIds.has(node.id)) {
    // A subnet with header chips (GP-89) reserves a band at the top of its frame
    // so the chips don't sit over the resources it contains.
    const layoutOptions = chips?.get(node.id)?.length
      ? {
          ...ELK_MODULE_OPTIONS,
          "elk.padding": `[top=${MODULE_TOP_PAD + CHIP_BAND},left=16,bottom=16,right=16]`,
        }
      : ELK_MODULE_OPTIONS;
    return { id: node.id, layoutOptions, children: [] };
  }
  const hostChildren = stacks?.get(node.id);
  const chipCount = chips?.get(node.id)?.length ?? 0;
  const base = hostChildren
    ? stackHostHeight(hostChildren.length)
    : RESOURCE_HEIGHT;
  return {
    id: node.id,
    width: RESOURCE_WIDTH,
    height: base + (chipCount > 0 ? CARD_CHIP_BAND : 0),
  };
}

/** Numeric sort value of a node's first CIDR, or null when it has none. */
function cidrSortValue(node: GraphNode | undefined): number | null {
  const raw = node?.attributes?.["address_prefixes"]?.split(",")[0]?.trim();
  const m = raw ? /^(\d+)\.(\d+)\.(\d+)\.(\d+)\/\d+$/.exec(raw) : null;
  if (!m) return null;
  const [, a, b, c, d] = m;
  if (a === undefined || b === undefined || c === undefined || d === undefined) {
    return null;
  }
  return ((Number(a) * 256 + Number(b)) * 256 + Number(c)) * 256 + Number(d);
}

/**
 * Order a container's children by CIDR (known CIDRs first, numerically; the
 * rest keep id order) so ELK receives subnets in address-plan order and its
 * order-dependent tie-breaks resolve the same way on every render.
 *
 * Deliberately NO model-order layout options here: both
 * `elk.layered.considerModelOrder.strategy` and
 * `elk.layered.crossingMinimization.forceNodeModelOrder` make elkjs 0.11.1
 * throw inside an `INCLUDE_CHILDREN` hierarchy (see graph-layout.elk.test.ts),
 * and the canvas swallows the rejection — the whole diagram then renders from
 * a stale layout, scattered. Where subnets are tied together by edges, edge
 * routing still outranks this order; that is a known, accepted limit.
 */
function orderChildrenByCidr(
  elk: ElkGraphNode,
  byId: ReadonlyMap<string, GraphNode>,
): void {
  const children = elk.children;
  if (!children || children.length < 2) return;
  const values = new Map(
    children.map((c) => [c.id, cidrSortValue(byId.get(c.id))]),
  );
  if (![...values.values()].some((v) => v !== null)) return;
  children.sort((x, y) => {
    const a = values.get(x.id) ?? null;
    const b = values.get(y.id) ?? null;
    if (a !== null && b !== null) return a - b;
    if (a !== null) return -1;
    if (b !== null) return 1;
    return x.id.localeCompare(y.id);
  });
}

export function toElkGraph(
  graph: Graph,
  hubs?: ReadonlySet<string>,
  forceContainers?: ReadonlySet<string>,
  stacks?: ReadonlyMap<string, GraphNode[]>,
  chips?: ReadonlyMap<string, GraphNode[]>,
): ElkGraphNode {
  // Attached nodes — stacked satellite children (GP-87) and subnet chips (GP-89) —
  // never enter the layout; they ride on their host card / subnet header instead,
  // so ELK's job (and cost) shrinks.
  const attached = attachedNodeIds(stacks, chips);
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
    if (!attached.has(node.id)) {
      elkById.set(node.id, elkNodeFor(node, containerIds, stacks, chips));
    }
  }
  const roots = nestElkNodes(graph, elkById, parentOf, forced);

  // Subnets inside a vnet lay out by address plan, not id order.
  const nodeById = new Map(graph.nodes.map((n) => [n.id, n]));
  for (const elk of elkById.values()) orderChildrenByCidr(elk, nodeById);

  // Lay out the edges as they will be drawn: re-anchored onto host cards / subnet
  // containers and merged (GP-88/89). With nothing attached this is exactly the
  // drawable edges (no re-anchor, no merge), so non-network views are unaffected.
  //
  // Reverse the dependency for layout (dependency → dependent) so roots sit on
  // the left and impact reads left→right (GP-31). Hub edges (GP-35) are left out
  // entirely so the hub node doesn't drag its whole neighbourhood together.
  // Logical edges (GP-72) go through ELK like any other.
  const drawn =
    attached.size > 0
      ? reanchorStackEdges(graph.edges, attachmentAnchors(stacks, chips)).edges
      : graph.edges.filter(isDrawnEdge);
  const edges = drawn
    .filter((edge) => !(hubs && isHubEdge(edge, hubs)))
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

/**
 * The edges as the network view draws them (GP-88): re-anchored onto host cards
 * and merged when satellites are stacked, or the plain drawable edges otherwise.
 * `touches(edge, id)` answers whether a node takes part in an edge, following a
 * merged edge back to its original endpoints so a stacked child can still be lit.
 */
function drawnEdgeSet(
  graph: Graph,
  stacks?: ReadonlyMap<string, GraphNode[]>,
  chips?: ReadonlyMap<string, GraphNode[]>,
): {
  edges: GraphEdge[];
  members: Map<string, Set<string>>;
  touches: (edge: GraphEdge, id: string) => boolean;
  anchorOf: Map<string, string>;
} {
  const anchorOf = attachmentAnchors(stacks, chips);
  const { edges, members } =
    anchorOf.size > 0
      ? reanchorStackEdges(graph.edges, anchorOf)
      : { edges: graph.edges.filter(isDrawnEdge), members: new Map<string, Set<string>>() };
  const touches = (edge: GraphEdge, id: string): boolean =>
    edge.from === id ||
    edge.to === id ||
    members.get(depEdgeId(edge))?.has(id) === true;
  return { edges, members, touches, anchorOf };
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
  const stacks = view.stacks;
  const chips = view.chips;
  // The edges as drawn (GP-88/89): re-anchored onto host cards / subnet containers
  // and merged, with a `touches` predicate that lights a merged edge for any
  // original endpoint behind it — so selecting a stacked child or a chip works.
  const { edges: drawnEdges, touches: edgeTouches, anchorOf } = drawnEdgeSet(graph, stacks, chips);
  // A tour stop outranks both: while one is running, the diagram is showing you
  // what the narrator is talking about, and a stray hover must not redirect it.
  // An empty set is the whole-diagram stop, which focuses nothing.
  const touring =
    view.tourAnchors && view.tourAnchors.size > 0 ? view.tourAnchors : null;
  // A selection is sticky, a hover is transient — but both focus the same way.
  // Selection wins, so hovering elsewhere can't yank you out of what you pinned.
  const focusId = touring ? null : (selectedId ?? view.hoveredId ?? null);
  const neighbors = focusId
    ? litNeighborhood(graph, drawnEdges, focusId, edgeTouches, anchorOf)
    : null;
  const byId = new Map(graph.nodes.map((n) => [n.id, n]));

  // Absent for hub edges (deliberately left out of the layout, GP-35) — those
  // fall back to a curve, drawn over the layout as they always were.
  const routes = elkRoutes(layout);
  const exposed = exposedNodeIds(graph); // internet-exposure treatment (GP-45)

  // Count each hub's currently-hidden edges so the node can show a counter chip
  // (GP-35). A hub edge is hidden unless revealed by the toggle or the selection.
  // Counted over the drawn (merged) edge set, so the chip matches what's on screen
  // (GP-88).
  const hubHiddenCount = new Map<string, number>();
  for (const edge of drawnEdges) {
    if (!isHubEdge(edge, hubs)) continue;
    if (hubEdgeRevealed(edge, focusId, showHubEdges)) continue;
    for (const endpoint of [edge.from, edge.to]) {
      if (hubs.has(endpoint)) {
        hubHiddenCount.set(endpoint, (hubHiddenCount.get(endpoint) ?? 0) + 1);
      }
    }
  }

  const dimmedOf = (node: GraphNode): boolean => {
    // A tour stop is the only focus that dims a container: when the stop *is* a
    // module or a group, the point is that box, and leaving every other frame lit
    // would be a spotlight with the house lights on.
    if (touring) return !touring.has(node.id);
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
          // GP-87: a resource host carries its satellite children as rows, and
          // wears the impacted ring when any of them changed.
          ...(stacks?.has(graphNode.id)
            ? {
                stack: stacks.get(graphNode.id),
                stackChanged: stackChanged(stacks.get(graphNode.id)),
              }
            : {}),
          // GP-89: a subnet container carries its NSG / route-table chips.
          ...(chips?.has(graphNode.id) ? { chips: chips.get(graphNode.id) } : {}),
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

  // The drawn set is already re-anchored + merged (GP-88); a stacked child never
  // appears as an endpoint here.
  const edges: FlowEdge[] = drawnEdges
    // Drop hub edges that are currently hidden (GP-35); revealed ones are drawn
    // over the layout (which was computed without them).
    // Focus reveals a hub's hidden edges — hovering the hub is how you ask what
    // it connects to, and lighting its neighbours while drawing no line to them
    // is a worse lie than hiding both.
    .filter((edge) => !isHubEdge(edge, hubs) || hubEdgeRevealed(edge, focusId, showHubEdges))
    .map((edge) => {
      const id = depEdgeId(edge);
      const touchesFocus = Boolean(focusId) && edgeTouches(edge, focusId as string);
      // Under a tour, only an edge *between two things the stop is about* is part
      // of the story. An edge from a lit node out into the dark is not the point
      // being made, and lighting it would draw the eye off the stop.
      const inTour = touring
        ? touring.has(edge.from) && touring.has(edge.to)
        : false;
      const logical = edge.kind === "logical";
      // A merged edge's honest label is how many relationships it stands for
      // (GP-88); a lone edge keeps whatever label it carried.
      const label = edge.count && edge.count > 1 ? `×${edge.count}` : edge.label;
      // Colour/dash come from the relationship + inferred flag (GP-30), applied
      // by the RelationshipEdge component — no re-layout on selection. Drawn in
      // impact-flow direction (dependency → dependent) to match the layout
      // (GP-31); the relationship is still computed from the true dependency.
      return {
        id,
        source: edge.to,
        target: edge.from,
        type: "relationship",
        data: {
          rel: edgeRel(byId.get(edge.from), byId.get(edge.to)),
          dimmed: touring ? !inTour : Boolean(focusId) && !touchesFocus,
          // Lit: this edge belongs to the node you are pointing at (or to the
          // stop you are being shown). Everything else recedes, so one
          // relationship can be traced through a crossing.
          active: touring ? inTour : touchesFocus,
          inferred: edge.inferred === true,
          route: routes.get(id),
          // A logical edge wears the annotation treatment — dashed, accent-toned,
          // no arrowhead — because it is exactly that: a human relationship drawn
          // over a generated diagram, and it must not pass for a dependency the
          // code declares.
          annotation: logical,
          ...(label ? { label } : {}),
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
