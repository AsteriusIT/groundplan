/**
 * Turn a GraphSnapshot graph into the elements React Flow renders, using ELK for
 * a layered hierarchical layout. Pure and side-effect free (the async ELK call
 * itself lives in the GraphCanvas component) so the mapping is unit-testable.
 *
 * `contains` edges become node nesting (module = container / group node);
 * `depends_on` edges become drawn edges between resources.
 */
import type { Edge as FlowEdge, Node as FlowNode } from "@xyflow/react";

import type { ChangeKind, Graph, GraphNode } from "@/api/types";

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
  /** True when the "changes only" filter should visually mute this node. */
  dimmed: boolean;
  [key: string]: unknown;
};

export type FlowElements = {
  nodes: FlowNode<GraphNodeData>[];
  edges: FlowEdge[];
};

const isModule = (node: GraphNode) => node.type === "module";

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

  // A module with no children is a leaf (registry/empty module) — size it.
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

/** Map a laid-out ELK graph back to React Flow nodes + edges. */
export function elkToFlow(
  layout: ElkGraphNode,
  graph: Graph,
  options: { changesOnly?: boolean } = {},
): FlowElements {
  const changesOnly = options.changesOnly ?? false;
  const byId = new Map(graph.nodes.map((n) => [n.id, n]));
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
          dimmed: changesOnly && graphNode.change === "noop",
        },
        style: { width: elk.width, height: elk.height },
        ...(parentId ? { parentId, extent: "parent" as const } : {}),
        ...(container ? { selectable: true } : {}),
      });
    }
    for (const child of elk.children ?? []) walk(child, elk.id);
  };
  for (const child of layout.children ?? []) walk(child);

  const edges: FlowEdge[] = graph.edges
    .filter((edge) => edge.kind === "depends_on")
    .map((edge, i) => ({
      id: `dep-${i}`,
      source: edge.from,
      target: edge.to,
      animated: false,
    }));

  return { nodes, edges };
}

/** Border/background/text classes for a node's change kind. */
export const CHANGE_STYLES: Record<ChangeKind | "none", string> = {
  create: "border-emerald-400 bg-emerald-50 text-emerald-900",
  update: "border-amber-400 bg-amber-50 text-amber-900",
  delete: "border-destructive/60 bg-destructive/5 text-destructive border-dashed",
  noop: "border-border bg-card text-foreground",
  none: "border-border bg-card text-foreground",
};

const CHANGE_LABELS: Record<ChangeKind, string> = {
  create: "Create",
  update: "Update",
  delete: "Delete",
  noop: "No change",
};

export function changeLabel(change: ChangeKind | null): string {
  return change ? CHANGE_LABELS[change] : "—";
}

export function changeClasses(change: ChangeKind | null): string {
  return CHANGE_STYLES[change ?? "none"];
}
