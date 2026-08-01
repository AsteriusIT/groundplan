import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { BuilderGraph, BuilderNode } from "./builder-graph.js";
import { issuesByNode, validateBuilderGraph } from "./validate.js";

/** A node of `type` with the attributes a valid one needs, minus what the test drops. */
function node(
  id: string,
  type: string,
  name: string,
  attributes: BuilderNode["attributes"] = {},
): BuilderNode {
  return { id, type, name, attributes, position: { x: 0, y: 0 } };
}

/** The demo topology of GP-131: resource group → vnet → subnet → NIC → VM. */
export function demoGraph(): BuilderGraph {
  return {
    nodes: [
      node("rg", "azurerm_resource_group", "this", {
        name: "rg-demo",
        location: "westeurope",
      }),
      node("vnet", "azurerm_virtual_network", "this", {
        name: "vnet-demo",
        location: "westeurope",
        address_space: ["10.0.0.0/16"],
      }),
      node("snet", "azurerm_subnet", "app", {
        name: "snet-app",
        address_prefixes: ["10.0.1.0/24"],
      }),
      node("nic", "azurerm_network_interface", "app", {
        name: "nic-app",
        location: "westeurope",
      }),
      node("vm", "azurerm_linux_virtual_machine", "app", {
        name: "vm-app-01",
        location: "westeurope",
        size: "Standard_B2s",
        admin_username: "azureuser",
      }),
    ],
    references: [
      { from: "vnet", to: "rg", attribute: "resource_group_name" },
      { from: "snet", to: "rg", attribute: "resource_group_name" },
      { from: "snet", to: "vnet", attribute: "virtual_network_name" },
      { from: "nic", to: "rg", attribute: "resource_group_name" },
      { from: "nic", to: "snet", attribute: "subnet_id" },
      { from: "vm", to: "rg", attribute: "resource_group_name" },
      { from: "vm", to: "nic", attribute: "network_interface_ids" },
    ],
  };
}

describe("validateBuilderGraph (GP-132)", () => {
  it("passes the demo topology", () => {
    assert.deepEqual(validateBuilderGraph(demoGraph()), []);
  });

  it("passes an empty graph — nothing composed is not something wrong", () => {
    assert.deepEqual(validateBuilderGraph({ nodes: [], references: [] }), []);
  });

  it("reports a resource type the catalog does not know", () => {
    const graph: BuilderGraph = {
      nodes: [node("x", "aws_instance", "web", { name: "web" })],
      references: [],
    };
    assert.deepEqual(validateBuilderGraph(graph), [
      {
        nodeId: "x",
        reason: "unknown_type",
        message: '"aws_instance" is not a resource type the builder knows',
      },
    ]);
  });

  it("reports a required attribute nobody filled in", () => {
    const graph = demoGraph();
    graph.nodes[0]!.attributes = { location: "westeurope" };
    assert.deepEqual(
      validateBuilderGraph(graph).map((i) => [i.nodeId, i.attribute, i.reason]),
      [["rg", "name", "missing_required"]],
    );
  });

  it("falls back to the catalog default before calling an attribute missing", () => {
    const graph = demoGraph();
    // location has a default; dropping it must not make the node invalid.
    delete graph.nodes[0]!.attributes.location;
    assert.deepEqual(validateBuilderGraph(graph), []);
  });

  it("reports a value that does not fit its kind", () => {
    const graph = demoGraph();
    graph.nodes[4]!.attributes.size = "Standard_Nonsense";
    graph.nodes[1]!.attributes.address_space = "10.0.0.0/16";
    assert.deepEqual(
      validateBuilderGraph(graph).map((i) => [i.nodeId, i.attribute, i.reason]),
      [
        ["vnet", "address_space", "invalid_value"],
        ["vm", "size", "invalid_value"],
      ],
    );
  });

  it("reports an attribute the type does not have", () => {
    const graph = demoGraph();
    graph.nodes[0]!.attributes.sku = "Standard";
    assert.deepEqual(
      validateBuilderGraph(graph).map((i) => [i.nodeId, i.attribute, i.reason]),
      [["rg", "sku", "unknown_attribute"]],
    );
  });

  it("reports an illegal Terraform name", () => {
    const graph = demoGraph();
    graph.nodes[0]!.name = "9-lives";
    const issues = validateBuilderGraph(graph);
    assert.equal(issues[0]?.reason, "invalid_name");
    assert.match(issues[0]?.message ?? "", /not a valid Terraform name/);
  });

  it("reports an empty name in the words of somebody who forgot it", () => {
    const graph = demoGraph();
    graph.nodes[0]!.name = "";
    assert.equal(
      validateBuilderGraph(graph)[0]?.message,
      "this resource needs a Terraform name",
    );
  });

  it("reports two resources of the same type sharing a name", () => {
    const graph = demoGraph();
    graph.nodes.push(
      node("snet2", "azurerm_subnet", "app", {
        name: "snet-data",
        address_prefixes: ["10.0.2.0/24"],
      }),
    );
    graph.references.push(
      { from: "snet2", to: "rg", attribute: "resource_group_name" },
      { from: "snet2", to: "vnet", attribute: "virtual_network_name" },
    );
    assert.deepEqual(
      validateBuilderGraph(graph)
        .filter((i) => i.reason === "duplicate_name")
        .map((i) => i.nodeId),
      ["snet", "snet2"],
    );
  });

  it("lets two resources of different types share a name", () => {
    // `azurerm_virtual_network.this` and `azurerm_resource_group.this` are
    // different addresses — Terraform is fine with it, so the builder is too.
    assert.deepEqual(validateBuilderGraph(demoGraph()), []);
  });

  it("reports a required connection nobody made", () => {
    const graph = demoGraph();
    graph.references = graph.references.filter(
      (r) => !(r.from === "snet" && r.attribute === "virtual_network_name"),
    );
    assert.deepEqual(
      validateBuilderGraph(graph).map((i) => [i.nodeId, i.attribute, i.reason]),
      [["snet", "virtual_network_name", "missing_required"]],
    );
  });

  it("reports a connection whose target is the wrong type", () => {
    const graph = demoGraph();
    graph.references = graph.references.map((r) =>
      r.from === "snet" && r.attribute === "virtual_network_name"
        ? { ...r, to: "rg" }
        : r,
    );
    assert.deepEqual(
      validateBuilderGraph(graph).map((i) => [i.nodeId, i.attribute, i.reason]),
      [["snet", "virtual_network_name", "wrong_target_type"]],
    );
  });

  it("reports a connection to a resource that is not on the canvas", () => {
    const graph = demoGraph();
    graph.references.push({ from: "nic", to: "ghost", attribute: "public_ip_address_id" });
    assert.deepEqual(
      validateBuilderGraph(graph).map((i) => [i.nodeId, i.attribute, i.reason]),
      [["nic", "public_ip_address_id", "dangling_reference"]],
    );
  });

  it("reports a connection from a resource that is not on the canvas", () => {
    const graph = demoGraph();
    graph.references.push({ from: "ghost", to: "rg", attribute: "resource_group_name" });
    assert.deepEqual(
      validateBuilderGraph(graph).map((i) => [i.nodeId, i.reason]),
      [["ghost", "dangling_reference"]],
    );
  });

  it("reports a connection through a slot the type does not have", () => {
    const graph = demoGraph();
    graph.references.push({ from: "rg", to: "vnet", attribute: "virtual_network_name" });
    assert.deepEqual(
      validateBuilderGraph(graph).map((i) => [i.nodeId, i.attribute, i.reason]),
      [["rg", "virtual_network_name", "unknown_slot"]],
    );
  });

  it("reports a second connection into a single-valued slot", () => {
    const graph = demoGraph();
    graph.nodes.push(
      node("vnet2", "azurerm_virtual_network", "other", {
        name: "vnet-other",
        location: "westeurope",
        address_space: ["10.1.0.0/16"],
      }),
    );
    graph.references.push(
      { from: "vnet2", to: "rg", attribute: "resource_group_name" },
      { from: "snet", to: "vnet2", attribute: "virtual_network_name" },
    );
    assert.deepEqual(
      validateBuilderGraph(graph).map((i) => [i.nodeId, i.attribute, i.reason]),
      [["snet", "virtual_network_name", "duplicate_reference"]],
    );
  });

  it("lets a list slot take several connections", () => {
    const graph = demoGraph();
    graph.nodes.push(
      node("nic2", "azurerm_network_interface", "app2", {
        name: "nic-app-2",
        location: "westeurope",
      }),
    );
    graph.references.push(
      { from: "nic2", to: "rg", attribute: "resource_group_name" },
      { from: "nic2", to: "snet", attribute: "subnet_id" },
      { from: "vm", to: "nic2", attribute: "network_interface_ids" },
    );
    assert.deepEqual(validateBuilderGraph(graph), []);
  });

  it("reports every problem at once, never just the first", () => {
    const graph: BuilderGraph = {
      nodes: [
        node("a", "azurerm_subnet", "", {}),
        node("b", "azurerm_key_vault", "kv", {}),
      ],
      references: [],
    };
    const reasons = validateBuilderGraph(graph).map((i) => i.reason);
    assert.ok(reasons.length >= 6, `expected several issues, got ${reasons.length}`);
    assert.ok(reasons.includes("invalid_name"));
    assert.ok(reasons.includes("missing_required"));
  });

  it("groups issues by node for the canvas to badge", () => {
    const graph = demoGraph();
    graph.nodes[0]!.attributes = {};
    graph.nodes[0]!.name = "";
    // The empty name, and the Azure name nobody typed. `location` has a
    // catalog default, so it is not one of them.
    const byNode = issuesByNode(validateBuilderGraph(graph));
    assert.equal(byNode.get("rg")?.length, 2);
    assert.equal(byNode.get("vnet"), undefined);
  });
});
