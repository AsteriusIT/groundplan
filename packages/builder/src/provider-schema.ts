/**
 * What a provider says about one of its resource types (GP-234) — the shape the
 * catalog stores, the API serves and the builder composes against.
 *
 * It is a *narrowing* of `terraform providers schema -json`, not a copy: the
 * fields a form and a validator need, in a stable order, with the cty type
 * rendered as the documentation writes it. Keeping the narrowing here — in the
 * package both sides already share — is what lets the browser validate a
 * composition against exactly the schema the server generated from, and what
 * keeps the multi-megabyte provider blob out of every consumer.
 *
 * Nothing here is Azure-specific and nothing is curated: this is the provider's
 * own word about itself.
 */

/** How a value is entered, once the cty type is reduced to something a form can render. */
export type SchemaKind =
  | "string"
  | "number"
  | "bool"
  | "list"
  | "map"
  | "object"
  | "any";

/**
 * One argument of a resource type.
 *
 * `required`/`optional`/`computed` are the provider's own three flags and they
 * are kept apart rather than collapsed into one enum, because the combination is
 * meaningful: `optional && computed` is "you may set it, otherwise the provider
 * decides", while `computed` alone is an output nobody may write — which is
 * exactly the distinction a form needs in order to hide the right fields.
 */
export type SchemaAttribute = {
  name: string;
  /** The cty type as the docs write it: `string`, `list(string)`, `map(any)`. */
  type: string;
  /** The same type, reduced to what a form control can be chosen from. */
  kind: SchemaKind;
  required: boolean;
  optional: boolean;
  computed: boolean;
  sensitive: boolean;
  /** The provider's description, when it ships one. Plain text, never HTML. */
  description?: string;
};

/** How a nested block repeats. Mirrors Terraform's `nesting_mode`. */
export type SchemaNesting = "single" | "list" | "set" | "map" | "group";

/** A nested block of a resource type, with its own attributes and blocks. */
export type SchemaBlock = {
  name: string;
  nesting: SchemaNesting;
  /** `>= 1` means the block must be present — what makes it part of a scaffold. */
  minItems: number;
  /** `null` = unbounded. */
  maxItems: number | null;
  description?: string;
  attributes: SchemaAttribute[];
  blocks: SchemaBlock[];
};

/** A resource type, or a data source of the same provider. */
export type SchemaResourceKind = "resource" | "data_source";

/**
 * The stored schema of one resource type. `provider` and `version` travel with
 * it so a schema read from a cache, an export or a bundled snapshot always says
 * which provider version it is the word of — the product's rule that every
 * surface dates what it shows.
 */
export type ProviderResourceSchema = {
  /** `azurerm_subnet` — the Terraform type, the key everywhere. */
  type: string;
  kind: SchemaResourceKind;
  /** `hashicorp/azurerm`. */
  provider: string;
  /** The exact provider version the schema was extracted from. */
  version: string;
  description?: string;
  attributes: SchemaAttribute[];
  blocks: SchemaBlock[];
};

/** One line of the resource list: enough to search and pick, no schema at all. */
export type ProviderResourceSummary = {
  type: string;
  kind: SchemaResourceKind;
  /** The first sentence of the provider's description, when it ships one. */
  summary: string;
  /** Top-level arguments — a cheap sense of how big the form will be. */
  attributeCount: number;
};

/** The provider prefix a type carries: `azurerm_subnet` → `azurerm`. */
export function providerPrefixOf(type: string): string {
  const at = type.indexOf("_");
  return at === -1 ? type : type.slice(0, at);
}

/**
 * The service a type belongs to, as far as the name allows: `azurerm_subnet` →
 * `subnet`, `azurerm_storage_blob` → `storage`. Used to group a
 * fifteen-hundred-entry picker into something a person can scan.
 *
 * The first word only, deliberately: two words fragment `azurerm_storage_*` into
 * a dozen groups of one, which is not grouping. The name is the only signal a
 * provider gives about its own shape, so this claims nothing more than "these
 * share a first word" — and the picker labels it as such.
 */
export function serviceOf(type: string): string {
  const rest = type.slice(providerPrefixOf(type).length + 1);
  const first = rest.split("_")[0];
  return first === undefined || first === "" ? type : first;
}
