/**
 * What the Build Editor's nodes say, and how big that makes them (GP-247).
 *
 * The document stores one absolute position per node — where the user put it —
 * and React Flow wants a child's position relative to its parent plus an
 * explicit size for every frame. This is the conversion, kept pure so the
 * geometry can be reasoned about without a canvas.
 *
 * Size follows content, in both directions. A card is as wide as the longest
 * thing written on it, so a name is never cut short or broken across lines, and
 * a frame is as wide as the label on its edge and everything inside it. Text is
 * measured rather than laid out: every string on a card is monospace, so its
 * width is its length — which is why the strings themselves are derived here,
 * beside the measuring, and the components draw what this module measured.
 *
 * A container is sized to hold what is in it, never the other way round:
 * nothing moves because something else was dropped, which is the difference
 * between a canvas and a layout engine (the builder deliberately has no ELK
 * pass — positions are the user's).
 */
import {
  canContain,
  isContainerType,
  resourceDef,
  type BuilderGraph,
  type BuilderNode,
  type ResourceDef,
} from "@groundplan/builder";

export type Box = { x: number; y: number; width: number; height: number };

// --- what a node says ------------------------------------------------------

/** The shortest honest label for a type on a card. */
export function shortResourceType(type: string): string {
  return type.replace(/^azurerm_/, "");
}

/** The Azure name the resource will carry, when it has been filled in. */
export function azureName(node: BuilderNode): string | null {
  const value = node.attributes.name;
  return typeof value === "string" && value.trim() !== "" ? value : null;
}

/** A card's type line: a resource type, or the absence of one. */
export function typeLabel(node: BuilderNode): string {
  return node.type === "" ? "custom resource" : shortResourceType(node.type);
}

/** One input row on a card: a slot, or a custom node's named reference. */
export type BuilderInput = {
  attribute: string;
  label: string;
  required: boolean;
  /** The names connected into it, in order. */
  targets: string[];
};

/** The input rows of a node: its catalog slots, or a custom node's references. */
export function inputsOf(
  graph: BuilderGraph,
  node: BuilderNode,
  catalog?: readonly ResourceDef[],
): BuilderInput[] {
  const names = new Map(graph.nodes.map((n) => [n.id, n.name]));
  const targetsOf = (attribute: string) =>
    graph.references
      .filter((r) => r.from === node.id && r.attribute === attribute)
      .flatMap((r) => {
        const name = names.get(r.to);
        return name ? [name] : [];
      });

  if (node.custom) {
    // One row per attribute, however many things are connected into it.
    const attributes = [
      ...new Set(
        graph.references.filter((r) => r.from === node.id).map((r) => r.attribute),
      ),
    ];
    return attributes.map((attribute) => ({
      attribute,
      label: attribute,
      required: false,
      targets: targetsOf(attribute),
    }));
  }

  const def = resourceDef(node.type, catalog);
  return (def?.references ?? []).map((slot) => ({
    attribute: slot.attribute,
    label: slot.label,
    required: slot.required,
    targets: targetsOf(slot.attribute),
  }));
}

/** What a slot row says on its right: what fills it, or what it is waiting for. */
export function slotValue(input: BuilderInput): string {
  if (input.targets.length > 0) return input.targets.join(", ");
  return input.required ? "required" : "optional";
}

// --- how wide that makes it ------------------------------------------------

/**
 * How much of its size a monospace glyph advances. IBM Plex Mono — the app's
 * `font-mono` — advances 0.6em exactly; the rest is room for a fallback face
 * that is a little wider, since a card that is a few pixels roomier than its
 * text is invisible and one a few pixels short is not.
 */
export const MONO_ADVANCE = 0.62;

/** How wide a run of monospace text is, at a size and (rarely) a tracking. */
export function textWidth(text: string, fontSize: number, tracking = 0): number {
  return Math.ceil(text.length * (fontSize * MONO_ADVANCE + tracking));
}

/** `px-3`. */
const PADDING = 12;
/** `gap-2`. */
const GAP = 8;
/** The vendor icon, `size-4`. */
const ICON = 16;
/**
 * Room for the problem badge, kept whether or not there is a problem: a card
 * that changed size on becoming invalid would shove its neighbours around at
 * the worst possible moment.
 */
const BADGE = 34;
/** The same reservation for a slot row's problem dot. */
const DOT = 14;

/** The narrowest a card is drawn, however little it has to say. */
export const CARD_MIN_WIDTH = 240;
/** Icon, type, both names — the card's head, before any slot rows. */
export const CARD_HEAD_HEIGHT = 76;
/** One slot row. */
export const CARD_ROW_HEIGHT = 24;
/** Room inside a frame: the label sits above the first child. */
export const CONTAINER_PADDING = 20;
export const CONTAINER_HEADER = 34;
/** An empty frame is still a place you can drop something. */
export const CONTAINER_MIN_WIDTH = 300;
export const CONTAINER_MIN_HEIGHT = 180;

/**
 * A node is drawn as a frame when something is inside it — and only then.
 *
 * An empty resource group is a card: compact, readable, with its own slots and
 * handles, like everything else. Drawing every container *type* as a frame the
 * moment it was placed filled the canvas with three-hundred-pixel empty boxes
 * that overlapped each other before you had composed anything. A frame is what
 * a resource becomes when it has something to hold, not a claim about what it
 * could hold one day — {@link acceptsDrop} is where that claim lives.
 */
export function drawsAsContainer(graph: BuilderGraph, id: string): boolean {
  return graph.nodes.some((n) => n.parentId === id);
}

/**
 * May something be dropped into this node? A card can be: the catalog says a
 * virtual network belongs in a resource group whether or not that resource
 * group is holding anything yet.
 */
export function acceptsDrop(
  graph: BuilderGraph,
  id: string,
  catalog?: readonly ResourceDef[],
  childType?: string,
): boolean {
  const node = graph.nodes.find((n) => n.id === id);
  if (!node) return false;
  if (childType) return canContain(node.type, childType, catalog);
  return catalog
    ? isContainerType(node.type, catalog)
    : isContainerType(node.type);
}

/**
 * How wide a card is: whatever its longest line needs. Names are the reason —
 * a resource carries the name its owner gave it, and `st-prod-weu-payments-01`
 * cut down to `st-prod-weu-pa…` is a card that has stopped being a diagram.
 */
export function cardWidth(
  graph: BuilderGraph,
  id: string,
  catalog?: readonly ResourceDef[],
): number {
  const node = graph.nodes.find((n) => n.id === id);
  if (!node) return CARD_MIN_WIDTH;

  const head =
    PADDING +
    ICON +
    GAP +
    Math.max(
      textWidth(typeLabel(node), 12),
      textWidth(azureName(node) ?? "unnamed", 11),
      textWidth(`.${node.name}`, 10),
    ) +
    BADGE +
    PADDING;

  const rows = inputsOf(graph, node, catalog).map(
    (input) =>
      PADDING +
      textWidth(input.label, 10) +
      GAP +
      textWidth(slotValue(input), 10) +
      DOT +
      PADDING,
  );

  return Math.max(CARD_MIN_WIDTH, head, ...rows);
}

/** How tall a card is: its head, plus a row per slot it shows. */
export function cardHeight(
  graph: BuilderGraph,
  id: string,
  catalog?: readonly ResourceDef[],
): number {
  const node = graph.nodes.find((n) => n.id === id);
  if (!node) return CARD_HEAD_HEIGHT;
  const rows = inputsOf(graph, node, catalog).length + (node.custom ? 1 : 0);
  return CARD_HEAD_HEIGHT + rows * CARD_ROW_HEIGHT;
}

/** `left-3`, and the same again on the right so the label ends inside. */
const CHIP_INSET = 12;
/** `px-2`. */
const CHIP_PADDING = 8;
/** `gap-1.5`. */
const CHIP_GAP = 6;
/** `size-3.5`. */
const CHIP_ICON = 14;
/** `tracking-[0.14em]` at 10px, on the type only. */
const CHIP_TRACKING = 1.4;

/**
 * How wide a frame's label chip is. A frame is never drawn narrower than this:
 * a label running off the end of the box it names reads as a broken diagram.
 */
export function frameLabelWidth(node: BuilderNode): number {
  return (
    CHIP_INSET +
    CHIP_PADDING * 2 +
    CHIP_ICON +
    CHIP_GAP +
    textWidth(typeLabel(node), 10, CHIP_TRACKING) +
    CHIP_GAP +
    textWidth(azureName(node) ?? "unnamed", 10) +
    CHIP_GAP +
    textWidth(`.${node.name}`, 10) +
    BADGE +
    CHIP_INSET
  );
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
    if (!node) {
      return { x: 0, y: 0, width: CARD_MIN_WIDTH, height: CARD_HEAD_HEIGHT };
    }
    // Broken data (a parent cycle) must not hang the canvas.
    if (walking.has(id)) {
      return {
        ...node.position,
        width: CARD_MIN_WIDTH,
        height: CARD_HEAD_HEIGHT,
      };
    }
    walking.add(id);

    const children = graph.nodes.filter((n) => n.parentId === id);
    let box: Box;
    if (children.length === 0) {
      box = {
        ...node.position,
        width: cardWidth(graph, id, catalog),
        height: cardHeight(graph, id, catalog),
      };
    } else {
      const childBoxes = children.map((child) => boxOf(child.id));
      const right = Math.max(...childBoxes.map((b) => b.x + b.width));
      const bottom = Math.max(...childBoxes.map((b) => b.y + b.height));
      box = {
        ...node.position,
        width: Math.max(
          CONTAINER_MIN_WIDTH,
          frameLabelWidth(node),
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
  options: {
    /** The node being dragged: never its own destination. */
    ignore?: string;
    catalog?: readonly ResourceDef[];
    /** Only offer frames that can actually take this type. */
    childType?: string;
  } = {},
): string | undefined {
  const { ignore, catalog, childType } = options;
  const hits = graph.nodes.filter((node) => {
    if (node.id === ignore) return false;
    if (!acceptsDrop(graph, node.id, catalog, childType)) return false;
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
