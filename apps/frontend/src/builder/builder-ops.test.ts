import { describe, expect, it } from "vitest";

import { emptyBuilderGraph, type BuilderGraph } from "@groundplan/builder";

import {
  addNode,
  canAttach,
  connect,
  connectCustom,
  connectedTo,
  CUSTOM_TYPE,
  disconnect,
  freeName,
  removeNode,
  renameNode,
  renameReference,
  retypeNode,
  setAttribute,
  setTargetAttribute,
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

describe("custom resources and dropped positions (GP-133 follow-up)", () => {
  it("adds a custom resource with no type, for the form to ask for", () => {
    const graph = addNode(emptyBuilderGraph(), CUSTOM_TYPE, "c1");
    expect(graph.nodes[0]).toMatchObject({
      type: "",
      name: "resource",
      custom: true,
    });
  });

  it("drops a resource where it was dropped", () => {
    const graph = addNode(emptyBuilderGraph(), "azurerm_subnet", "a", {
      x: 320,
      y: -40,
    });
    expect(graph.nodes[0]?.position).toEqual({ x: 320, y: -40 });
  });

  it("names a custom reference after what it points at, and dedupes", () => {
    let graph = addNode(emptyBuilderGraph(), "azurerm_subnet", "snet");
    graph = addNode(graph, "azurerm_subnet", "snet2");
    graph = addNode(graph, CUSTOM_TYPE, "c1");
    graph = connectCustom(graph, "c1", "snet");
    graph = connectCustom(graph, "c1", "snet2");
    expect(graph.references).toEqual([
      { from: "c1", to: "snet", attribute: "subnet_id", targetAttribute: "id" },
      { from: "c1", to: "snet2", attribute: "subnet_id_2", targetAttribute: "id" },
    ]);
  });

  it("refuses a custom connection from a catalog resource", () => {
    let graph = addNode(emptyBuilderGraph(), "azurerm_subnet", "snet");
    graph = addNode(graph, "azurerm_virtual_network", "vnet");
    expect(connectCustom(graph, "snet", "vnet")).toBe(graph);
  });

  it("renames a reference and retargets which attribute it reads", () => {
    let graph = addNode(emptyBuilderGraph(), "azurerm_subnet", "snet");
    graph = addNode(graph, CUSTOM_TYPE, "c1");
    graph = connectCustom(graph, "c1", "snet");
    graph = renameReference(graph, "c1", "subnet_id", "scope");
    graph = setTargetAttribute(graph, "c1", "scope", "name");
    expect(graph.references[0]).toEqual({
      from: "c1",
      to: "snet",
      attribute: "scope",
      targetAttribute: "name",
    });
  });

  it("retypes a custom resource, and only a custom one", () => {
    let graph = addNode(emptyBuilderGraph(), CUSTOM_TYPE, "c1");
    graph = addNode(graph, "azurerm_subnet", "snet");
    graph = retypeNode(graph, "c1", "azurerm_management_lock");
    graph = retypeNode(graph, "snet", "aws_instance");
    expect(graph.nodes[0]?.type).toBe("azurerm_management_lock");
    expect(graph.nodes[1]?.type).toBe("azurerm_subnet");
  });
});
