/**
 * Where the Build Editor's containers are and how big they are (GP-247).
 *
 * The document stores one absolute position per node — where the user put it —
 * and React Flow wants a child's position relative to its parent plus an
 * explicit size for every frame. This is the conversion, kept pure so the
 * geometry can be reasoned about without a canvas.
 *
 * A container is sized to hold what is in it, never the other way round:
 * nothing moves because something else was dropped, which is the difference
 * between a canvas and a layout engine (the builder deliberately has no ELK
 * pass — positions are the user's).
 */
import { isContainerType, type BuilderGraph, type ResourceDef } from "@groundplan/builder";

export type Box = { x: number; y: number; width: number; height: number };

/** A resource card's footprint — the node component's own size. */
export const CARD_WIDTH = 220;
export const CARD_HEIGHT = 96;
/** Room inside a frame: the label sits above the first child. */
export const CONTAINER_PADDING = 20;
export const CONTAINER_HEADER = 34;
/** An empty frame is still a place you can drop something. */
export const CONTAINER_MIN_WIDTH = 300;
export const CONTAINER_MIN_HEIGHT = 180;

/**
 * A node is drawn as a frame when something is inside it, or when its type is
 * one that can hold something — an empty resource group has to look like
 * somewhere to drop a network before anything is in it.
 */
export function drawsAsContainer(
  graph: BuilderGraph,
  id: string,
  catalog?: readonly ResourceDef[],
): boolean {
  const node = graph.nodes.find((n) => n.id === id);
  if (!node) return false;
  if (graph.nodes.some((n) => n.parentId === id)) return true;
  return catalog
    ? isContainerType(node.type, catalog)
    : isContainerType(node.type);
}

/** Every node's absolute box, containers sized around what they hold. */
export function absoluteBoxes(
  graph: BuilderGraph,
  catalog?: readonly ResourceDef[],
): Map<string, Box> {
  const boxes = new Map<string, Box>();
  const walking = new Set<string>();

  function boxOf(id: string): Box {
    const known = boxes.get(id);
    if (known) return known;
    const node = graph.nodes.find((n) => n.id === id);
    if (!node) return { x: 0, y: 0, width: CARD_WIDTH, height: CARD_HEIGHT };
    // Broken data (a parent cycle) must not hang the canvas.
    if (walking.has(id)) {
      return { ...node.position, width: CARD_WIDTH, height: CARD_HEIGHT };
    }
    walking.add(id);

    const children = graph.nodes.filter((n) => n.parentId === id);
    const container = drawsAsContainer(graph, id, catalog);
    let box: Box;
    if (children.length === 0) {
      box = container
        ? {
            ...node.position,
            width: CONTAINER_MIN_WIDTH,
            height: CONTAINER_MIN_HEIGHT,
          }
        : { ...node.position, width: CARD_WIDTH, height: CARD_HEIGHT };
    } else {
      const childBoxes = children.map((child) => boxOf(child.id));
      const right = Math.max(...childBoxes.map((b) => b.x + b.width));
      const bottom = Math.max(...childBoxes.map((b) => b.y + b.height));
      box = {
        ...node.position,
        width: Math.max(
          CONTAINER_MIN_WIDTH,
          right - node.position.x + CONTAINER_PADDING,
        ),
        height: Math.max(
          CONTAINER_MIN_HEIGHT,
          bottom - node.position.y + CONTAINER_PADDING,
        ),
      };
    }
    walking.delete(id);
    boxes.set(id, box);
    return box;
  }

  for (const node of graph.nodes) boxOf(node.id);
  return boxes;
}

/**
 * The position React Flow wants: relative to the parent frame, never above or
 * left of the room inside it, so a child cannot hide under its own label.
 */
export function relativePosition(
  boxes: Map<string, Box>,
  node: { id: string; position: { x: number; y: number }; parentId?: string },
): { x: number; y: number } {
  const parent = node.parentId ? boxes.get(node.parentId) : undefined;
  if (!parent) return node.position;
  return {
    x: Math.max(CONTAINER_PADDING, node.position.x - parent.x),
    y: Math.max(CONTAINER_HEADER, node.position.y - parent.y),
  };
}

/**
 * Outermost first. React Flow requires a parent to appear before its children,
 * and a document that has been dragged around is in no particular order.
 */
export function byDepth(graph: BuilderGraph): BuilderGraph["nodes"] {
  const depth = new Map<string, number>();
  const depthOf = (id: string, seen = new Set<string>()): number => {
    const known = depth.get(id);
    if (known !== undefined) return known;
    const node = graph.nodes.find((n) => n.id === id);
    if (!node?.parentId || seen.has(id)) return 0;
    seen.add(id);
    const value = depthOf(node.parentId, seen) + 1;
    depth.set(id, value);
    return value;
  };
  return [...graph.nodes].sort((a, b) => depthOf(a.id) - depthOf(b.id));
}

/**
 * Which container a point lands in: the innermost one that holds it, so
 * dropping into a subnet drawn inside a vnet means the subnet.
 */
export function containerAt(
  graph: BuilderGraph,
  boxes: Map<string, Box>,
  point: { x: number; y: number },
  ignore?: string,
): string | undefined {
  const hits = graph.nodes.filter((node) => {
    if (node.id === ignore) return false;
    if (!drawsAsContainer(graph, node.id)) return false;
    const box = boxes.get(node.id);
    return (
      box !== undefined &&
      point.x >= box.x &&
      point.x <= box.x + box.width &&
      point.y >= box.y &&
      point.y <= box.y + box.height
    );
  });
  // Innermost = smallest area; a nested frame is always smaller than its host.
  let best: { id: string; area: number } | undefined;
  for (const node of hits) {
    const box = boxes.get(node.id);
    if (!box) continue;
    const area = box.width * box.height;
    if (!best || area < best.area) best = { id: node.id, area };
  }
  return best?.id;
}
