import { test } from "node:test";
import assert from "node:assert/strict";

import {
  firstSentence,
  kindOfCtyType,
  parseProviderSchema,
  renderCtyType,
  type RawProvidersSchema,
} from "./provider-schema-parse.js";
import { serviceOf, providerPrefixOf } from "./provider-schema.js";

/** A cut-down but shape-accurate `terraform providers schema -json`. */
const RAW: RawProvidersSchema = {
  format_version: "1.0",
  provider_schemas: {
    "registry.terraform.io/hashicorp/azurerm": {
      resource_schemas: {
        azurerm_subnet: {
          block: {
            description: "Manages a subnet. Subnets live inside a virtual network.",
            attributes: {
              name: { type: "string", required: true, description: "The name." },
              id: { type: "string", computed: true },
              address_prefixes: {
                type: ["list", "string"],
                required: true,
              },
              virtual_network_name: { type: "string", required: true },
              service_endpoints: { type: ["set", "string"], optional: true },
            },
            block_types: {
              delegation: {
                nesting_mode: "list",
                min_items: 1,
                max_items: 1,
                block: {
                  attributes: { name: { type: "string", required: true } },
                  block_types: {
                    service_delegation: {
                      nesting_mode: "list",
                      min_items: 1,
                      block: {
                        attributes: {
                          name: { type: "string", required: true },
                        },
                      },
                    },
                  },
                },
              },
            },
          },
        },
        azurerm_key_vault: {
          block: {
            attributes: {
              tenant_id: { type: "string", required: true },
              tags: { type: ["map", "string"], optional: true },
              secret: { type: "string", optional: true, sensitive: true },
            },
          },
        },
      },
      data_source_schemas: {
        azurerm_subnet: {
          block: { attributes: { name: { type: "string", required: true } } },
        },
      },
    },
  },
};

test("renderCtyType writes a cty type the way the documentation does", () => {
  assert.equal(renderCtyType("string"), "string");
  assert.equal(renderCtyType(["list", "string"]), "list(string)");
  assert.equal(renderCtyType(["set", ["list", "string"]]), "set(list(string))");
  assert.equal(renderCtyType(["map", "string"]), "map(string)");
  // An object's members are not spelled out — that is what keeps a blob small.
  assert.equal(renderCtyType(["object", { a: "string" }]), "object");
  assert.equal(renderCtyType(undefined), "any");
});

test("kindOfCtyType reduces a type to what a form control can be chosen from", () => {
  assert.equal(kindOfCtyType("string"), "string");
  assert.equal(kindOfCtyType("number"), "number");
  assert.equal(kindOfCtyType("bool"), "bool");
  assert.equal(kindOfCtyType("list(string)"), "list");
  assert.equal(kindOfCtyType("set(string)"), "list");
  assert.equal(kindOfCtyType("map(string)"), "map");
  assert.equal(kindOfCtyType("object"), "object");
});

test("parseProviderSchema narrows resources and data sources, sorted", () => {
  const schemas = parseProviderSchema(RAW, {
    provider: "hashicorp/azurerm",
    version: "4.81.0",
  });

  assert.deepEqual(
    schemas.map((s) => `${s.kind}:${s.type}`),
    [
      "resource:azurerm_key_vault",
      "resource:azurerm_subnet",
      "data_source:azurerm_subnet",
    ],
  );

  const subnet = schemas.find(
    (s) => s.type === "azurerm_subnet" && s.kind === "resource",
  );
  assert.ok(subnet);
  assert.equal(subnet.provider, "hashicorp/azurerm");
  assert.equal(subnet.version, "4.81.0");

  // Attributes are sorted by name, so the same version always stores the same bytes.
  assert.deepEqual(
    subnet.attributes.map((a) => a.name),
    ["address_prefixes", "id", "name", "service_endpoints", "virtual_network_name"],
  );

  const prefixes = subnet.attributes.find((a) => a.name === "address_prefixes");
  assert.equal(prefixes?.type, "list(string)");
  assert.equal(prefixes?.kind, "list");
  assert.equal(prefixes?.required, true);

  // The three provider flags stay apart: `id` is an output nobody may write.
  const id = subnet.attributes.find((a) => a.name === "id");
  assert.equal(id?.computed, true);
  assert.equal(id?.required, false);
  assert.equal(id?.optional, false);
});

test("parseProviderSchema keeps nested blocks with their bounds", () => {
  const [, subnet] = parseProviderSchema(RAW, {
    provider: "hashicorp/azurerm",
    version: "4.81.0",
  });
  const delegation = subnet?.blocks.find((b) => b.name === "delegation");
  assert.ok(delegation);
  assert.equal(delegation.nesting, "list");
  assert.equal(delegation.minItems, 1);
  assert.equal(delegation.maxItems, 1);
  assert.deepEqual(
    delegation.blocks.map((b) => b.name),
    ["service_delegation"],
  );
  // `max_items` omitted means unbounded, not zero.
  assert.equal(delegation.blocks[0]?.maxItems, null);
});

test("parseProviderSchema carries the sensitive flag", () => {
  const [vault] = parseProviderSchema(RAW, {
    provider: "hashicorp/azurerm",
    version: "4.81.0",
  });
  assert.equal(
    vault?.attributes.find((a) => a.name === "secret")?.sensitive,
    true,
  );
});

test("parseProviderSchema is empty for a provider the payload does not carry", () => {
  assert.deepEqual(
    parseProviderSchema(RAW, { provider: "hashicorp/aws", version: "5.0.0" }),
    [],
  );
  assert.deepEqual(
    parseProviderSchema({}, { provider: "hashicorp/azurerm", version: "1.0.0" }),
    [],
  );
});

test("parseProviderSchema is deterministic byte-for-byte", () => {
  const once = parseProviderSchema(RAW, {
    provider: "hashicorp/azurerm",
    version: "4.81.0",
  });
  const twice = parseProviderSchema(RAW, {
    provider: "hashicorp/azurerm",
    version: "4.81.0",
  });
  assert.equal(JSON.stringify(once), JSON.stringify(twice));
});

test("firstSentence is what a one-line picker entry has room for", () => {
  assert.equal(
    firstSentence("Manages a subnet. Subnets live inside a virtual network."),
    "Manages a subnet.",
  );
  assert.equal(firstSentence("Manages a subnet"), "Manages a subnet");
  assert.equal(firstSentence(undefined), "");
});

test("a type's provider prefix and service group come from its name alone", () => {
  assert.equal(providerPrefixOf("azurerm_subnet"), "azurerm");
  assert.equal(serviceOf("azurerm_subnet"), "subnet");
  assert.equal(serviceOf("azurerm_storage_blob"), "storage");
  assert.equal(serviceOf("azurerm_storage_account"), "storage");
});
