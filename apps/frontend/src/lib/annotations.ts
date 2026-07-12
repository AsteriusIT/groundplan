/**
 * Pure helpers that turn the annotation layer (GP-56) into things the docs
 * canvas can render as an overlay — WITHOUT ever feeding it to ELK, so the
 * generated layout is identical with and without annotations (GP-58).
 */
import type { Annotation } from "@/api/types";

/** Padding (px, flow coordinates) around a group's member bounding box. */
const GROUP_PADDING = 24;

/** A node's laid-out box in flow coordinates. */
export type NodeBox = { x: number; y: number; width: number; height: number };

/** Minimal React-Flow node shape needed to resolve absolute geometry. */
export type PositionedNode = {
  id: string;
  position: { x: number; y: number };
  style?: { width?: number | string; height?: number | string };
  parentId?: string;
};

const DEFAULT_W = 200;
const DEFAULT_H = 56;

function dim(value: number | string | undefined, fallback: number): number {
  return typeof value === "number" ? value : fallback;
}

/**
 * Absolute bounding boxes for React Flow nodes. A nested node's `position` is
 * relative to its parent, so we sum the parent chain — giving group frames a
 * correct hull even when members live inside module containers.
 */
export function absoluteNodeBoxes(
  nodes: PositionedNode[],
): Map<string, NodeBox> {
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const abs = new Map<string, { x: number; y: number }>();

  const originOf = (node: PositionedNode): { x: number; y: number } => {
    const cached = abs.get(node.id);
    if (cached) return cached;
    const parent = node.parentId ? byId.get(node.parentId) : undefined;
    const base = parent ? originOf(parent) : { x: 0, y: 0 };
    const origin = { x: base.x + node.position.x, y: base.y + node.position.y };
    abs.set(node.id, origin);
    return origin;
  };

  const boxes = new Map<string, NodeBox>();
  for (const node of nodes) {
    const origin = originOf(node);
    boxes.set(node.id, {
      x: origin.x,
      y: origin.y,
      width: dim(node.style?.width, DEFAULT_W),
      height: dim(node.style?.height, DEFAULT_H),
    });
  }
  return boxes;
}

/** A labeled annotation edge to inject into React Flow after layout. */
export type AnnotationEdge = {
  id: string;
  source: string;
  target: string;
  label: string;
};

/** A soft frame drawn behind a group's members. */
export type GroupFrame = {
  id: string;
  label: string;
  x: number;
  y: number;
  width: number;
  height: number;
};

/**
 * Only annotations whose every anchor still exists in the displayed graph are
 * renderable — an orphaned annotation has an anchor with nowhere to draw, so it
 * lives in the orphan-review list (GP-59) until fixed, never on the canvas.
 */
export function renderableAnnotations(
  annotations: Annotation[],
  nodeIds: ReadonlySet<string>,
): Annotation[] {
  return annotations.filter((a) => a.anchors.every((anchor) => nodeIds.has(anchor)));
}

/** Notes anchored to a specific node (links/groups excluded). */
export function notesForNode(annotations: Annotation[], nodeId: string): Annotation[] {
  return annotations.filter((a) => a.type === "note" && a.anchors[0] === nodeId);
}

/** Node ids that carry at least one note — used to badge them on the canvas. */
export function notedNodeIds(annotations: Annotation[]): Set<string> {
  const ids = new Set<string>();
  for (const a of annotations) {
    if (a.type === "note" && a.anchors[0]) ids.add(a.anchors[0]);
  }
  return ids;
}

/** Link annotations as labeled source→target edge descriptors. */
export function annotationLinkEdges(annotations: Annotation[]): AnnotationEdge[] {
  const edges: AnnotationEdge[] = [];
  for (const a of annotations) {
    if (a.type !== "link") continue;
    const [source, target] = a.anchors;
    if (source && target) {
      edges.push({ id: a.id, source, target, label: a.label ?? "" });
    }
  }
  return edges;
}

/**
 * A padded bounding box around each group's members. Members without a known
 * position are ignored; a group with no positioned member yields no frame.
 */
export function groupFrames(
  annotations: Annotation[],
  positions: ReadonlyMap<string, NodeBox>,
): GroupFrame[] {
  const frames: GroupFrame[] = [];
  for (const a of annotations) {
    if (a.type !== "group") continue;
    const boxes = a.anchors
      .map((anchor) => positions.get(anchor))
      .filter((b): b is NodeBox => b !== undefined);
    if (boxes.length === 0) continue;

    const minX = Math.min(...boxes.map((b) => b.x));
    const minY = Math.min(...boxes.map((b) => b.y));
    const maxX = Math.max(...boxes.map((b) => b.x + b.width));
    const maxY = Math.max(...boxes.map((b) => b.y + b.height));
    frames.push({
      id: a.id,
      label: a.label ?? "",
      x: minX - GROUP_PADDING,
      y: minY - GROUP_PADDING,
      width: maxX - minX + GROUP_PADDING * 2,
      height: maxY - minY + GROUP_PADDING * 2,
    });
  }
  return frames;
}
