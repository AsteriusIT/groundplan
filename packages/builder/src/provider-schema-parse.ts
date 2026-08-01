/**
 * `terraform providers schema -json` → the narrowed schemas the catalog stores
 * (GP-234). Pure, total and deterministic: the same provider version always
 * produces byte-identical output, because everything is sorted by name and
 * nothing is read from the environment.
 *
 * It is deliberately forgiving about the input — a provider is free to ship a
 * type Terraform's own JSON encodes in a shape we have not seen, and the right
 * answer to that is to keep the parts we understood, not to fail an extraction
 * of fifteen hundred types over one of them.
 */
import type {
  ProviderResourceSchema,
  SchemaAttribute,
  SchemaBlock,
  SchemaKind,
  SchemaNesting,
  SchemaResourceKind,
} from "./provider-schema.js";

/** The raw JSON, typed only as far as we read it. */
type RawAttribute = {
  type?: unknown;
  description?: unknown;
  required?: unknown;
  optional?: unknown;
  computed?: unknown;
  sensitive?: unknown;
};

type RawBlock = {
  attributes?: Record<string, RawAttribute>;
  block_types?: Record<string, RawBlockType>;
  description?: unknown;
};

type RawBlockType = {
  nesting_mode?: unknown;
  min_items?: unknown;
  max_items?: unknown;
  block?: RawBlock;
};

type RawSchema = { block?: RawBlock };

type RawProviderSchema = {
  resource_schemas?: Record<string, RawSchema>;
  data_source_schemas?: Record<string, RawSchema>;
};

export type RawProvidersSchema = {
  format_version?: unknown;
  provider_schemas?: Record<string, RawProviderSchema>;
};

/** How deep nested blocks are kept. Beyond this a provider is describing a
 * data structure, not a form — and the depth is what makes a blob unbounded. */
const MAX_BLOCK_DEPTH = 3;

const bool = (value: unknown): boolean => value === true;

const text = (value: unknown): string | undefined =>
  typeof value === "string" && value.trim() !== "" ? value.trim() : undefined;

/**
 * A cty type as the documentation writes it. Terraform encodes it as either a
 * primitive name (`"string"`) or a tagged array (`["list","string"]`,
 * `["object",{…}]`) — the recursive form is rendered back to `list(string)`,
 * and an object is rendered as `object` rather than spelling out every member,
 * which is what keeps a stored schema small.
 */
export function renderCtyType(type: unknown): string {
  if (typeof type === "string") return type;
  if (!Array.isArray(type) || type.length === 0) return "any";
  const [tag, inner] = type as [unknown, unknown];
  if (typeof tag !== "string") return "any";
  if (tag === "object" || tag === "tuple") return tag;
  if (inner === undefined) return tag;
  return `${tag}(${renderCtyType(inner)})`;
}

/** The rendered type, reduced to what a form control can be chosen from. */
export function kindOfCtyType(rendered: string): SchemaKind {
  const head = rendered.split("(")[0] ?? "any";
  switch (head) {
    case "string":
      return "string";
    case "number":
      return "number";
    case "bool":
      return "bool";
    case "list":
    case "set":
    case "tuple":
      return "list";
    case "map":
      return "map";
    case "object":
      return "object";
    default:
      return "any";
  }
}

/** The provider's `nesting_mode`, or `single` when it names one we do not know. */
function nestingOf(value: unknown): SchemaNesting {
  switch (value) {
    case "list":
    case "set":
    case "map":
    case "group":
    case "single":
      return value;
    default:
      return "single";
  }
}

/** A non-negative integer, or the fallback — Terraform omits both bounds freely. */
function count(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? Math.trunc(value)
    : fallback;
}

function parseAttribute(name: string, raw: RawAttribute): SchemaAttribute {
  const type = renderCtyType(raw.type);
  const attribute: SchemaAttribute = {
    name,
    type,
    kind: kindOfCtyType(type),
    required: bool(raw.required),
    optional: bool(raw.optional),
    computed: bool(raw.computed),
    sensitive: bool(raw.sensitive),
  };
  const description = text(raw.description);
  if (description) attribute.description = description;
  return attribute;
}

/** Every attribute of a block, sorted by name so the output is stable. */
function parseAttributes(raw: RawBlock | undefined): SchemaAttribute[] {
  return Object.entries(raw?.attributes ?? {})
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([name, attribute]) => parseAttribute(name, attribute ?? {}));
}

/** Every nested block, sorted by name, to `MAX_BLOCK_DEPTH`. */
function parseBlocks(raw: RawBlock | undefined, depth: number): SchemaBlock[] {
  if (depth > MAX_BLOCK_DEPTH) return [];
  return Object.entries(raw?.block_types ?? {})
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([name, blockType]) => {
      const inner = blockType?.block;
      const block: SchemaBlock = {
        name,
        nesting: nestingOf(blockType?.nesting_mode),
        minItems: count(blockType?.min_items, 0),
        maxItems:
          typeof blockType?.max_items === "number"
            ? count(blockType.max_items, 0)
            : null,
        attributes: parseAttributes(inner),
        blocks: parseBlocks(inner, depth + 1),
      };
      const description = text(inner?.description);
      if (description) block.description = description;
      return block;
    });
}

/**
 * The first sentence of a description, which is what a one-line picker entry
 * has room for. Markdown is left as it is — the provider wrote it, and the
 * frontend renders it as text.
 */
export function firstSentence(description: string | undefined): string {
  if (!description) return "";
  const line = description.split("\n")[0]?.trim() ?? "";
  const stop = line.indexOf(". ");
  return stop === -1 ? line : line.slice(0, stop + 1).trim();
}

/**
 * Every resource type and data source of one provider, narrowed. The provider
 * key Terraform uses is a source address (`registry.terraform.io/hashicorp/azurerm`);
 * `provider` is the `namespace/name` half, which is how the rest of the product
 * names a provider.
 */
export function parseProviderSchema(
  raw: RawProvidersSchema,
  opts: { provider: string; version: string },
): ProviderResourceSchema[] {
  const address = Object.keys(raw.provider_schemas ?? {}).find((key) =>
    key.endsWith(`/${opts.provider}`),
  );
  const schemas = address ? raw.provider_schemas?.[address] : undefined;
  if (!schemas) return [];

  const of = (
    entries: Record<string, RawSchema> | undefined,
    kind: SchemaResourceKind,
  ): ProviderResourceSchema[] =>
    Object.entries(entries ?? {})
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([type, schema]) => {
        const block = schema?.block;
        const parsed: ProviderResourceSchema = {
          type,
          kind,
          provider: opts.provider,
          version: opts.version,
          attributes: parseAttributes(block),
          blocks: parseBlocks(block, 1),
        };
        const description = text(block?.description);
        if (description) parsed.description = description;
        return parsed;
      });

  return [
    ...of(schemas.resource_schemas, "resource"),
    ...of(schemas.data_source_schemas, "data_source"),
  ];
}
