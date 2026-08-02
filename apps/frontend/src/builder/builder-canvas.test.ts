/**
 * What a wire dropped on a node may attach to (GP-250).
 *
 * The drag itself is a pointer gesture and is verified in a browser; this is
 * the rule the menu is built from, which is the part that can be wrong in a
 * way nobody would notice: offering an argument that is already spoken for, or
 * a slot that would be refused the moment it was chosen.
 */
import { describe, expect, it } from "vitest";

import { emptyBuilderGraph, type BuilderGraph } from "@groundplan/builder";

import { bindableOn } from "./builder-canvas";
import { addNode, connect } from "./builder-ops";

/** A resource group, a subnet, and a variable to point at things. */
function canvas(): BuilderGraph {
  let graph = addNode(emptyBuilderGraph(), "azurerm_resource_group", "rg");
  graph = addNode(graph, "azurerm_subnet", "snet");
  return {
    ...graph,
    nodes: [
      ...graph.nodes,
      {
        id: "loc",
        type: "",
        mode: "variable",
        name: "location",
        attributes: { type: "string" },
        position: { x: 0, y: 0 },
      },
    ],
  };
}

const offered = (graph: BuilderGraph, target: string, source: string) =>
  bindableOn(graph, graph.nodes.find((n) => n.id === target)!, source).map(
    (row) => row.label,
  );

describe("what a dropped wire may attach to (GP-250)", () => {
  it("offers a variable every argument of the node it lands on", () => {
    // A resource group is a name and a place: both are values, so both are
    // things a variable can stand in for.
    expect(offered(canvas(), "rg", "loc")).toEqual(["Azure name", "Location"]);
  });

  it("offers the slots too, required ones first", () => {
    // A subnet has arguments *and* connections, and a variable may fill either
    // — `subnet_id = var.subnet_id` is ordinary Terraform.
    expect(offered(canvas(), "snet", "loc")).toEqual([
      "Azure name",
      "Address prefixes",
      "Resource group",
      "Virtual network",
    ]);
  });

  it("stops offering what is already spoken for", () => {
    const graph = connect(canvas(), "rg", "location", "loc");
    expect(offered(graph, "rg", "loc")).toEqual(["Azure name"]);
  });

  it("offers a resource only where its own type is taken", () => {
    // A resource group is not a value: the only thing on a subnet that accepts
    // one is the slot that says so.
    expect(offered(canvas(), "snet", "rg")).toEqual(["Resource group"]);
    // And nothing on a resource group accepts a subnet at all.
    expect(offered(canvas(), "rg", "snet")).toEqual([]);
  });
});
