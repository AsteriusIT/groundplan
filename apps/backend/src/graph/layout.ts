/**
 * Server-side ELK layout for snapshot export (GP-37). This is the backend twin
 * of the frontend `lib/graph-layout.ts`: same nesting (contains → module
 * container), same reversed depends_on edges (dependency → dependent, laid out
 * left→right so "impact flows along arrows", GP-31), same node sizes — so an
 * exported SVG mirrors what the app draws.
 *
 * elkjs runs unchanged in Node. ELK returns child coordinates relative to their
 * parent; we flatten them to absolute positions so the SVG renderer can place
 * everything in one coordinate space.
 */
import ElkBundled from "elkjs/lib/elk.bundled.js";

import type { Graph, GraphNode } from "./graph.js";

export const RESOURCE_WIDTH = 220;
const RESOURCE_HEIGHT = 56;
export const MODULE_LEAF_WIDTH = 200;

// Mirrors ELK_ROOT_OPTIONS on the frontend.
const ELK_ROOT_OPTIONS: Record<string, string> = {
  "elk.algorithm": "layered",
  "elk.direction": "RIGHT",
  "elk.hierarchyHandling": "INCLUDE_CHILDREN",
  "elk.layered.spacing.nodeNodeBetweenLayers": "96",
  "elk.layered.spacing.edgeNodeBetweenLayers": "24",
  "elk.spacing.nodeNode": "40",
  "elk.spacing.edgeNode": "24",
  "elk.padding": "[top=28,left=28,bottom=28,right=28]",
};

const ELK_MODULE_OPTIONS: Record<string, string> = {
  "elk.padding": "[top=36,left=16,bottom=16,right=16]",
};

interface ElkPoint {
  x: number;
  y: number;
}
interface ElkEdgeSection {
  startPoint: ElkPoint;
  endPoint: ElkPoint;
  bendPoints?: ElkPoint[];
}
interface ElkNode {
  id: string;
  x?: number;
  y?: number;
  width?: number;
  height?: number;
  layoutOptions?: Record<string, string>;
  children?: ElkNode[];
  edges?: ElkEdge[];
}
interface ElkEdge {
  id: string;
  sources: string[];
  targets: string[];
  sections?: ElkEdgeSection[];
}

// elkjs ships a CJS bundle whose default export IS the ELK constructor, but the
// bundled .d.ts trips NodeNext's ESM/CJS interop — so bind it through a narrow
// cast to the single method we use.
const ELK = ElkBundled as unknown as new () => {
  layout(graph: ElkNode): Promise<ElkNode>;
};
const elk = new ELK();

/** How an edge relates to the change set (mirrors the frontend `edgeRel`). */
export type EdgeRel = "new" | "removed" | "impact" | "neutral";

export function edgeRel(from: GraphNode | undefined, to: GraphNode | undefined): EdgeRel {
  if (from?.change === "delete" || to?.change === "delete") return "removed";
  if (to?.change === "create") return "new";
  if (from?.impacted || to?.impacted) return "impact";
  return "neutral";
}

const isModule = (node: GraphNode): boolean => node.type === "module";

/** A node placed in absolute coordinates. */
export interface PlacedNode {
  id: string;
  node: GraphNode;
  x: number;
  y: number;
  w: number;
  h: number;
  isModule: boolean;
}

/** An edge routed through absolute points, with its relationship + inferred flag. */
export interface PlacedEdge {
  id: string;
  rel: EdgeRel;
  inferred: boolean;
  points: ElkPoint[];
}

/** A fully laid-out graph in one absolute coordinate space. */
export interface LaidOutGraph {
  width: number;
  height: number;
  nodes: PlacedNode[];
  edges: PlacedEdge[];
}

/** Optional per-consumer sizing (the draw.io export widens nodes to fit labels). */
export interface LayoutOptions {
  nodeWidth?: (node: GraphNode) => number;
}

/** Build the nested ELK input graph (mirrors the frontend `toElkGraph`). */
function toElkGraph(graph: Graph, opts: LayoutOptions): ElkNode {
  const parentOf = new Map<string, string>();
  for (const edge of graph.edges) {
    if (edge.kind === "contains") parentOf.set(edge.to, edge.from);
  }

  const elkById = new Map<string, ElkNode>();
  for (const node of graph.nodes) {
    elkById.set(
      node.id,
      isModule(node)
        ? { id: node.id, layoutOptions: ELK_MODULE_OPTIONS, children: [] }
        : { id: node.id, width: opts.nodeWidth?.(node) ?? RESOURCE_WIDTH, height: RESOURCE_HEIGHT },
    );
  }

  const roots: ElkNode[] = [];
  for (const node of graph.nodes) {
    const elkNode = elkById.get(node.id)!;
    const parentId = parentOf.get(node.id);
    const parent = parentId ? elkById.get(parentId) : undefined;
    if (parent?.children) parent.children.push(elkNode);
    else roots.push(elkNode);
  }

  for (const node of graph.nodes) {
    const elkNode = elkById.get(node.id)!;
    if (elkNode.children?.length === 0) {
      delete elkNode.children;
      delete elkNode.layoutOptions;
      elkNode.width = opts.nodeWidth?.(node) ?? MODULE_LEAF_WIDTH;
      elkNode.height = RESOURCE_HEIGHT;
    }
  }

  const edges: ElkEdge[] = graph.edges
    .filter((edge) => edge.kind === "depends_on")
    .map((edge, i) => ({ id: `dep-${i}`, sources: [edge.to], targets: [edge.from] }));

  return { id: "root", layoutOptions: ELK_ROOT_OPTIONS, children: roots, edges };
}

/** Recursively flatten laid-out ELK nodes to absolute-positioned rects. */
function flatten(
  elkNode: ElkNode,
  byId: Map<string, GraphNode>,
  offsetX: number,
  offsetY: number,
  out: PlacedNode[],
): void {
  for (const child of elkNode.children ?? []) {
    const graphNode = byId.get(child.id);
    const x = offsetX + (child.x ?? 0);
    const y = offsetY + (child.y ?? 0);
    if (graphNode) {
      out.push({
        id: child.id,
        node: graphNode,
        x,
        y,
        w: child.width ?? RESOURCE_WIDTH,
        h: child.height ?? RESOURCE_HEIGHT,
        isModule: Boolean(child.children && child.children.length > 0),
      });
    }
    flatten(child, byId, x, y, out);
  }
}

/** Lay out a graph and return every node + edge in one absolute space. */
export async function layoutGraph(graph: Graph, opts: LayoutOptions = {}): Promise<LaidOutGraph> {
  const byId = new Map(graph.nodes.map((n) => [n.id, n]));
  const input = toElkGraph(graph, opts);
  const result = (await elk.layout(input)) as ElkNode;

  const nodes: PlacedNode[] = [];
  flatten(result, byId, 0, 0, nodes);

  const placedById = new Map(nodes.map((p) => [p.id, p]));
  const depEdges = graph.edges.filter((e) => e.kind === "depends_on");
  const sectionById = new Map(
    (result.edges ?? []).map((e) => [e.id, e.sections?.[0]]),
  );

  const edges: PlacedEdge[] = depEdges.map((edge, i) => {
    const rel = edgeRel(byId.get(edge.from), byId.get(edge.to));
    const inferred = edge.inferred === true;
    const section = sectionById.get(`dep-${i}`);
    if (section) {
      const points = [section.startPoint, ...(section.bendPoints ?? []), section.endPoint];
      return { id: `dep-${i}`, rel, inferred, points };
    }
    // Fallback: a straight line from the dependency's right edge to the
    // dependent's left edge (matching the RIGHT layout direction).
    const src = placedById.get(edge.to);
    const dst = placedById.get(edge.from);
    const points: ElkPoint[] =
      src && dst
        ? [
            { x: src.x + src.w, y: src.y + src.h / 2 },
            { x: dst.x, y: dst.y + dst.h / 2 },
          ]
        : [];
    return { id: `dep-${i}`, rel, inferred, points };
  });

  return {
    width: result.width ?? 0,
    height: result.height ?? 0,
    nodes,
    edges,
  };
}
