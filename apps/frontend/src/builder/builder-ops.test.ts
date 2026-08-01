import { describe, expect, it } from "vitest";

import { emptyBuilderGraph, type BuilderGraph } from "@groundplan/builder";

import {
  addNode,
  canAttach,
  connect,
  connectedTo,
  disconnect,
  freeName,
  removeNode,
  renameNode,
  setAttribute,
} from "./builder-ops";

/** A resource group, a virtual network and a subnet, nothing connected yet. */
function threeNodes(): BuilderGraph {
  let graph = addNode(emptyBuilderGraph(), "azurerm_resource_group", "n1");
  graph = addNode(graph, "azurerm_virtual_network", "n2");
  return addNode(graph, "azurerm_subnet", "n3");
}

describe("builder operations (GP-133)", () => {
  it("names a new resource after its type, then counts up", () => {
    const graph = addNode(emptyBuilderGraph(), "azurerm_subnet", "a");
    expect(graph.nodes[0]?.name).toBe("subnet");
    expect(freeName(graph, "azurerm_subnet")).toBe("subnet_2");
    // A different type may reuse the name — they are different addresses.
    expect(freeName(graph, "azurerm_virtual_network")).toBe("virtual_network");
  });

  it("prefills the catalog's defaults, so the form shows what will be generated", () => {
    const graph = addNode(emptyBuilderGraph(), "azurerm_virtual_network", "a");
    expect(graph.nodes[0]?.attributes).toMatchObject({
      location: "westeurope",
      address_space: ["10.0.0.0/16"],
    });
  });

  it("stacks new resources instead of dropping them on each other", () => {
    const graph = threeNodes();
    const ys = graph.nodes.map((n) => n.position.y);
    expect(new Set(ys).size).toBe(3);
  });

  it("adds nothing for a type the catalog does not know", () => {
    const graph = addNode(emptyBuilderGraph(), "aws_instance", "a");
    expect(graph.nodes).toEqual([]);
  });

  it("connects where the catalog allows it", () => {
    const graph = connect(threeNodes(), "n3", "virtual_network_name", "n2");
    expect(graph.references).toEqual([
      { from: "n3", to: "n2", attribute: "virtual_network_name" },
    ]);
  });

  it("refuses a connection to the wrong type", () => {
    const graph = threeNodes();
    // A resource group is not a virtual network, however convenient.
    expect(canAttach(graph, "n3", "virtual_network_name", "n1")).toBe(false);
    expect(connect(graph, "n3", "virtual_network_name", "n1")).toBe(graph);
  });

  it("refuses a second connection into a single-valued slot", () => {
    let graph = connect(threeNodes(), "n3", "virtual_network_name", "n2");
    graph = addNode(graph, "azurerm_virtual_network", "n4");
    expect(canAttach(graph, "n3", "virtual_network_name", "n4")).toBe(false);
  });

  it("allows several connections into a list slot", () => {
    let graph = addNode(emptyBuilderGraph(), "azurerm_linux_virtual_machine", "vm");
    graph = addNode(graph, "azurerm_network_interface", "nic1");
    graph = addNode(graph, "azurerm_network_interface", "nic2");
    graph = connect(graph, "vm", "network_interface_ids", "nic1");
    expect(canAttach(graph, "vm", "network_interface_ids", "nic2")).toBe(true);
    graph = connect(graph, "vm", "network_interface_ids", "nic2");
    expect(connectedTo(graph, "vm", "network_interface_ids")).toHaveLength(2);
  });

  it("refuses the same connection twice, and a resource pointing at itself", () => {
    const graph = connect(threeNodes(), "n3", "virtual_network_name", "n2");
    expect(canAttach(graph, "n3", "virtual_network_name", "n2")).toBe(false);
    expect(canAttach(graph, "n2", "resource_group_name", "n2")).toBe(false);
  });

  it("takes a resource's connections with it when it is deleted", () => {
    let graph = connect(threeNodes(), "n3", "virtual_network_name", "n2");
    graph = connect(graph, "n2", "resource_group_name", "n1");
    graph = removeNode(graph, "n2");
    expect(graph.nodes.map((n) => n.id)).toEqual(["n1", "n3"]);
    // No dangling edge in either direction.
    expect(graph.references).toEqual([]);
  });

  it("disconnects one connection without touching the others", () => {
    let graph = connect(threeNodes(), "n3", "virtual_network_name", "n2");
    graph = connect(graph, "n3", "resource_group_name", "n1");
    graph = disconnect(graph, "n3", "virtual_network_name", "n2");
    expect(graph.references).toEqual([
      { from: "n3", to: "n1", attribute: "resource_group_name" },
    ]);
  });

  it("renames without disturbing anything else", () => {
    const graph = renameNode(threeNodes(), "n1", "platform");
    expect(graph.nodes[0]?.name).toBe("platform");
    expect(graph.nodes[1]?.name).toBe("virtual_network");
  });

  it("removes an attribute rather than storing it blank", () => {
    const graph = setAttribute(threeNodes(), "n1", "location", undefined);
    expect(graph.nodes[0]?.attributes).not.toHaveProperty("location");
  });
});
