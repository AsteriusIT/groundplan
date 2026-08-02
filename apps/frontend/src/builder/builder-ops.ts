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
  absoluteBoxes,
  CONTAINER_HEADER,
  CONTAINER_PADDING,
} from "./builder-layout";
import {
  ancestorsOf,
  attributeKey,
  attributeValue,
  CATALOG,
  canConnect,
  canContain,
  containmentSlot,
  defFor,
  descendantsOf,
  referenceSlot,
  resourceDef,
  schemaKindOf,
  type BuilderGraph,
  type BuilderMode,
  type BuilderNode,
  type BuilderValue,
  type ResourceDef,
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
  catalog: readonly ResourceDef[] = CATALOG,
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
  const def = resourceDef(type, catalog);
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
    if (value !== undefined) node.attributes[attributeKey(attribute)] = value;
  }
  return node;
}

export function addNode(
  graph: BuilderGraph,
  type: string,
  id: string,
  position?: { x: number; y: number },
  catalog: readonly ResourceDef[] = CATALOG,
): BuilderGraph {
  const node = newNode(graph, type, id, position, catalog);
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

/**
 * Deleting a container (GP-247) is two different intentions: take the whole
 * branch, or keep what is inside it. Neither is a safe default, so the canvas
 * asks and passes the answer here.
 *
 * `"promote"` re-parents the children one level up rather than orphaning them —
 * a subnet whose vnet goes still belongs to the resource group — and takes the
 * references to the deleted node with it, because a slot pointing at nothing is
 * worse than an empty one.
 */
export function removeBranch(
  graph: BuilderGraph,
  id: string,
  children: "delete" | "promote",
  catalog: readonly ResourceDef[] = CATALOG,
): BuilderGraph {
  if (children === "delete") {
    const doomed = new Set([id, ...descendantsOf(graph, id).map((n) => n.id)]);
    return {
      nodes: graph.nodes.filter((n) => !doomed.has(n.id)),
      references: graph.references.filter(
        (r) => !doomed.has(r.from) && !doomed.has(r.to),
      ),
    };
  }
  const removed = graph.nodes.find((n) => n.id === id);
  const grandparent = removed?.parentId;
  let next: BuilderGraph = {
    nodes: graph.nodes.map((n) =>
      n.parentId === id
        ? { ...n, ...(grandparent ? { parentId: grandparent } : { parentId: undefined }) }
        : n,
    ),
    references: graph.references,
  };
  next = removeNode(next, id);
  // Re-seat each promoted child: the grandparent may fill a slot of its own.
  for (const child of next.nodes.filter((n) => n.parentId === grandparent)) {
    if (grandparent) next = fillFromAncestors(next, child.id, catalog);
  }
  return next;
}

/**
 * Fill every reference slot an ancestor can fill (GP-247). Nesting a subnet in
 * a vnet that sits in a resource group answers both of the subnet's required
 * slots — the nearest ancestor of a matching type wins, and a slot somebody
 * already filled by hand is left alone.
 */
function fillFromAncestors(
  graph: BuilderGraph,
  id: string,
  catalog: readonly ResourceDef[] = CATALOG,
): BuilderGraph {
  const node = graph.nodes.find((n) => n.id === id);
  const def = node ? defFor(node, catalog) : undefined;
  if (!node || !def) return graph;
  let next = graph;
  for (const ancestor of ancestorsOf(graph, id)) {
    const slot = containmentSlot(node, ancestor.type, catalog);
    if (!slot) continue;
    const filled = next.references.some(
      (r) => r.from === id && r.attribute === slot.attribute,
    );
    if (filled) continue;
    next = {
      ...next,
      references: [
        ...next.references,
        { from: id, to: ancestor.id, attribute: slot.attribute },
      ],
    };
  }
  return next;
}

/**
 * May `childId` be drawn inside `parentId`? The catalog decides the type rule;
 * the graph decides the rest — nothing may contain itself, and nothing may be
 * dropped into its own descendant.
 */
export function canNest(
  graph: BuilderGraph,
  childId: string,
  parentId: string,
  catalog: readonly ResourceDef[] = CATALOG,
): boolean {
  if (childId === parentId) return false;
  const child = graph.nodes.find((n) => n.id === childId);
  const parent = graph.nodes.find((n) => n.id === parentId);
  if (!child || !parent) return false;
  if (descendantsOf(graph, childId).some((n) => n.id === parentId)) return false;
  return canContain(parent.type, child, catalog);
}

/**
 * Draw `childId` inside `parentId` — or, with no parent, back out onto the
 * canvas. The containment *is* the reference: nesting fills the slot that takes
 * the container, un-nesting empties it, and a move between containers of the
 * same type retargets it rather than leaving both.
 *
 * A move only rewrites the slots its new home answers. A node sits in one
 * place, so containment can draw one of its references and no more — a private
 * endpoint needs a subnet to sit in *and* a service to reach, and carrying it
 * into the key vault's frame must not take away the subnet it still uses. That
 * reference simply stops being a frame and becomes a wire.
 *
 * Taking something out onto the canvas is the other gesture, and it still
 * empties: the frames were answering those slots and now nothing is.
 *
 * A nesting the rules refuse returns the graph untouched; the canvas has
 * already said no visually, and a rejected drop should change nothing.
 */
export function reparent(
  graph: BuilderGraph,
  childId: string,
  parentId: string | undefined,
  catalog: readonly ResourceDef[] = CATALOG,
): BuilderGraph {
  const child = graph.nodes.find((n) => n.id === childId);
  if (!child) return graph;
  if (parentId && !canNest(graph, childId, parentId, catalog)) return graph;
  if ((child.parentId ?? undefined) === (parentId ?? undefined)) return graph;

  const moved = graph.nodes.map((n) =>
    n.id === childId ? { ...n, parentId } : n,
  );
  // Which slots the new chain has an answer for — the only ones this move is
  // entitled to rewrite.
  const answered = new Set(
    ancestorsOf({ ...graph, nodes: moved }, childId).flatMap((ancestor) => {
      const slot = containmentSlot(child, ancestor.type, catalog);
      return slot ? [slot.attribute] : [];
    }),
  );
  // The references the old chain filled are the old chain's; they go with it
  // where the new place has something to put in their stead.
  const stale = new Set(
    ancestorsOf(graph, childId).flatMap((ancestor) => {
      const slot = containmentSlot(child, ancestor.type, catalog);
      if (!slot) return [];
      const replaced = parentId === undefined || answered.has(slot.attribute);
      return replaced ? [`${slot.attribute}|${ancestor.id}`] : [];
    }),
  );
  let next: BuilderGraph = {
    nodes: moved,
    references: graph.references.filter(
      (r) => r.from !== childId || !stale.has(`${r.attribute}|${r.to}`),
    ),
  };
  if (parentId) next = placeInside(next, childId, parentId, catalog);
  return fillFromAncestors(next, childId, catalog);
}

/**
 * Put a node somewhere sensible inside its new frame — but only if it is not
 * already in it. A node dragged into a container was dropped where its owner
 * meant it; a node nested from the form was never anywhere near it, and
 * leaving it outside would stretch the frame across the canvas to reach it.
 */
function placeInside(
  graph: BuilderGraph,
  childId: string,
  parentId: string,
  catalog: readonly ResourceDef[] = CATALOG,
): BuilderGraph {
  const boxes = absoluteBoxes(graph, catalog);
  const parent = boxes.get(parentId);
  const child = boxes.get(childId);
  if (!parent || !child) return graph;
  const inside =
    child.x >= parent.x &&
    child.y >= parent.y &&
    child.x < parent.x + parent.width &&
    child.y < parent.y + parent.height;
  if (inside) return graph;

  // Under the frame's label, below whatever is already in there.
  const siblings = graph.nodes.filter(
    (n) => n.parentId === parentId && n.id !== childId,
  );
  const bottom = siblings.reduce((lowest, sibling) => {
    const box = boxes.get(sibling.id);
    return box ? Math.max(lowest, box.y + box.height) : lowest;
  }, parent.y + CONTAINER_HEADER);
  const position = {
    x: parent.x + CONTAINER_PADDING,
    y: bottom + (siblings.length > 0 ? CONTAINER_PADDING : 0),
  };
  return moveNode(graph, childId, position);
}

/**
 * Declare it, or look it up (GP-248).
 *
 * The node keeps its identity — same id, same Terraform name, same place on the
 * canvas, same connections — and changes what describes it. `def` is the
 * definition it is about to be read by, and everything is reconciled against
 * it: an argument the new schema does not have is dropped rather than left to
 * be reported forever (a `data "azurerm_resource_group"` takes no location,
 * because the location of an existing group is something Terraform reads), the
 * new schema's defaults are filled in as they would be on a fresh node, and a
 * reference through a slot it does not have goes the same way.
 *
 * Without a `def` only the mode changes, which is what a caller with no catalog
 * can honestly do.
 */
export function setMode(
  graph: BuilderGraph,
  id: string,
  mode: BuilderMode,
  def?: ResourceDef,
): BuilderGraph {
  const node = graph.nodes.find((n) => n.id === id);
  // A custom resource is the user's own word about a type nobody described;
  // there is no data source of something the catalog has never heard of.
  if (!node || node.custom) return graph;

  const { mode: _previous, ...rest } = node;
  const next: BuilderNode = {
    ...rest,
    ...(mode === "data" ? { mode } : {}),
  };

  if (def) {
    const known = new Set(def.attributes.map(attributeKey));
    next.attributes = Object.fromEntries(
      Object.entries(node.attributes).filter(([key]) => known.has(key)),
    );
    for (const attribute of def.attributes) {
      const value = attributeValue(attribute, next);
      if (value !== undefined) next.attributes[attributeKey(attribute)] = value;
    }
  }

  const slots = def ? new Set(def.references.map((slot) => slot.attribute)) : null;
  return {
    nodes: graph.nodes.map((n) => (n.id === id ? next : n)),
    references: graph.references.filter(
      (r) => r.from !== id || !slots || slots.has(r.attribute),
    ),
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
  catalog: readonly ResourceDef[] = CATALOG,
): boolean {
  if (from === to) return false;
  const source = graph.nodes.find((n) => n.id === from);
  const target = graph.nodes.find((n) => n.id === to);
  if (!source || !target) return false;
  if (
    !canConnect(source.type, attribute, target.type, catalog, schemaKindOf(source))
  ) {
    return false;
  }

  const def = defFor(source, catalog);
  const slot = def ? referenceSlot(def, attribute) : undefined;
  if (!slot) return false;

  const filled = graph.references.filter(
    (r) => r.from === from && r.attribute === attribute,
  );
  // The same connection twice is a no-op, not a second one.
  if (filled.some((r) => r.to === to)) return false;
  return slot.list ? true : filled.length === 0;
}

/**
 * Make a connection, or return the graph untouched when it is not allowed.
 *
 * A connection the *nesting* could express is also drawn as nesting (GP-247):
 * choosing a resource group in the form puts the resource inside that resource
 * group's frame. The canvas and the form are two ways of saying one thing, and
 * they must not be able to disagree about it.
 *
 * Only one of them, though. A node already drawn inside something stays where
 * it is, and this connection is a wire: a private endpoint that sits in its
 * subnet must be able to reach a key vault without being carried out of the
 * subnet to do it.
 */
export function connect(
  graph: BuilderGraph,
  from: string,
  attribute: string,
  to: string,
  catalog: readonly ResourceDef[] = CATALOG,
): BuilderGraph {
  if (!canAttach(graph, from, attribute, to, catalog)) return graph;
  const connected: BuilderGraph = {
    ...graph,
    references: [...graph.references, { from, to, attribute }],
  };
  const source = graph.nodes.find((n) => n.id === from);
  const target = graph.nodes.find((n) => n.id === to);
  // The slot the frame it is already in is answering, if it is in one: a
  // connection on that slot moves it, a connection on any other is a wire.
  const home = graph.nodes.find((n) => n.id === source?.parentId);
  const drawn =
    source && home
      ? containmentSlot(source, home.type, catalog)?.attribute
      : undefined;
  const nests =
    source &&
    target &&
    (drawn === undefined || drawn === attribute) &&
    containmentSlot(source, target.type, catalog)?.attribute === attribute &&
    canNest(connected, from, to, catalog);
  return nests ? reparent(connected, from, to, catalog) : connected;
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
