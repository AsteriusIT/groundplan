import assert from "node:assert/strict";
import { test } from "node:test";

import { CATALOG } from "./catalog.js";
import {
  ancestorsOf,
  canContain,
  containerTypes,
  containmentSlot,
  descendantsOf,
  isContainerType,
  rootNodes,
} from "./containment.js";
import { mergeCatalog } from "./schema-def.js";
import type { BuilderGraph, BuilderNode } from "./builder-graph.js";

function node(id: string, type: string, parentId?: string): BuilderNode {
  return {
    id,
    type,
    name: id,
    attributes: {},
    position: { x: 0, y: 0 },
    ...(parentId ? { parentId } : {}),
  };
}

test("the Azure chain nests: resource group ⊃ vnet ⊃ subnet", () => {
  assert.ok(canContain("azurerm_resource_group", "azurerm_virtual_network"));
  assert.ok(canContain("azurerm_virtual_network", "azurerm_subnet"));
  assert.ok(canContain("azurerm_resource_group", "azurerm_subnet"));
});

test("nothing may be drawn inside what does not take it", () => {
  // A vnet is not a home for another vnet, and a subnet is not a home for a
  // resource group — the slots say so, and nothing else had to.
  assert.equal(canContain("azurerm_virtual_network", "azurerm_virtual_network"), false);
  assert.equal(canContain("azurerm_subnet", "azurerm_resource_group"), false);
  assert.equal(canContain("azurerm_subnet", "azurerm_storage_account"), false);
});

test("the tighter home wins when a type could go in either", () => {
  // A subnet references both its resource group (required) and its vnet
  // (required); against a vnet the slot chosen is the vnet's.
  const slot = containmentSlot("azurerm_subnet", "azurerm_virtual_network");
  assert.equal(slot?.attribute, "virtual_network_name");
  const outer = containmentSlot("azurerm_subnet", "azurerm_resource_group");
  assert.equal(outer?.attribute, "resource_group_name");
});

test("a container is a type something points at, never a list", () => {
  const types = containerTypes(CATALOG);
  assert.ok(types.includes("azurerm_resource_group"));
  assert.ok(types.includes("azurerm_virtual_network"));
  assert.ok(types.includes("azurerm_subnet"));
  // A leaf is a type nothing needs: a virtual machine uses a NIC, a subnet and
  // a resource group, and nothing in the catalog asks for a virtual machine.
  assert.equal(isContainerType("azurerm_linux_virtual_machine"), false);
  assert.equal(isContainerType("azurerm_linux_web_app"), false);
  // Only types the catalog in hand actually has.
  assert.ok(types.every((type) => CATALOG.some((def) => def.type === type)));
});

test("a made-up catalog gets its own containment, with no code change", () => {
  const catalog = [
    {
      type: "acme_estate",
      label: "Estate",
      description: "",
      attributes: [],
      references: [],
    },
    {
      type: "acme_barn",
      label: "Barn",
      description: "",
      attributes: [],
      references: [
        {
          attribute: "estate_id",
          label: "Estate",
          targetTypes: ["acme_estate"],
          targetAttribute: "id",
          required: true,
        },
      ],
    },
  ];
  assert.ok(canContain("acme_estate", "acme_barn", catalog));
  assert.deepEqual(containerTypes(catalog), ["acme_estate"]);
});

test("reads the chain a node sits in, and what sits in it", () => {
  const graph: BuilderGraph = {
    nodes: [
      node("rg", "azurerm_resource_group"),
      node("vnet", "azurerm_virtual_network", "rg"),
      node("subnet", "azurerm_subnet", "vnet"),
      node("loose", "azurerm_storage_account"),
    ],
    references: [],
  };

  assert.deepEqual(
    ancestorsOf(graph, "subnet").map((n) => n.id),
    ["vnet", "rg"],
  );
  assert.deepEqual(
    descendantsOf(graph, "rg").map((n) => n.id),
    ["vnet", "subnet"],
  );
  assert.deepEqual(
    rootNodes(graph).map((n) => n.id),
    ["rg", "loose"],
  );
});

test("a parent that is not there leaves its child at the top level", () => {
  const graph: BuilderGraph = {
    nodes: [node("subnet", "azurerm_subnet", "deleted")],
    references: [],
  };
  assert.deepEqual(
    rootNodes(graph).map((n) => n.id),
    ["subnet"],
  );
  assert.deepEqual(ancestorsOf(graph, "subnet"), []);
});

test("a cycle in the data does not hang the walk", () => {
  const graph: BuilderGraph = {
    nodes: [
      node("a", "azurerm_resource_group", "b"),
      node("b", "azurerm_virtual_network", "a"),
    ],
    references: [],
  };
  assert.deepEqual(
    ancestorsOf(graph, "a").map((n) => n.id),
    ["b"],
  );
});

test("a relationship with several is not containment", () => {
  // A virtual machine's network interfaces are a list: a node cannot be drawn
  // inside two frames, so that stays a reference and a NIC stays a card.
  assert.equal(
    canContain("azurerm_network_interface", "azurerm_linux_virtual_machine"),
    false,
  );
  assert.equal(isContainerType("azurerm_network_interface"), false);
});

test("a lookup nests exactly as a resource does (GP-248)", () => {
  // What a `data "azurerm_subnet"` needs in order to be found: the network and
  // the group it is in — the same two slots, so the same two frames.
  const catalog = mergeCatalog([
    {
      type: "azurerm_subnet",
      kind: "data_source" as const,
      label: "Subnet",
      description: "An existing subnet.",
      attributes: [{ name: "name", label: "Name", kind: "string" as const, required: true }],
      references: [
        {
          attribute: "virtual_network_name",
          label: "Virtual network",
          targetTypes: ["azurerm_virtual_network"],
          targetAttribute: "name",
          required: true,
        },
      ],
    },
  ]);

  const lookup = { type: "azurerm_subnet", mode: "data" as const };
  assert.ok(canContain("azurerm_virtual_network", lookup, catalog));
  assert.equal(
    containmentSlot(lookup, "azurerm_virtual_network", catalog)?.attribute,
    "virtual_network_name",
  );
  // The resource's own slots are not the lookup's: a subnet resource also sits
  // in a resource group, and this data source is not asked for one.
  assert.equal(canContain("azurerm_resource_group", lookup, catalog), false);
  assert.ok(canContain("azurerm_resource_group", "azurerm_subnet", catalog));
});
