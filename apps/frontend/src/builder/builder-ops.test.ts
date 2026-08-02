import { describe, expect, it } from "vitest";

import { emptyBuilderGraph, type BuilderGraph } from "@groundplan/builder";

import {
  addNode,
  canAttach,
  canNest,
  connect,
  connectCustom,
  connectedTo,
  CUSTOM_TYPE,
  disconnect,
  freeName,
  removeBranch,
  removeNode,
  renameNode,
  reparent,
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

// ---------------------------------------------------------------------------
// Containment (GP-247): the Build Editor draws relationships as space, and the
// space *is* the reference.
// ---------------------------------------------------------------------------

describe("containment (GP-247)", () => {
  /** rg ⊃ vnet ⊃ subnet, drawn rather than wired. */
  function nested(): BuilderGraph {
    let graph = threeNodes();
    graph = reparent(graph, "n2", "n1");
    return reparent(graph, "n3", "n2");
  }

  it("nesting fills the slot that takes the container", () => {
    const graph = reparent(threeNodes(), "n2", "n1");
    expect(graph.nodes.find((n) => n.id === "n2")?.parentId).toBe("n1");
    expect(graph.references).toEqual([
      { from: "n2", to: "n1", attribute: "resource_group_name" },
    ]);
  });

  it("fills every slot the whole chain answers", () => {
    const graph = nested();
    // The subnet is in the vnet, and the vnet is in the resource group — so
    // both of the subnet's required references are answered by where it sits.
    expect(
      graph.references
        .filter((r) => r.from === "n3")
        .map((r) => `${r.attribute}→${r.to}`)
        .sort(),
    ).toEqual(["resource_group_name→n1", "virtual_network_name→n2"]);
  });

  it("refuses a nesting the catalog has no slot for", () => {
    const graph = threeNodes();
    // A resource group inside a subnet is not a thing.
    expect(reparent(graph, "n1", "n3")).toBe(graph);
    expect(canNest(graph, "n1", "n3")).toBe(false);
  });

  it("refuses to put a container inside its own descendant", () => {
    const graph = nested();
    expect(canNest(graph, "n1", "n3")).toBe(false);
    expect(reparent(graph, "n1", "n3")).toBe(graph);
    // And nothing contains itself.
    expect(canNest(graph, "n2", "n2")).toBe(false);
  });

  it("moving to another container retargets rather than accumulating", () => {
    let graph = nested();
    graph = addNode(graph, "azurerm_virtual_network", "n4");
    graph = reparent(graph, "n4", "n1");
    graph = reparent(graph, "n3", "n4");

    const subnet = graph.references.filter((r) => r.from === "n3");
    expect(subnet.map((r) => `${r.attribute}→${r.to}`).sort()).toEqual([
      "resource_group_name→n1",
      "virtual_network_name→n4",
    ]);
  });

  /**
   * The one shape containment cannot draw on its own: a private endpoint needs
   * a subnet to sit in *and* a service to reach, and a node sits in one place.
   */
  function endpoint(): BuilderGraph {
    let graph = addNode(emptyBuilderGraph(), "azurerm_resource_group", "rg");
    graph = addNode(graph, "azurerm_virtual_network", "vnet");
    graph = addNode(graph, "azurerm_subnet", "snet");
    graph = addNode(graph, "azurerm_key_vault", "kv");
    graph = addNode(graph, "azurerm_private_endpoint", "pe");
    graph = reparent(graph, "vnet", "rg");
    graph = reparent(graph, "snet", "vnet");
    return reparent(graph, "kv", "rg");
  }

  const slotsOf = (graph: BuilderGraph, id: string) =>
    graph.references
      .filter((r) => r.from === id)
      .map((r) => `${r.attribute}→${r.to}`)
      .sort();

  it("keeps the slots the new container has no answer for (GP-247)", () => {
    let graph = reparent(endpoint(), "pe", "snet");
    expect(slotsOf(graph, "pe")).toEqual([
      "resource_group_name→rg",
      "subnet_id→snet",
    ]);

    // Carried into the key vault's frame: it reaches the vault now, and it
    // still uses the subnet it always used — that reference is simply drawn
    // as a wire from here on, rather than as the box around it.
    graph = reparent(graph, "pe", "kv");
    expect(slotsOf(graph, "pe")).toEqual([
      "private_connection_resource_id→kv",
      "resource_group_name→rg",
      "subnet_id→snet",
    ]);

    // And back the other way, which is the same trap in reverse.
    graph = reparent(graph, "pe", "snet");
    expect(slotsOf(graph, "pe")).toEqual([
      "private_connection_resource_id→kv",
      "resource_group_name→rg",
      "subnet_id→snet",
    ]);
  });

  it("connects a second slot without moving the node out of its frame", () => {
    let graph = reparent(endpoint(), "pe", "snet");
    graph = connect(graph, "pe", "private_connection_resource_id", "kv");

    // The form filled the target service; the endpoint stayed in its subnet.
    expect(graph.nodes.find((n) => n.id === "pe")?.parentId).toBe("snet");
    expect(slotsOf(graph, "pe")).toEqual([
      "private_connection_resource_id→kv",
      "resource_group_name→rg",
      "subnet_id→snet",
    ]);
  });

  it("still moves a node when the connection is the slot it is drawn by", () => {
    let graph = reparent(threeNodes(), "n2", "n1");
    graph = addNode(graph, "azurerm_resource_group", "n4");
    graph = disconnect(graph, "n2", "resource_group_name", "n1");
    graph = connect(graph, "n2", "resource_group_name", "n4");

    // Choosing another resource group is a move: the frame is that slot.
    expect(graph.nodes.find((n) => n.id === "n2")?.parentId).toBe("n4");
    expect(slotsOf(graph, "n2")).toEqual(["resource_group_name→n4"]);
  });

  it("dragging back onto the canvas empties what the container filled", () => {
    const graph = reparent(nested(), "n3", undefined);
    expect(graph.nodes.find((n) => n.id === "n3")?.parentId).toBeUndefined();
    expect(graph.references.filter((r) => r.from === "n3")).toEqual([]);
  });

  it("leaves a reference somebody made by hand alone", () => {
    let graph = threeNodes();
    graph = connect(graph, "n2", "resource_group_name", "n1");
    graph = reparent(graph, "n2", "n1");
    // One reference, not two: the slot was already answered.
    expect(graph.references).toHaveLength(1);
  });

  it("deleting a container takes the branch, or keeps it one level up", () => {
    const graph = nested();

    const gone = removeBranch(graph, "n2", "delete");
    expect(gone.nodes.map((n) => n.id)).toEqual(["n1"]);
    expect(gone.references).toEqual([]);

    const kept = removeBranch(graph, "n2", "promote");
    expect(kept.nodes.map((n) => n.id)).toEqual(["n1", "n3"]);
    expect(kept.nodes.find((n) => n.id === "n3")?.parentId).toBe("n1");
    // The vnet's slot went with the vnet; the resource group's remains.
    expect(kept.references.map((r) => `${r.attribute}→${r.to}`)).toEqual([
      "resource_group_name→n1",
    ]);
  });

  it("promoting out of the outermost container leaves the node on the canvas", () => {
    const graph = reparent(threeNodes(), "n2", "n1");
    const kept = removeBranch(graph, "n1", "promote");
    expect(kept.nodes.map((n) => n.id)).toEqual(["n2", "n3"]);
    expect(kept.nodes.find((n) => n.id === "n2")?.parentId).toBeUndefined();
    expect(kept.references).toEqual([]);
  });
});
