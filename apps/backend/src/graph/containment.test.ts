import { test } from "node:test";
import assert from "node:assert/strict";

import { deriveContainment } from "./containment.js";
import {
  buildInstancesByBase,
  type DependencySource,
  type EdgeContext,
} from "./dependency-edges.js";
import type { GraphNode } from "./graph.js";

function node(id: string, type: string): GraphNode {
  return {
    id,
    name: id.split(".").pop()!,
    type,
    provider: "azurerm",
    module_path: [],
    change: null,
  };
}

function ctxFor(nodes: GraphNode[]): EdgeContext {
  const resourceIds = new Set(
    nodes.filter((n) => n.type !== "module").map((n) => n.id),
  );
  return {
    resourceIds,
    moduleIds: new Set(),
    instancesByBase: buildInstancesByBase(resourceIds),
  };
}

test("subnet is contained by the vnet it references", () => {
  const nodes = [
    node("azurerm_virtual_network.main", "azurerm_virtual_network"),
    node("azurerm_subnet.internal", "azurerm_subnet"),
  ];
  const sources: DependencySource[] = [
    {
      fromBase: "azurerm_subnet.internal",
      prefix: "",
      refs: [{ ref: "azurerm_virtual_network.main.name", inferred: true }],
    },
  ];
  deriveContainment(nodes, sources, ctxFor(nodes));
  assert.equal(nodes[1]!.parent_id, "azurerm_virtual_network.main");
  assert.equal(nodes[0]!.parent_id, undefined); // vnet has no parent
});

test("a NIC is contained by the subnet it references", () => {
  const nodes = [
    node("azurerm_subnet.internal", "azurerm_subnet"),
    node("azurerm_network_interface.main", "azurerm_network_interface"),
  ];
  const sources: DependencySource[] = [
    {
      fromBase: "azurerm_network_interface.main",
      prefix: "",
      refs: [{ ref: "azurerm_subnet.internal.id", inferred: true }],
    },
  ];
  deriveContainment(nodes, sources, ctxFor(nodes));
  assert.equal(nodes[1]!.parent_id, "azurerm_subnet.internal");
});

test("a VM referencing only a NIC has no subnet parent", () => {
  const nodes = [
    node("azurerm_network_interface.main", "azurerm_network_interface"),
    node("azurerm_virtual_machine.main", "azurerm_virtual_machine"),
  ];
  const sources: DependencySource[] = [
    {
      fromBase: "azurerm_virtual_machine.main",
      prefix: "",
      refs: [{ ref: "azurerm_network_interface.main.id", inferred: true }],
    },
  ];
  deriveContainment(nodes, sources, ctxFor(nodes));
  assert.equal(nodes[1]!.parent_id, undefined);
});

test("an ambiguous (count) subnet reference yields no parent", () => {
  const nodes = [
    node("azurerm_subnet.extra[0]", "azurerm_subnet"),
    node("azurerm_subnet.extra[1]", "azurerm_subnet"),
    node("azurerm_route_table.rt", "azurerm_route_table"),
  ];
  const sources: DependencySource[] = [
    {
      fromBase: "azurerm_route_table.rt",
      prefix: "",
      refs: [{ ref: "azurerm_subnet.extra", inferred: true }],
    },
  ];
  deriveContainment(nodes, sources, ctxFor(nodes));
  assert.equal(nodes[2]!.parent_id, undefined);
});

test("containment resolves under a module prefix", () => {
  const nodes = [
    node("module.net.azurerm_virtual_network.main", "azurerm_virtual_network"),
    node("module.net.azurerm_subnet.internal", "azurerm_subnet"),
  ];
  const sources: DependencySource[] = [
    {
      fromBase: "module.net.azurerm_subnet.internal",
      prefix: "module.net.",
      refs: [{ ref: "azurerm_virtual_network.main.name", inferred: true }],
    },
  ];
  deriveContainment(nodes, sources, ctxFor(nodes));
  assert.equal(
    nodes[1]!.parent_id,
    "module.net.azurerm_virtual_network.main",
  );
});
