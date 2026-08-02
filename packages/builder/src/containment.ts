/**
 * Containment for the Build Editor (GP-247): what may be drawn inside what.
 *
 * The rule is **derived, never listed**. A subnet may sit inside a virtual
 * network because a subnet has a reference slot that takes one — the same fact
 * the generator writes as `virtual_network_name = azurerm_virtual_network.x.name`.
 * Nesting is therefore not a second model beside the references: it *is* the
 * references, drawn as space instead of as arrows, which is why the Build
 * Editor needs no edge tool at all.
 *
 * A type is a container when something can be put in it. Nothing declares that
 * either — `azurerm_resource_group` is a container because a dozen types point
 * at one, and a storage account is not because nothing points at a storage
 * account. Adding a resource type to the catalog therefore adds its nesting
 * rules with it, exactly as GP-132 intended for everything else.
 */
import { CATALOG, resourceDef, type ResourceDef, type ReferenceSlot } from "./catalog.js";
import type { BuilderGraph, BuilderNode } from "./builder-graph.js";

/**
 * A slot that space can express: one target, so the child is inside one thing.
 * A list slot — a virtual machine's network interfaces — is a relationship with
 * several, and a node cannot be drawn inside two frames at once. Those stay
 * references: made in the form, drawn as edges.
 */
function nestable(slot: ReferenceSlot): boolean {
  return slot.list !== true;
}

/**
 * The slot on `childType` that a container of `parentType` fills, if there is
 * one. A required slot wins over an optional one: a subnet's resource group and
 * its virtual network are both slots, and the vnet is the tighter home.
 */
export function containmentSlot(
  childType: string,
  parentType: string,
  catalog: readonly ResourceDef[] = CATALOG,
): ReferenceSlot | undefined {
  const def = resourceDef(childType, catalog);
  if (!def) return undefined;
  const slots = def.references.filter(
    (slot) => nestable(slot) && slot.targetTypes.includes(parentType),
  );
  return slots.find((slot) => slot.required) ?? slots[0];
}

/** May a `childType` be drawn inside a `parentType`? */
export function canContain(
  parentType: string,
  childType: string,
  catalog: readonly ResourceDef[] = CATALOG,
): boolean {
  return containmentSlot(childType, parentType, catalog) !== undefined;
}

/**
 * The types that can hold something. Derived from the catalog in hand, so a
 * palette built from it offers exactly the containers this deployment knows.
 */
export function containerTypes(
  catalog: readonly ResourceDef[] = CATALOG,
): string[] {
  const targets = new Set<string>();
  for (const def of catalog) {
    for (const slot of def.references.filter(nestable)) {
      for (const type of slot.targetTypes) {
        if (resourceDef(type, catalog)) targets.add(type);
      }
    }
  }
  return [...targets].sort((a, b) => a.localeCompare(b));
}

/** Is this type one of them? */
export function isContainerType(
  type: string,
  catalog: readonly ResourceDef[] = CATALOG,
): boolean {
  return catalog.some((def) =>
    def.references.some(
      (slot) => nestable(slot) && slot.targetTypes.includes(type),
    ),
  );
}

/** The node's parent, its parent's parent, …, outermost last. */
export function ancestorsOf(
  graph: BuilderGraph,
  id: string,
): BuilderNode[] {
  const byId = new Map(graph.nodes.map((n) => [n.id, n]));
  const chain: BuilderNode[] = [];
  const seen = new Set<string>([id]);
  let current = byId.get(id)?.parentId;
  while (current && !seen.has(current)) {
    const node = byId.get(current);
    if (!node) break;
    chain.push(node);
    seen.add(node.id);
    current = node.parentId;
  }
  return chain;
}

/** Everything nested inside this node, at any depth. */
export function descendantsOf(graph: BuilderGraph, id: string): BuilderNode[] {
  const children = graph.nodes.filter((n) => n.parentId === id);
  return children.flatMap((child) => [child, ...descendantsOf(graph, child.id)]);
}

/** The nodes drawn on the canvas at the top level. */
export function rootNodes(graph: BuilderGraph): BuilderNode[] {
  const ids = new Set(graph.nodes.map((n) => n.id));
  return graph.nodes.filter((n) => !n.parentId || !ids.has(n.parentId));
}
