/**
 * The builder's resource catalog (GP-132) — the only place that knows which
 * resource types the builder supports, in the shape of the policy engine's
 * `catalog.ts` and the integrations' `registry.ts`.
 *
 * A definition is **data**: attributes, reference slots and the verbatim blocks
 * a scaffold of that type always carries. Nothing about a type lives in the
 * palette, the form or the generator, so adding a resource type is adding one
 * entry here — which `catalog.test.ts` proves by adding one.
 *
 * The subset is curated on purpose: what a scaffold needs, hand-written and
 * reviewed. It is not the azurerm provider schema and must never be generated
 * from it — a form with ninety optional arguments is not a builder.
 */
import type { SchemaResourceKind } from "./provider-schema.js";

/** How a value is entered, and how it is rendered into HCL. */
export type AttributeKind = "string" | "number" | "bool" | "enum" | "list";

export type AttributeDef = {
  /** The HCL argument name, as it is written into the generated file. */
  name: string;
  /**
   * Where the value is kept on the node, when that cannot be `name`.
   *
   * A schema-derived type can have the same argument name twice — a Kubernetes
   * cluster has a `name`, and so does its required `default_node_pool` block —
   * and two fields writing to one key would silently overwrite each other. The
   * generated HCL still says `name` in both places; only the storage key is
   * qualified. Absent on every curated entry, where no such collision exists.
   */
  key?: string;
  label: string;
  kind: AttributeKind;
  required: boolean;
  /** The allowed values of an `enum` attribute, in the order the form offers them. */
  values?: readonly string[];
  default?: string | number | boolean | readonly string[];
  /** One line under the field: what this is, in the user's language. */
  hint?: string;
  /** Emit inside this block instead of at the top level (see `BlockDef`). */
  block?: string;
  /**
   * The provider marked this argument sensitive (GP-238). It changes nothing
   * about generation — a literal in a `.tf` file is a literal — and everything
   * about how the form presents it: the field says so, out loud, because the
   * builder's output is a file somebody is about to commit.
   */
  sensitive?: boolean;
};

/**
 * A place another node can be connected to. The slot decides what may be
 * connected (`targetTypes`) and which attribute of the target is referenced
 * (`targetAttribute`) — so the generator writes
 * `azurerm_virtual_network.this.name`, never a copied string.
 */
export type ReferenceSlot = {
  attribute: string;
  label: string;
  targetTypes: readonly string[];
  /** The referenced attribute of the target: `id`, `name`, `location`, … */
  targetAttribute: string;
  required: boolean;
  /** A slot that takes many references, rendered as a list. */
  list?: boolean;
  /** Emit inside this block instead of at the top level (see `BlockDef`). */
  block?: string;
};

/**
 * A nested block the scaffold always emits. `lines` are verbatim HCL; the
 * block also hosts any attribute or slot that names it. A line may carry
 * `${attr:<name>}`, which the generator substitutes with that attribute's
 * rendered value — the one templating rule, and the reason a Linux VM's SSH
 * block can say the admin username without the user typing it twice.
 */
export type BlockDef = {
  name: string;
  lines?: readonly string[];
};

/** Which file a resource is generated into, and how the palette is grouped. */
export type ResourceCategory = "foundation" | "network" | "compute" | "data";

export type ResourceDef = {
  type: string;
  /**
   * Which schema this describes (GP-248): the type's `resource`, or its
   * `data_source` — the arguments that identify one that already exists. Absent
   * means `resource`, which every curated entry is.
   *
   * A definition is therefore identified by (kind, type), not by type alone:
   * `azurerm_resource_group` as a resource needs a name *and* a location, and
   * as a data source needs only the name, because everything else about an
   * existing one is read rather than written.
   */
  kind?: SchemaResourceKind;
  label: string;
  /**
   * The curated grouping. Absent on a definition derived from a provider schema
   * (GP-238): a category is an editorial judgement about what a resource is
   * *for*, and a schema does not contain one. Inventing a category for fifteen
   * hundred types would be inventing fifteen hundred judgements.
   */
  category?: ResourceCategory;
  /** One line in the palette: what this resource is for. */
  description: string;
  /**
   * Which file this type is generated into, overriding the category's. Set on
   * derived definitions (`azurerm.tf`), because a type with no category still
   * has to land somewhere predictable.
   */
  file?: string;
  attributes: readonly AttributeDef[];
  references: readonly ReferenceSlot[];
  blocks?: readonly BlockDef[];
};

/** Every resource lives in a resource group; the slot is identical on all of them. */
const RESOURCE_GROUP_SLOT: ReferenceSlot = {
  attribute: "resource_group_name",
  label: "Resource group",
  targetTypes: ["azurerm_resource_group"],
  targetAttribute: "name",
  required: true,
};

/** The Azure resource name — every type has one, and it is always required. */
function nameAttribute(hint: string): AttributeDef {
  return {
    name: "name",
    label: "Azure name",
    kind: "string",
    required: true,
    hint,
  };
}

/** The region. A literal rather than a second connection to the resource group. */
const LOCATION: AttributeDef = {
  name: "location",
  label: "Location",
  kind: "string",
  required: true,
  default: "westeurope",
  hint: "Azure region, e.g. westeurope",
};

export const CATALOG: readonly ResourceDef[] = [
  {
    type: "azurerm_resource_group",
    label: "Resource group",
    category: "foundation",
    description: "The container everything else is created in.",
    attributes: [nameAttribute("e.g. rg-platform-prod"), LOCATION],
    references: [],
  },
  {
    type: "azurerm_virtual_network",
    label: "Virtual network",
    category: "network",
    description: "The private address space subnets are carved out of.",
    attributes: [
      nameAttribute("e.g. vnet-platform"),
      LOCATION,
      {
        name: "address_space",
        label: "Address space",
        kind: "list",
        required: true,
        default: ["10.0.0.0/16"],
        hint: "One or more CIDR ranges",
      },
    ],
    references: [RESOURCE_GROUP_SLOT],
  },
  {
    type: "azurerm_subnet",
    label: "Subnet",
    category: "network",
    description: "A range inside a virtual network that resources sit in.",
    attributes: [
      nameAttribute("e.g. snet-app"),
      {
        name: "address_prefixes",
        label: "Address prefixes",
        kind: "list",
        required: true,
        default: ["10.0.1.0/24"],
        hint: "CIDR ranges inside the virtual network",
      },
    ],
    references: [
      RESOURCE_GROUP_SLOT,
      {
        attribute: "virtual_network_name",
        label: "Virtual network",
        targetTypes: ["azurerm_virtual_network"],
        targetAttribute: "name",
        required: true,
      },
    ],
  },
  {
    type: "azurerm_network_security_group",
    label: "Network security group",
    category: "network",
    description: "The rule set that decides what may reach a subnet or a NIC.",
    attributes: [nameAttribute("e.g. nsg-app"), LOCATION],
    references: [RESOURCE_GROUP_SLOT],
  },
  {
    type: "azurerm_public_ip",
    label: "Public IP",
    category: "network",
    description: "A routable address, which is also an exposure.",
    attributes: [
      nameAttribute("e.g. pip-app"),
      LOCATION,
      {
        name: "allocation_method",
        label: "Allocation",
        kind: "enum",
        required: true,
        values: ["Static", "Dynamic"],
        default: "Static",
      },
      {
        name: "sku",
        label: "SKU",
        kind: "enum",
        required: false,
        values: ["Basic", "Standard"],
        default: "Standard",
      },
    ],
    references: [RESOURCE_GROUP_SLOT],
  },
  {
    type: "azurerm_network_interface",
    label: "Network interface",
    category: "network",
    description: "What attaches a virtual machine to a subnet.",
    attributes: [nameAttribute("e.g. nic-app"), LOCATION],
    references: [
      RESOURCE_GROUP_SLOT,
      {
        attribute: "subnet_id",
        label: "Subnet",
        targetTypes: ["azurerm_subnet"],
        targetAttribute: "id",
        required: true,
        block: "ip_configuration",
      },
      {
        attribute: "public_ip_address_id",
        label: "Public IP",
        targetTypes: ["azurerm_public_ip"],
        targetAttribute: "id",
        required: false,
        block: "ip_configuration",
      },
    ],
    blocks: [
      {
        name: "ip_configuration",
        lines: [
          'name                          = "internal"',
          'private_ip_address_allocation = "Dynamic"',
        ],
      },
    ],
  },
  {
    type: "azurerm_linux_virtual_machine",
    label: "Linux virtual machine",
    category: "compute",
    description: "A VM, reachable through the network interfaces it is given.",
    attributes: [
      nameAttribute("e.g. vm-app-01"),
      LOCATION,
      {
        name: "size",
        label: "Size",
        kind: "enum",
        required: true,
        values: ["Standard_B1s", "Standard_B2s", "Standard_D2s_v5"],
        default: "Standard_B2s",
      },
      {
        name: "admin_username",
        label: "Admin username",
        kind: "string",
        required: true,
        default: "azureuser",
      },
    ],
    references: [
      RESOURCE_GROUP_SLOT,
      {
        attribute: "network_interface_ids",
        label: "Network interfaces",
        targetTypes: ["azurerm_network_interface"],
        targetAttribute: "id",
        required: true,
        list: true,
      },
    ],
    blocks: [
      {
        name: "admin_ssh_key",
        lines: [
          "username   = ${attr:admin_username}",
          'public_key = file("~/.ssh/id_rsa.pub")',
        ],
      },
      {
        name: "os_disk",
        lines: [
          'caching              = "ReadWrite"',
          'storage_account_type = "Standard_LRS"',
        ],
      },
      {
        name: "source_image_reference",
        lines: [
          'publisher = "Canonical"',
          'offer     = "ubuntu-24_04-lts"',
          'sku       = "server"',
          'version   = "latest"',
        ],
      },
    ],
  },
  {
    type: "azurerm_storage_account",
    label: "Storage account",
    category: "data",
    description: "Blobs, files and queues — and a public endpoint by default.",
    attributes: [
      nameAttribute("lowercase letters and digits only"),
      LOCATION,
      {
        name: "account_tier",
        label: "Tier",
        kind: "enum",
        required: true,
        values: ["Standard", "Premium"],
        default: "Standard",
      },
      {
        name: "account_replication_type",
        label: "Replication",
        kind: "enum",
        required: true,
        values: ["LRS", "ZRS", "GRS"],
        default: "LRS",
      },
    ],
    references: [RESOURCE_GROUP_SLOT],
  },
  {
    type: "azurerm_key_vault",
    label: "Key vault",
    category: "data",
    description: "Where secrets, keys and certificates belong.",
    attributes: [
      nameAttribute("e.g. kv-platform-prod"),
      LOCATION,
      {
        name: "sku_name",
        label: "SKU",
        kind: "enum",
        required: true,
        values: ["standard", "premium"],
        default: "standard",
      },
      {
        name: "tenant_id",
        label: "Tenant id",
        kind: "string",
        required: true,
        default: "00000000-0000-0000-0000-000000000000",
        hint: "The Entra ID tenant the vault trusts",
      },
    ],
    references: [RESOURCE_GROUP_SLOT],
  },
  {
    type: "azurerm_private_endpoint",
    label: "Private endpoint",
    category: "network",
    description: "Reaches a data service over the virtual network instead of the internet.",
    attributes: [
      nameAttribute("e.g. pe-storage"),
      LOCATION,
      {
        name: "subresource_name",
        label: "Sub-resource",
        kind: "enum",
        required: true,
        values: ["blob", "file", "vault"],
        default: "blob",
        hint: "Which sub-resource of the target is reached",
        block: "private_service_connection",
      },
    ],
    references: [
      RESOURCE_GROUP_SLOT,
      {
        attribute: "subnet_id",
        label: "Subnet",
        targetTypes: ["azurerm_subnet"],
        targetAttribute: "id",
        required: true,
      },
      {
        attribute: "private_connection_resource_id",
        label: "Target service",
        targetTypes: ["azurerm_storage_account", "azurerm_key_vault"],
        targetAttribute: "id",
        required: true,
        block: "private_service_connection",
      },
    ],
    blocks: [
      {
        name: "private_service_connection",
        lines: [
          "name                 = ${attr:name}",
          "is_manual_connection = false",
        ],
      },
    ],
  },
  {
    type: "azurerm_service_plan",
    label: "Service plan",
    category: "compute",
    description: "The compute a web app runs on.",
    attributes: [
      nameAttribute("e.g. asp-platform"),
      LOCATION,
      {
        name: "os_type",
        label: "OS",
        kind: "enum",
        required: true,
        values: ["Linux", "Windows"],
        default: "Linux",
      },
      {
        name: "sku_name",
        label: "SKU",
        kind: "enum",
        required: true,
        values: ["B1", "S1", "P1v3"],
        default: "B1",
      },
    ],
    references: [RESOURCE_GROUP_SLOT],
  },
  {
    type: "azurerm_linux_web_app",
    label: "Linux web app",
    category: "compute",
    description: "An app service, on the plan it is given.",
    attributes: [nameAttribute("e.g. app-platform-prod"), LOCATION],
    references: [
      RESOURCE_GROUP_SLOT,
      {
        attribute: "service_plan_id",
        label: "Service plan",
        targetTypes: ["azurerm_service_plan"],
        targetAttribute: "id",
        required: true,
      },
    ],
    blocks: [{ name: "site_config" }],
  },
];

/**
 * The definition of a type, or undefined when the catalog does not know it.
 *
 * A type has as many definitions as it has schemas — one as a resource, one as
 * a data source (GP-248) — so the kind is part of the question. It defaults to
 * `resource`, which is what every caller that never heard of data sources
 * meant, and what every curated entry is.
 */
export function resourceDef(
  type: string,
  catalog: readonly ResourceDef[] = CATALOG,
  kind: SchemaResourceKind = "resource",
): ResourceDef | undefined {
  return catalog.find(
    (def) => def.type === type && (def.kind ?? "resource") === kind,
  );
}

/** The definition that describes a node — its type, read as its own kind. */
export function defFor(
  node: { type: string; mode?: "resource" | "data" },
  catalog: readonly ResourceDef[] = CATALOG,
): ResourceDef | undefined {
  return resourceDef(
    node.type,
    catalog,
    node.mode === "data" ? "data_source" : "resource",
  );
}

/** Where an attribute's value lives on a node. */
export function attributeKey(attribute: AttributeDef): string {
  return attribute.key ?? attribute.name;
}

/** The slot an attribute name names on a type, if it is a slot at all. */
export function referenceSlot(
  def: ResourceDef,
  attribute: string,
): ReferenceSlot | undefined {
  return def.references.find((slot) => slot.attribute === attribute);
}

/**
 * May `toType` be connected into `fromType`'s `attribute` slot? The one place
 * the answer is decided — the canvas asks it while a connection is being
 * dragged, and validation asks it again about the graph it was given.
 *
 * The *source's* kind matters, because the slots are its: a data source looks
 * an existing subnet up by name and a resource declares one. The target's does
 * not — a slot accepts a type, and whether that node is declared or looked up
 * changes only the address the reference renders as.
 */
export function canConnect(
  fromType: string,
  attribute: string,
  toType: string,
  catalog: readonly ResourceDef[] = CATALOG,
  fromKind: SchemaResourceKind = "resource",
): boolean {
  const def = resourceDef(fromType, catalog, fromKind);
  if (!def) return false;
  const slot = referenceSlot(def, attribute);
  return slot ? slot.targetTypes.includes(toType) : false;
}

/** The categories, in palette order. */
export const CATEGORIES: readonly ResourceCategory[] = [
  "foundation",
  "network",
  "compute",
  "data",
];

/** What each category is called in the palette and in the generated file name. */
export const CATEGORY_LABELS: Record<ResourceCategory, string> = {
  foundation: "Foundation",
  network: "Network",
  compute: "Compute",
  data: "Data",
};
