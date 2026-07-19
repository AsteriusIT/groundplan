import { expect, it } from "vitest";

import type { GraphNode } from "../types";
import { fuzzyMatch, searchNodes } from "./graph-search";

function node(id: string, name: string, type: string): GraphNode {
  return { id, name, type, provider: "azurerm", module_path: [], change: null };
}

const nodes: GraphNode[] = [
  node("azurerm_virtual_network.main", "main", "azurerm_virtual_network"),
  node("azurerm_subnet.internal", "internal", "azurerm_subnet"),
  node("azurerm_virtual_machine.web", "web", "azurerm_virtual_machine"),
  { id: "module.net", name: "net", type: "module", provider: null, module_path: [], change: null },
];

it("fuzzyMatch does subsequence matching", () => {
  expect(fuzzyMatch("vnet", "azurerm_virtual_network")).toBe(true);
  expect(fuzzyMatch("subnet", "azurerm_subnet")).toBe(true);
  expect(fuzzyMatch("xyz", "azurerm_subnet")).toBe(false);
});

it("finds virtual_network nodes when typing 'vnet'", () => {
  const results = searchNodes(nodes, "vnet");
  expect(results[0]?.id).toBe("azurerm_virtual_network.main");
  expect(results.every((n) => n.type !== "module")).toBe(true);
});

it("returns nothing for a blank query and caps at the limit", () => {
  expect(searchNodes(nodes, "")).toEqual([]);
  expect(searchNodes(nodes, "e", 2).length).toBeLessThanOrEqual(2);
});
