import { describe, expect, it } from "vitest";

import type { Graph } from "../types";
import { connectionsOf, nearestChangedAncestor } from "./node-details";

// vnet (update) ← subnet (impacted d1) ← vm (impacted d2) ← lb (create)
// edges point dependent → dependency.
const graph: Graph = {
  version: 3,
  nodes: [
    { id: "azurerm_virtual_network.main", name: "main", type: "azurerm_virtual_network", provider: "azurerm", module_path: [], change: "update" },
    { id: "azurerm_subnet.internal", name: "internal", type: "azurerm_subnet", provider: "azurerm", module_path: [], change: "noop", impacted: true, impact_distance: 1 },
    { id: "azurerm_linux_virtual_machine.web", name: "web", type: "azurerm_linux_virtual_machine", provider: "azurerm", module_path: [], change: "noop", impacted: true, impact_distance: 2 },
    { id: "azurerm_lb.public", name: "public", type: "azurerm_lb", provider: "azurerm", module_path: [], change: "create" },
  ],
  edges: [
    { from: "azurerm_subnet.internal", to: "azurerm_virtual_network.main", kind: "depends_on" },
    { from: "azurerm_linux_virtual_machine.web", to: "azurerm_subnet.internal", kind: "depends_on" },
    { from: "azurerm_lb.public", to: "azurerm_linux_virtual_machine.web", kind: "depends_on" },
  ],
};

describe("connectionsOf (GP-33)", () => {
  it("splits a node's edges into dependencies and dependents", () => {
    const c = connectionsOf(graph, "azurerm_subnet.internal");
    expect(c.dependencies.map((n) => n.id)).toEqual(["azurerm_virtual_network.main"]);
    expect(c.dependents.map((n) => n.id)).toEqual(["azurerm_linux_virtual_machine.web"]);
  });

  it("returns empty lists for an isolated node", () => {
    const c = connectionsOf(graph, "azurerm_virtual_network.main");
    expect(c.dependencies).toEqual([]);
    expect(c.dependents.map((n) => n.id)).toEqual(["azurerm_subnet.internal"]);
  });
});

describe("nearestChangedAncestor (GP-33)", () => {
  it("names the direct changed dependency at distance 1", () => {
    const ancestor = nearestChangedAncestor(graph, "azurerm_subnet.internal");
    expect(ancestor?.node.id).toBe("azurerm_virtual_network.main");
    expect(ancestor?.distance).toBe(1);
    expect(ancestor?.firstHop.id).toBe("azurerm_virtual_network.main");
  });

  it("walks the chain to the nearest changed ancestor and reports the first hop", () => {
    const ancestor = nearestChangedAncestor(graph, "azurerm_linux_virtual_machine.web");
    expect(ancestor?.node.id).toBe("azurerm_virtual_network.main");
    expect(ancestor?.distance).toBe(2);
    // The distance matches the stored impact_distance (GP-22).
    expect(ancestor?.distance).toBe(2);
    expect(ancestor?.firstHop.id).toBe("azurerm_subnet.internal");
  });

  it("returns null when nothing changed is reachable", () => {
    const isolated: Graph = {
      version: 2,
      nodes: [
        { id: "a", name: "a", type: "aws_s3", provider: "aws", module_path: [], change: "noop" },
        { id: "b", name: "b", type: "aws_s3", provider: "aws", module_path: [], change: "noop" },
      ],
      edges: [{ from: "a", to: "b", kind: "depends_on" }],
    };
    expect(nearestChangedAncestor(isolated, "a")).toBeNull();
  });
});
