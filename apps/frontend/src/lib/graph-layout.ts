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

import type { ChangeKind, Graph, GraphNode } from "@/api/types";
import { categorize, type Category } from "@/lib/resource-category";

// changeLabel now lives with the shared status metadata (GP-28); re-exported here
// so existing importers (node-details-panel, …) keep working.
export { changeLabel } from "@/lib/status";

const RESOURCE_WIDTH = 220;
const RESOURCE_HEIGHT = 56;
const MODULE_LEAF_WIDTH = 200;

/** Minimal shape of the ELK graph we send and get back (x/y/w/h filled in). */
export interface ElkGraphNode {
  id: string;
  width?: number;
  height?: number;
  x?: number;
  y?: number;
  layoutOptions?: Record<string, string>;
  children?: ElkGraphNode[];
  edges?: { id: string; sources: string[]; targets: string[] }[];
}

export const ELK_ROOT_OPTIONS: Record<string, string> = {
  "elk.algorithm": "layered",
  "elk.direction": "RIGHT",
  "elk.hierarchyHandling": "INCLUDE_CHILDREN",
  "elk.layered.spacing.nodeNodeBetweenLayers": "64",
  "elk.spacing.nodeNode": "28",
  "elk.padding": "[top=24,left=24,bottom=24,right=24]",
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

/** Build the nested ELK input graph (no positions yet). */
export function toElkGraph(graph: Graph): ElkGraphNode {
  const parentOf = new Map<string, string>();
  for (const edge of graph.edges) {
    if (edge.kind === "contains") parentOf.set(edge.to, edge.from);
  }

  const elkById = new Map<string, ElkGraphNode>();
  for (const node of graph.nodes) {
    elkById.set(
      node.id,
      isModule(node)
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

  for (const elk of elkById.values()) {
    if (elk.children && elk.children.length === 0) {
      delete elk.children;
      delete elk.layoutOptions;
      elk.width = MODULE_LEAF_WIDTH;
      elk.height = RESOURCE_HEIGHT;
    }
  }

  const edges = graph.edges
    .filter((edge) => edge.kind === "depends_on")
    .map((edge, i) => ({
      id: `dep-${i}`,
      sources: [edge.from],
      targets: [edge.to],
    }));

  return { id: "root", layoutOptions: ELK_ROOT_OPTIONS, children: roots, edges };
}

const DEFAULT_VIEW: ViewState = {
  activeFilters: new Set(ALL_FILTERS),
  selectedId: null,
};

/** Map a laid-out ELK graph back to React Flow nodes + edges, applying filters. */
export function elkToFlow(
  layout: ElkGraphNode,
  graph: Graph,
  view: ViewState = DEFAULT_VIEW,
): FlowElements {
  const { activeFilters, activeCategories, activeModules, selectedId } = view;
  const neighbors = selectedId ? neighborhood(graph, selectedId) : null;
  const byId = new Map(graph.nodes.map((n) => [n.id, n]));

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
      const container = Boolean(elk.children && elk.children.length > 0);
      nodes.push({
        id: elk.id,
        type: container ? "module" : "resource",
        position: { x: elk.x ?? 0, y: elk.y ?? 0 },
        data: {
          graphNode,
          dimmed: dimmedOf(graphNode),
          selected: selectedId === graphNode.id,
        },
        style: { width: elk.width, height: elk.height },
        ...(parentId ? { parentId, extent: "parent" as const } : {}),
      });
    }
    for (const child of elk.children ?? []) walk(child, elk.id);
  };
  for (const child of layout.children ?? []) walk(child);

  const edges: FlowEdge[] = graph.edges
    .filter((edge) => edge.kind === "depends_on")
    .map((edge, i) => {
      const dimmed = Boolean(
        selectedId && edge.from !== selectedId && edge.to !== selectedId,
      );
      // Colour/dash come from the relationship + inferred flag (GP-30), applied
      // by the RelationshipEdge component — no re-layout on selection.
      return {
        id: `dep-${i}`,
        source: edge.from,
        target: edge.to,
        type: "relationship",
        data: {
          rel: edgeRel(byId.get(edge.from), byId.get(edge.to)),
          dimmed,
          inferred: edge.inferred === true,
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
