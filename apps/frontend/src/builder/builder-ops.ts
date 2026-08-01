/**
 * The builder document's operations (GP-133), as pure functions over a
 * BuilderGraph: add, rename, edit, connect, disconnect, delete.
 *
 * They live apart from the React state that holds them so the rules — a name
 * is unique per type, a connection is only made where the catalog allows one,
 * deleting a resource takes its connections with it — can be read and tested
 * without a canvas.
 */
import {
  attributeValue,
  canConnect,
  referenceSlot,
  resourceDef,
  type BuilderGraph,
  type BuilderNode,
  type BuilderValue,
} from "@groundplan/builder";

/** The palette entry that stands for "a resource the catalog does not have". */
export const CUSTOM_TYPE = "__custom__";

/** Where a new node lands when the palette, not the pointer, decided. */
const COLUMN_X = 40;
const ROW_HEIGHT = 150;

/** `azurerm_linux_web_app` → `web_app`: the readable half of a type. */
export function nameStem(type: string): string {
  if (type === CUSTOM_TYPE || type === "") return "resource";
  const withoutProvider = type.replace(/^[a-z0-9]+_/, "");
  return withoutProvider || type;
}

/** A Terraform local name free among the nodes of that type. */
export function freeName(graph: BuilderGraph, type: string): string {
  const taken = new Set(
    graph.nodes.filter((n) => n.type === type).map((n) => n.name),
  );
  const stem = nameStem(type);
  if (!taken.has(stem)) return stem;
  let n = 2;
  while (taken.has(`${stem}_${n}`)) n += 1;
  return `${stem}_${n}`;
}

/** Somewhere free-ish: below the lowest node, so a new one is never hidden. */
export function nextPosition(graph: BuilderGraph): { x: number; y: number } {
  const lowest = graph.nodes.reduce(
    (max, node) => Math.max(max, node.position.y),
    -ROW_HEIGHT,
  );
  return { x: COLUMN_X, y: lowest + ROW_HEIGHT };
}

/**
 * A new node of `type`, prefilled with the catalog's defaults — what will be
 * generated should be what the form shows, from the first second.
 */
export function newNode(
  graph: BuilderGraph,
  type: string,
  id: string,
  position?: { x: number; y: number },
): BuilderNode | null {
  // A custom resource starts with no type at all: the form asks for it, and
  // validation says so until it is given one.
  if (type === CUSTOM_TYPE) {
    return {
      id,
      type: "",
      name: freeName(graph, ""),
      attributes: {},
      custom: true,
      position: position ?? nextPosition(graph),
    };
  }
  const def = resourceDef(type);
  if (!def) return null;
  const node: BuilderNode = {
    id,
    type,
    name: freeName(graph, type),
    attributes: {},
    position: position ?? nextPosition(graph),
  };
  for (const attribute of def.attributes) {
    const value = attributeValue(attribute, node);
    if (value !== undefined) node.attributes[attribute.name] = value;
  }
  return node;
}

export function addNode(
  graph: BuilderGraph,
  type: string,
  id: string,
  position?: { x: number; y: number },
): BuilderGraph {
  const node = newNode(graph, type, id, position);
  return node ? { ...graph, nodes: [...graph.nodes, node] } : graph;
}

/** Rename a node. The name may be illegal or taken — validation says so. */
export function renameNode(
  graph: BuilderGraph,
  id: string,
  name: string,
): BuilderGraph {
  return {
    ...graph,
    nodes: graph.nodes.map((n) => (n.id === id ? { ...n, name } : n)),
  };
}

/** Set one attribute. An empty value is removed rather than stored blank. */
export function setAttribute(
  graph: BuilderGraph,
  id: string,
  attribute: string,
  value: BuilderValue | undefined,
): BuilderGraph {
  return {
    ...graph,
    nodes: graph.nodes.map((node) => {
      if (node.id !== id) return node;
      const attributes = { ...node.attributes };
      if (value === undefined) delete attributes[attribute];
      else attributes[attribute] = value;
      return { ...node, attributes };
    }),
  };
}

export function moveNode(
  graph: BuilderGraph,
  id: string,
  position: { x: number; y: number },
): BuilderGraph {
  return {
    ...graph,
    nodes: graph.nodes.map((n) => (n.id === id ? { ...n, position } : n)),
  };
}

/** Delete a node and every connection into or out of it — no dangling edges. */
export function removeNode(graph: BuilderGraph, id: string): BuilderGraph {
  return {
    nodes: graph.nodes.filter((n) => n.id !== id),
    references: graph.references.filter((r) => r.from !== id && r.to !== id),
  };
}

/** Retype a custom resource — the one node whose type is the user's to write. */
export function retypeNode(
  graph: BuilderGraph,
  id: string,
  type: string,
): BuilderGraph {
  return {
    ...graph,
    nodes: graph.nodes.map((n) => (n.id === id && n.custom ? { ...n, type } : n)),
  };
}

/** Rename a custom resource's reference — the attribute it is written into. */
export function renameReference(
  graph: BuilderGraph,
  from: string,
  attribute: string,
  next: string,
): BuilderGraph {
  return {
    ...graph,
    references: graph.references.map((r) =>
      r.from === from && r.attribute === attribute
        ? { ...r, attribute: next }
        : r,
    ),
  };
}

/** Retarget a custom reference: which attribute of the target it reads. */
export function setTargetAttribute(
  graph: BuilderGraph,
  from: string,
  attribute: string,
  targetAttribute: string,
): BuilderGraph {
  return {
    ...graph,
    references: graph.references.map((r) =>
      r.from === from && r.attribute === attribute
        ? { ...r, targetAttribute }
        : r,
    ),
  };
}

/**
 * The attribute name a new custom reference gets: what a Terraform author
 * would have typed — `subnet_id`, `resource_group_id` — deduplicated.
 */
export function freeReferenceName(
  graph: BuilderGraph,
  from: string,
  target: BuilderNode,
): string {
  const taken = new Set(
    graph.references.filter((r) => r.from === from).map((r) => r.attribute),
  );
  const stem = `${nameStem(target.type)}_id`;
  if (!taken.has(stem)) return stem;
  let n = 2;
  while (taken.has(`${stem}_${n}`)) n += 1;
  return `${stem}_${n}`;
}

/**
 * Add a reference to a custom resource: it has no slots, so the connection
 * names itself after what it points at and reads that resource's `id`. Both
 * halves are editable in the form afterwards.
 */
export function connectCustom(
  graph: BuilderGraph,
  from: string,
  to: string,
): BuilderGraph {
  const source = graph.nodes.find((n) => n.id === from);
  const target = graph.nodes.find((n) => n.id === to);
  if (!source?.custom || !target || from === to) return graph;
  return {
    ...graph,
    references: [
      ...graph.references,
      {
        from,
        to,
        attribute: freeReferenceName(graph, from, target),
        targetAttribute: "id",
      },
    ],
  };
}

/**
 * May this connection be made? The catalog decides the type rule; a
 * single-valued slot that is already filled decides the rest. The canvas asks
 * this while a connection is being dragged, so an impossible one is refused
 * rather than explained.
 */
export function canAttach(
  graph: BuilderGraph,
  from: string,
  attribute: string,
  to: string,
): boolean {
  if (from === to) return false;
  const source = graph.nodes.find((n) => n.id === from);
  const target = graph.nodes.find((n) => n.id === to);
  if (!source || !target) return false;
  if (!canConnect(source.type, attribute, target.type)) return false;

  const def = resourceDef(source.type);
  const slot = def ? referenceSlot(def, attribute) : undefined;
  if (!slot) return false;

  const filled = graph.references.filter(
    (r) => r.from === from && r.attribute === attribute,
  );
  // The same connection twice is a no-op, not a second one.
  if (filled.some((r) => r.to === to)) return false;
  return slot.list ? true : filled.length === 0;
}

/** Make a connection, or return the graph untouched when it is not allowed. */
export function connect(
  graph: BuilderGraph,
  from: string,
  attribute: string,
  to: string,
): BuilderGraph {
  if (!canAttach(graph, from, attribute, to)) return graph;
  return { ...graph, references: [...graph.references, { from, to, attribute }] };
}

export function disconnect(
  graph: BuilderGraph,
  from: string,
  attribute: string,
  to: string,
): BuilderGraph {
  return {
    ...graph,
    references: graph.references.filter(
      (r) => !(r.from === from && r.to === to && r.attribute === attribute),
    ),
  };
}

/** What is connected into a node's slot, as nodes. */
export function connectedTo(
  graph: BuilderGraph,
  nodeId: string,
  attribute: string,
): BuilderNode[] {
  const byId = new Map(graph.nodes.map((n) => [n.id, n]));
  return graph.references
    .filter((r) => r.from === nodeId && r.attribute === attribute)
    .flatMap((r) => {
      const node = byId.get(r.to);
      return node ? [node] : [];
    });
}
