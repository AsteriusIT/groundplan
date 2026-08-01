import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  CATALOG,
  CATEGORIES,
  canConnect,
  referenceSlot,
  resourceDef,
  type ResourceDef,
} from "./catalog.js";
import { validateBuilderGraph } from "./validate.js";
import type { BuilderGraph } from "./builder-graph.js";

describe("resource catalog (GP-132)", () => {
  it("covers the demo topology", () => {
    const types = CATALOG.map((def) => def.type);
    assert.deepEqual(types, [
      "azurerm_resource_group",
      "azurerm_virtual_network",
      "azurerm_subnet",
      "azurerm_network_security_group",
      "azurerm_public_ip",
      "azurerm_network_interface",
      "azurerm_linux_virtual_machine",
      "azurerm_storage_account",
      "azurerm_key_vault",
      "azurerm_private_endpoint",
      "azurerm_service_plan",
      "azurerm_linux_web_app",
    ]);
  });

  it("declares each type once, in a category the palette shows", () => {
    const seen = new Set<string>();
    for (const def of CATALOG) {
      assert.equal(seen.has(def.type), false, `${def.type} is declared twice`);
      seen.add(def.type);
      assert.ok(CATEGORIES.includes(def.category), `${def.type}: ${def.category}`);
    }
  });

  it("only points slots at types the catalog knows", () => {
    for (const def of CATALOG) {
      for (const slot of def.references) {
        assert.notEqual(slot.targetTypes.length, 0, `${def.type}.${slot.attribute}`);
        for (const target of slot.targetTypes) {
          assert.ok(
            resourceDef(target),
            `${def.type}.${slot.attribute} points at unknown ${target}`,
          );
        }
      }
    }
  });

  it("never declares an attribute and a slot under the same name", () => {
    for (const def of CATALOG) {
      const attributes = new Set(def.attributes.map((a) => a.name));
      for (const slot of def.references) {
        assert.equal(
          attributes.has(slot.attribute),
          false,
          `${def.type}.${slot.attribute} is both a field and a connection`,
        );
      }
    }
  });

  it("gives every enum its values, and every default the right shape", () => {
    for (const def of CATALOG) {
      for (const attribute of def.attributes) {
        if (attribute.kind === "enum") {
          const values = attribute.values ?? [];
          assert.notEqual(values.length, 0, `${def.type}.${attribute.name}`);
          if (attribute.default !== undefined) {
            assert.ok(
              values.includes(String(attribute.default)),
              `${def.type}.${attribute.name} defaults outside its values`,
            );
          }
        }
        if (attribute.kind === "list" && attribute.default !== undefined) {
          assert.ok(Array.isArray(attribute.default), `${def.type}.${attribute.name}`);
        }
      }
    }
  });

  it("only hosts attributes and slots in blocks the type declares", () => {
    for (const def of CATALOG) {
      const blocks = new Set((def.blocks ?? []).map((b) => b.name));
      for (const item of [...def.attributes, ...def.references]) {
        if (item.block) {
          assert.ok(
            blocks.has(item.block),
            `${def.type} hosts something in undeclared block ${item.block}`,
          );
        }
      }
    }
  });

  it("decides connectability from the slot's target types", () => {
    assert.equal(
      canConnect("azurerm_subnet", "virtual_network_name", "azurerm_virtual_network"),
      true,
    );
    // A subnet is not a virtual network, however much the form would like it.
    assert.equal(
      canConnect("azurerm_subnet", "virtual_network_name", "azurerm_subnet"),
      false,
    );
    // A slot the type does not have is never connectable.
    assert.equal(
      canConnect("azurerm_resource_group", "virtual_network_name", "azurerm_virtual_network"),
      false,
    );
    // Neither is a type the catalog never heard of.
    assert.equal(canConnect("aws_vpc", "resource_group_name", "azurerm_resource_group"), false);
  });

  it("finds a slot by its attribute name", () => {
    const subnet = resourceDef("azurerm_subnet");
    assert.ok(subnet);
    assert.equal(referenceSlot(subnet, "virtual_network_name")?.targetAttribute, "name");
    assert.equal(referenceSlot(subnet, "nonsense"), undefined);
  });
});

describe("extending the catalog (GP-132)", () => {
  // The acceptance criterion, executed: a new resource type is one entry, and
  // nothing else in the package learns about it.
  const EXTRA: ResourceDef = {
    type: "azurerm_container_registry",
    label: "Container registry",
    category: "data",
    description: "Where images are pushed.",
    attributes: [
      { name: "name", label: "Azure name", kind: "string", required: true },
      { name: "sku", label: "SKU", kind: "enum", required: true, values: ["Basic", "Standard"] },
    ],
    references: [
      {
        attribute: "resource_group_name",
        label: "Resource group",
        targetTypes: ["azurerm_resource_group"],
        targetAttribute: "name",
        required: true,
      },
    ],
  };

  const extended = [...CATALOG, EXTRA];

  const graph: BuilderGraph = {
    nodes: [
      {
        id: "rg",
        type: "azurerm_resource_group",
        name: "this",
        attributes: { name: "rg-demo", location: "westeurope" },
        position: { x: 0, y: 0 },
      },
      {
        id: "acr",
        type: "azurerm_container_registry",
        name: "this",
        attributes: { name: "acrdemo", sku: "Basic" },
        position: { x: 0, y: 200 },
      },
    ],
    references: [{ from: "acr", to: "rg", attribute: "resource_group_name" }],
  };

  it("validates the new type through the same engine", () => {
    assert.deepEqual(validateBuilderGraph(graph, extended), []);
  });

  it("still rejects the new type when the catalog does not carry it", () => {
    const issues = validateBuilderGraph(graph);
    assert.deepEqual(
      issues.map((i) => i.reason),
      ["unknown_type"],
    );
  });
});
