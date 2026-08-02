/**
 * The BuilderGraph (GP-132): what the visual builder composes, before any
 * Terraform exists.
 *
 * It is deliberately NOT a GraphSnapshot. A snapshot is the product of reading
 * infrastructure that someone already wrote; this is an editor document — node
 * ids the canvas made up, positions the user dragged, half-filled attributes.
 * The two only meet after generation, when the emitted `.tf` files are parsed
 * by Producer B and the invariant test checks the diagram came back the same
 * (see `generate.ts`).
 *
 * One-way, always (ADR #5): existing HCL is never turned back into one of
 * these.
 */

/** A value a catalog attribute can hold, per its declared `kind`. */
export type BuilderValue = string | number | boolean | string[];

/** Where a node sits on the builder canvas. Ignored by generation. */
export type BuilderPosition = { x: number; y: number };

export type BuilderNode = {
  /** Canvas-local identity, opaque and stable for the session. Never a Terraform address. */
  id: string;
  /**
   * Catalog resource type, e.g. `azurerm_subnet` — or, on a `custom` node, any
   * Terraform type the user typed.
   */
  type: string;
  /** The Terraform local name — the `this` in `resource "azurerm_subnet" "this"`. */
  name: string;
  /** Catalog attribute name → value. Absent = not filled in yet. */
  attributes: Record<string, BuilderValue>;
  position: BuilderPosition;
  /**
   * The node this one is drawn inside (GP-247) — a resource group holding a
   * virtual network holding a subnet. Containment is the Build Editor's way of
   * expressing a relationship the catalog already knows about: nesting a node
   * fills the reference slot that takes its container, so this field is where
   * the *drawing* lives and `references` stays the model. Generation never
   * reads it, which is why a graph that lost it still generates the same files.
   */
  parentId?: string;
  /**
   * A resource the catalog does not describe: the user typed the type and the
   * attributes themselves. It composes and generates like any other node, but
   * nothing about it is checked beyond syntax — there is no schema to check it
   * against, and inventing one would be worse than admitting that.
   */
  custom?: boolean;
};

/**
 * One filled reference slot: node `from` points at node `to` through the
 * catalog slot `attribute`. The rendered Terraform expression is derived from
 * the slot (`azurerm_virtual_network.this.name`), never stored here — a graph
 * that carried its own HCL could disagree with the catalog.
 */
export type BuilderReference = {
  from: string;
  to: string;
  attribute: string;
  /**
   * Which attribute of the target is referenced. Normally the slot's business
   * (`targetAttribute`), so this is absent; a custom node has no slot, so its
   * references carry it — `id`, `name`, whatever the user meant.
   */
  targetAttribute?: string;
};

export type BuilderGraph = {
  nodes: BuilderNode[];
  references: BuilderReference[];
};

/** An empty document — the state a fresh Build mode starts from. */
export function emptyBuilderGraph(): BuilderGraph {
  return { nodes: [], references: [] };
}

/** The Terraform address a node will be generated as. */
export function addressOf(node: Pick<BuilderNode, "type" | "name">): string {
  return `${node.type}.${node.name}`;
}
