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
 * The `group` annotations that have at least one member on the canvas. A logical
 * edge between two groups anchors to their *ids* rather than to Terraform
 * addresses (GP-71), so this is what such an anchor is resolved against.
 */
function drawnGroupIds(
  annotations: Annotation[],
  nodeIds: ReadonlySet<string>,
): Set<string> {
  return new Set(
    annotations
      .filter((a) => a.type === "group")
      .filter((a) => a.anchors.some((anchor) => nodeIds.has(anchor)))
      .map((a) => a.id),
  );
}

/**
 * Does this anchor point at something that is actually on the canvas — a node,
 * or a group that is itself being drawn?
 */
function anchorResolves(
  anchor: string,
  nodeIds: ReadonlySet<string>,
  drawnGroups: ReadonlySet<string>,
): boolean {
  return nodeIds.has(anchor) || drawnGroups.has(anchor);
}

/**
 * The annotations we can actually draw. Two exclusions, for two different reasons:
 *
 *   - an **orphan** has an anchor with nowhere to land, so it lives in the orphan
 *     tray (GP-59) until a human fixes or drops it — never on the canvas;
 *   - a **proposal** (GP-75) has not been agreed to. It belongs in the review
 *     inbox (GP-76). Drawing it would be the machine editing your diagram.
 *
 * Group frames are resolved first, because a logical edge may be anchored to a
 * group: an edge into a group nobody is drawing is not renderable either.
 */
export function renderableAnnotations(
  annotations: Annotation[],
  nodeIds: ReadonlySet<string>,
): Annotation[] {
  const live = annotations.filter((a) => a.status !== "proposed");
  const drawnGroups = drawnGroupIds(live, nodeIds);
  return live.filter((a) =>
    a.type === "group"
      ? drawnGroups.has(a.id)
      : a.anchors.every((anchor) => anchorResolves(anchor, nodeIds, drawnGroups)),
  );
}

/** Node ids a `hide` annotation asks the adapted view to drop (GP-72). */
export function hiddenNodeIds(annotations: Annotation[]): Set<string> {
  const ids = new Set<string>();
  for (const a of annotations) {
    if (a.type === "hide" && a.status === "resolved" && a.anchors[0]) {
      ids.add(a.anchors[0]);
    }
  }
  return ids;
}

/** The display label a `rename` annotation gives a node, by node id (GP-72). */
export function renamedLabels(annotations: Annotation[]): Map<string, string> {
  const labels = new Map<string, string>();
  for (const a of annotations) {
    if (a.type === "rename" && a.status === "resolved" && a.anchors[0] && a.label) {
      labels.set(a.anchors[0], a.label);
    }
  }
  return labels;
}

/** Notes anchored to a specific node (links/groups excluded). */
export function notesForNode(annotations: Annotation[], nodeId: string): Annotation[] {
  return annotations.filter((a) => a.type === "note" && a.anchors[0] === nodeId);
}

/** An orphaned annotation and precisely which of its anchors are missing. */
export type Orphan = { annotation: Annotation; missing: string[] };

/**
 * Annotations with at least one anchor missing from the displayed graph (GP-59).
 * Computed against the *current* snapshot's node ids, so re-anchoring to a
 * present address clears the orphan immediately, no regeneration required.
 *
 * Proposals are not orphans — they are not part of the picture yet, so there is
 * nothing for them to have lost. A logical edge into a group that still has
 * members is not an orphan either, even though its anchor is not a node id.
 */
export function orphanedAnnotations(
  annotations: Annotation[],
  nodeIds: ReadonlySet<string>,
): Orphan[] {
  const live = annotations.filter((a) => a.status !== "proposed");
  const drawnGroups = drawnGroupIds(live, nodeIds);
  const out: Orphan[] = [];
  for (const annotation of live) {
    const missing = annotation.anchors.filter(
      (a) => !anchorResolves(a, nodeIds, drawnGroups),
    );
    if (missing.length > 0) out.push({ annotation, missing });
  }
  return out;
}

/** Replace a missing anchor with a chosen address, preserving anchor order. */
export function reanchor(
  anchors: string[],
  missing: string,
  replacement: string,
): string[] {
  return anchors.map((a) => (a === missing ? replacement : a));
}

/** Node ids that carry at least one note — used to badge them on the canvas. */
export function notedNodeIds(annotations: Annotation[]): Set<string> {
  const ids = new Set<string>();
  for (const a of annotations) {
    if (a.type === "note" && a.anchors[0]) ids.add(a.anchors[0]);
  }
  return ids;
}

/**
 * The React Flow node id a group frame is drawn under. Group frames are overlay
 * nodes, so an edge anchored to a group has to point at the *frame*, not at the
 * annotation.
 */
export const groupFrameNodeId = (annotationId: string): string =>
  `ann-group-${annotationId}`;

/**
 * Link annotations as labeled source→target edge descriptors. An endpoint is
 * either a Terraform address (draw to the node) or a group id (draw to the
 * group's frame) — which is how a group→group edge lands on the canvas.
 */
export function annotationLinkEdges(annotations: Annotation[]): AnnotationEdge[] {
  const groups = new Set(
    annotations.filter((a) => a.type === "group").map((a) => a.id),
  );
  const endpoint = (anchor: string) =>
    groups.has(anchor) ? groupFrameNodeId(anchor) : anchor;

  const edges: AnnotationEdge[] = [];
  for (const a of annotations) {
    if (a.type !== "link") continue;
    const [source, target] = a.anchors;
    if (source && target) {
      edges.push({
        id: a.id,
        source: endpoint(source),
        target: endpoint(target),
        label: a.label ?? "",
      });
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
