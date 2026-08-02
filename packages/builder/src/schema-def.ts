/**
 * A provider schema, turned into something the builder can compose with
 * (GP-238).
 *
 * The catalog (GP-234..237) knows every resource type a provider has and every
 * argument each one takes. What it does not know — what no schema encodes — is
 * that `subnet_id` on a network interface *means* a subnet. Terraform has no
 * foreign keys; a reference is a string that happens to be an expression.
 *
 * So references are **derived, not guessed**: an attribute named `<x>_id`,
 * `<x>_name` or `<x>_ids` becomes a typed connection when `<provider>_<x>` is a
 * real type of the same provider — which the catalog can answer, because it
 * holds the whole type list. The rule is deterministic, it is checkable, and
 * `schema-def.test.ts` checks it against the real azurerm schema by requiring
 * that it reproduces the connections the curated catalog spells out by hand.
 * An attribute the rule does not recognise stays an ordinary field, which is
 * the honest outcome: a text box, not an invented relationship.
 *
 * Curation still wins where it exists. The dozen hand-written entries in
 * `catalog.ts` carry labels, categories, scaffold blocks and sensible defaults
 * that a schema cannot supply, so {@link mergeCatalog} prefers them — the
 * builder gained fifteen hundred types without any of the twelve getting worse.
 */
import {
  providerPrefixOf,
  type ProviderResourceSchema,
  type SchemaAttribute,
  type SchemaKind,
} from "./provider-schema.js";
import {
  CATALOG,
  type AttributeDef,
  type AttributeKind,
  type BlockDef,
  type ReferenceSlot,
  type ResourceDef,
} from "./catalog.js";

/**
 * Attributes that are never offered, whatever a provider says about them.
 * `id` is the resource's own address — writing it is not a thing one does —
 * and the `timeouts` block is Terraform's, not the provider's.
 */
const NEVER_OFFERED = new Set(["id"]);
const NEVER_A_BLOCK = new Set(["timeouts"]);

/**
 * Which schema kinds a builder field can hold. A `map(string)` or an
 * `object(...)` is a structure, and `BuilderValue` is a scalar or a list of
 * strings; offering a text box for one would produce HCL that does not parse.
 * They are left out of the form and out of the generated file — the resource is
 * still composable, and what it omits is editable the moment it lands in the
 * playground.
 */
const FIELD_KINDS: Record<SchemaKind, AttributeKind | null> = {
  string: "string",
  number: "number",
  bool: "bool",
  list: "list",
  map: null,
  object: null,
  any: null,
};

/** Is this an argument somebody may write, rather than an output to read? */
export function isWritable(attribute: SchemaAttribute): boolean {
  if (NEVER_OFFERED.has(attribute.name)) return false;
  // `computed` alone is an output. `optional && computed` means "set it, or the
  // provider decides" — which is a field, with no obligation to fill it in.
  return attribute.required || attribute.optional;
}

/** `azurerm_linux_virtual_machine` → `Linux virtual machine`. */
export function labelForType(type: string): string {
  const words = type.slice(providerPrefixOf(type).length + 1).split("_");
  const [first = "", ...rest] = words;
  return [first.charAt(0).toUpperCase() + first.slice(1), ...rest].join(" ");
}

/** The one line a picker entry and a form header show. */
function describe(schema: ProviderResourceSchema): string {
  const summary = (schema.description ?? "").split("\n")[0]?.trim() ?? "";
  return summary || `The provider's ${labelForType(schema.type)} resource.`;
}

/**
 * What an attribute name points at, if the naming rule recognises it: the type
 * it would reference, the attribute of that type to read, and whether the slot
 * takes several. Exported because it is the whole derivation, and a rule worth
 * relying on is a rule worth testing directly.
 */
export function referenceTarget(
  attribute: SchemaAttribute,
  prefix: string,
  types: ReadonlySet<string> = new Set(),
): { type: string; targetAttribute: string; list: boolean } | null {
  const suffixes = [
    { suffix: "_ids", kind: "list", targetAttribute: "id", list: true },
    { suffix: "_names", kind: "list", targetAttribute: "name", list: true },
    { suffix: "_id", kind: "string", targetAttribute: "id", list: false },
    { suffix: "_name", kind: "string", targetAttribute: "name", list: false },
  ] as const;

  for (const rule of suffixes) {
    if (attribute.kind !== rule.kind) continue;
    if (!attribute.name.endsWith(rule.suffix)) continue;
    const words = attribute.name.slice(0, -rule.suffix.length).split("_");
    if (words[0] === undefined || words[0] === "") continue;

    // Longest base first, then progressively shorter. `subnet_id` matches
    // `azurerm_subnet` outright; `public_ip_address_id` only matches after two
    // words come off, because the resource is `azurerm_public_ip` and the
    // argument names the *address* it hands out. Shortening never invents
    // anything — a candidate is only accepted when the provider has that type.
    for (let length = words.length; length >= 1; length -= 1) {
      const candidate = `${prefix}_${words.slice(0, length).join("_")}`;
      if (types.has(candidate)) {
        return {
          type: candidate,
          targetAttribute: rule.targetAttribute,
          list: rule.list,
        };
      }
    }
    // Nothing matched. The full base is still what the name *meant*, which is
    // what a caller with no type list is asking about.
    if (types.size === 0) {
      return {
        type: `${prefix}_${words.join("_")}`,
        targetAttribute: rule.targetAttribute,
        list: rule.list,
      };
    }
  }
  return null;
}

/** A slot for this attribute, when the type it would point at actually exists. */
function slotFor(
  attribute: SchemaAttribute,
  prefix: string,
  types: ReadonlySet<string>,
  block?: string,
): ReferenceSlot | null {
  if (types.size === 0) return null;
  const target = referenceTarget(attribute, prefix, types);
  if (!target) return null;
  return {
    attribute: attribute.name,
    label: labelForType(target.type),
    targetTypes: [target.type],
    targetAttribute: target.targetAttribute,
    required: attribute.required,
    ...(target.list ? { list: true } : {}),
    ...(block ? { block } : {}),
  };
}

/**
 * A plain form field for this attribute, when it can be one.
 *
 * An attribute inside a block is qualified twice over: its label says which
 * block it belongs to (a Kubernetes cluster and its default node pool both have
 * a `name`, and two fields called "Name" is a form nobody can fill in), and its
 * storage key is prefixed so the two cannot overwrite each other. The generated
 * HCL still says `name` in both places — only the label and the key change.
 */
function fieldFor(
  attribute: SchemaAttribute,
  block?: string,
): AttributeDef | null {
  const kind = FIELD_KINDS[attribute.kind];
  if (kind === null) return null;
  const hint = (attribute.description ?? "").split("\n")[0]?.trim();
  const own = labelForType(`x_${attribute.name}`);
  return {
    name: attribute.name,
    ...(block ? { key: `${block}.${attribute.name}` } : {}),
    label: block ? `${labelForType(`x_${block}`)} · ${own}` : own,
    kind,
    required: attribute.required,
    ...(hint ? { hint } : {}),
    ...(attribute.sensitive
      ? { sensitive: true as const }
      : {}),
    ...(block ? { block } : {}),
  };
}

/**
 * A block the scaffold must carry: the provider says at least one is required,
 * so a generated resource without it would not plan. Only the first level, and
 * only the block's **required** arguments — an optional argument of an optional
 * sub-block is a form nobody wants and a file nobody needs.
 */
function scaffoldBlocks(
  schema: ProviderResourceSchema,
  prefix: string,
  types: ReadonlySet<string>,
): { blocks: BlockDef[]; attributes: AttributeDef[]; slots: ReferenceSlot[] } {
  const blocks: BlockDef[] = [];
  const attributes: AttributeDef[] = [];
  const slots: ReferenceSlot[] = [];

  for (const block of schema.blocks) {
    if (NEVER_A_BLOCK.has(block.name) || block.minItems < 1) continue;
    blocks.push({ name: block.name });
    for (const attribute of block.attributes) {
      // Every *connection* the block can hold, required or not: a network
      // interface's `subnet_id` is optional to Terraform and the whole point of
      // the resource to a person, and a connection is what a canvas is for.
      const slot = slotFor(attribute, prefix, types, block.name);
      if (slot) {
        slots.push(slot);
        continue;
      }
      // Plain fields, only when required — an optional argument of a block
      // nobody asked for is a form nobody wants.
      if (!attribute.required) continue;
      const field = fieldFor(attribute, block.name);
      if (field) attributes.push(field);
    }
  }
  return { blocks, attributes, slots };
}

/**
 * One provider schema as a builder resource definition.
 *
 * `types` is the provider's whole type list — the reference rule needs it to
 * tell a real relationship from a coincidence of naming. Given an empty set,
 * every attribute is simply a field, which is a degraded but correct builder.
 */
export function resourceDefFromSchema(
  schema: ProviderResourceSchema,
  types: ReadonlySet<string> = new Set(),
): ResourceDef {
  const prefix = providerPrefixOf(schema.type);
  const attributes: AttributeDef[] = [];
  const references: ReferenceSlot[] = [];

  for (const attribute of schema.attributes) {
    if (!isWritable(attribute)) continue;
    const slot = slotFor(attribute, prefix, types);
    if (slot) {
      references.push(slot);
      continue;
    }
    const field = fieldFor(attribute);
    if (field) attributes.push(field);
  }

  const scaffold = scaffoldBlocks(schema, prefix, types);

  return {
    type: schema.type,
    ...(schema.kind === "data_source" ? { kind: "data_source" as const } : {}),
    label: labelForType(schema.type),
    description: describe(schema),
    // Everything of a provider goes to one file named after it. Deterministic
    // and predictable, which is what a generated tree needs to be; the curated
    // dozen keep their categories, and therefore their files.
    file: `${prefix}.tf`,
    attributes: [...attributes, ...scaffold.attributes],
    references: [...references, ...scaffold.slots],
    ...(scaffold.blocks.length > 0 ? { blocks: scaffold.blocks } : {}),
  };
}

/**
 * The catalog the builder actually composes against: every type the provider
 * has, with the curated entry preferred wherever there is one.
 *
 * Curation wins because it carries what a schema cannot — a label a person
 * wrote, a category, a scaffold block with real values in it, defaults that
 * make a new resource valid on the first click. There are a dozen of them and
 * fifteen hundred of the others, and that is the right ratio: the curated ones
 * are the path somebody walks the first time.
 */
export function mergeCatalog(
  derived: readonly ResourceDef[],
  curated: readonly ResourceDef[] = CATALOG,
): ResourceDef[] {
  const key = (def: ResourceDef) => `${def.kind ?? "resource"}:${def.type}`;
  const byKind = new Map(derived.map((def) => [key(def), def]));
  for (const def of curated) byKind.set(key(def), def);

  // A lookup of a curated type is written where that type is written (GP-248):
  // `data "azurerm_resource_group"` belongs beside the resource groups, not in
  // a file of its own. Only the destination is borrowed — the arguments stay
  // the data source's, which is the whole reason the two are separate defs.
  const curatedResources = new Map(
    curated
      .filter((def) => (def.kind ?? "resource") === "resource")
      .map((def) => [def.type, def]),
  );
  const merged = [...byKind.values()].map((def) => {
    const twin = def.kind === "data_source" ? curatedResources.get(def.type) : undefined;
    if (!twin) return def;
    const { file: _derived, ...rest } = def;
    return {
      ...rest,
      ...(twin.category ? { category: twin.category } : {}),
      ...(twin.file ? { file: twin.file } : {}),
    };
  });

  return merged.sort((a, b) =>
    a.type === b.type
      ? (a.kind ?? "resource").localeCompare(b.kind ?? "resource")
      : a.type.localeCompare(b.type),
  );
}

/** Every type name of a set of schemas — what the reference rule is given. */
export function typeNamesOf(
  schemas: readonly ProviderResourceSchema[],
): Set<string> {
  return new Set(
    schemas.filter((s) => s.kind === "resource").map((s) => s.type),
  );
}
