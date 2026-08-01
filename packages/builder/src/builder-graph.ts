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
  /** Catalog resource type, e.g. `azurerm_subnet`. */
  type: string;
  /** The Terraform local name — the `this` in `resource "azurerm_subnet" "this"`. */
  name: string;
  /** Catalog attribute name → value. Absent = not filled in yet. */
  attributes: Record<string, BuilderValue>;
  position: BuilderPosition;
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
