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

/**
 * Which Terraform block a node becomes: one this composition declares, one it
 * merely looks up (GP-248), or one it takes as an input (GP-249).
 *
 * Little else changes with it. A lookup sits on the same canvas, fills the same
 * slots and is drawn as the same frame — the difference is that Terraform will
 * not create it, and that its address is `data.<type>.<name>`. A variable has
 * no provider type at all: it is a value somebody supplies, addressed as
 * `var.<name>`, and what makes it worth having is that any argument can point
 * at one instead of carrying a literal.
 */
export type BuilderMode = "resource" | "data" | "variable";

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
  /**
   * `resource` (absent, and the default), `data` (GP-248) or `variable`
   * (GP-249) — infrastructure this composition declares, infrastructure it only
   * points at, or a value somebody supplies. A lookup is described by the
   * provider's *data source* schema, which is a different set of arguments:
   * what identifies an existing resource group is its name, and everything else
   * about it is read, not written. A variable is described by no provider
   * schema at all.
   */
  mode?: BuilderMode;
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

/**
 * The Terraform address a node will be generated as — and, for a lookup, read
 * back through: `data.azurerm_resource_group.existing.name` (GP-248).
 *
 * It is also what makes a name unique. `azurerm_subnet.app` and
 * `data.azurerm_subnet.app` are two different addresses, so the two may share
 * a name; two resources of a type may not.
 */
export function addressOf(node: Pick<BuilderNode, "type" | "name" | "mode">): string {
  if (node.mode === "variable") return `var.${node.name}`;
  const address = `${node.type}.${node.name}`;
  return node.mode === "data" ? `data.${address}` : address;
}

/** An input the composition takes, rather than a resource it describes. */
export function isVariable(node: Pick<BuilderNode, "mode">): boolean {
  return node.mode === "variable";
}

/**
 * The schema kind a node is described by: a lookup reads the data source's.
 * A variable is described by neither — nothing in a provider schema is a
 * variable — so nobody asks this about one (see `defFor`).
 */
export function schemaKindOf(
  node: Pick<BuilderNode, "mode">,
): "resource" | "data_source" {
  return node.mode === "data" ? "data_source" : "resource";
}
