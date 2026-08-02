import { describe, expect, it } from "vitest";

import { emptyBuilderGraph, type BuilderGraph } from "@groundplan/builder";

import {
  absoluteBoxes,
  byDepth,
  CARD_HEIGHT,
  CARD_WIDTH,
  containerAt,
  CONTAINER_MIN_HEIGHT,
  CONTAINER_MIN_WIDTH,
  CONTAINER_PADDING,
  drawsAsContainer,
  relativePosition,
} from "./builder-layout";
import { addNode, moveNode, reparent } from "./builder-ops";

/** A resource group at the origin holding a vnet 40/60 into it. */
function nested(): BuilderGraph {
  let graph = addNode(emptyBuilderGraph(), "azurerm_resource_group", "rg", {
    x: 0,
    y: 0,
  });
  graph = addNode(graph, "azurerm_virtual_network", "vnet", { x: 40, y: 60 });
  return reparent(graph, "vnet", "rg");
}

describe("build editor geometry (GP-247)", () => {
  it("draws a card as a card and a container as a frame", () => {
    const graph = nested();
    expect(drawsAsContainer(graph, "rg")).toBe(true);
    // A vnet is a frame before anything is in it: it is somewhere to drop.
    expect(drawsAsContainer(graph, "vnet")).toBe(true);

    const withVm = addNode(graph, "azurerm_linux_virtual_machine", "vm");
    expect(drawsAsContainer(withVm, "vm")).toBe(false);
  });

  it("sizes an empty frame to a place worth dropping into", () => {
    const graph = addNode(emptyBuilderGraph(), "azurerm_resource_group", "rg");
    const box = absoluteBoxes(graph).get("rg");
    expect(box?.width).toBe(CONTAINER_MIN_WIDTH);
    expect(box?.height).toBe(CONTAINER_MIN_HEIGHT);
  });

  it("grows a frame around what is in it, without moving it", () => {
    let graph = nested();
    graph = moveNode(graph, "vnet", { x: 400, y: 300 });
    const box = absoluteBoxes(graph).get("rg");

    // The frame's origin is still where the user left it.
    expect(box?.x).toBe(0);
    expect(box?.y).toBe(0);
    // …and it reaches past the vnet's own frame, with room to spare.
    expect(box?.width).toBe(400 + CONTAINER_MIN_WIDTH + CONTAINER_PADDING);
    expect(box?.height).toBe(300 + CONTAINER_MIN_HEIGHT + CONTAINER_PADDING);
  });

  it("gives a leaf its card's footprint", () => {
    const graph = addNode(
      emptyBuilderGraph(),
      "azurerm_linux_virtual_machine",
      "vm",
    );
    const box = absoluteBoxes(graph).get("vm");
    expect(box?.width).toBe(CARD_WIDTH);
    expect(box?.height).toBe(CARD_HEIGHT);
  });

  it("hands React Flow a position relative to the frame, never under its label", () => {
    const graph = nested();
    const boxes = absoluteBoxes(graph);
    const vnet = graph.nodes.find((n) => n.id === "vnet");
    expect(relativePosition(boxes, vnet!)).toEqual({ x: 40, y: 60 });

    // A node dragged above its frame's origin is kept inside it.
    const above = moveNode(graph, "vnet", { x: -100, y: -100 });
    const inside = relativePosition(
      absoluteBoxes(above),
      above.nodes.find((n) => n.id === "vnet")!,
    );
    expect(inside.x).toBeGreaterThanOrEqual(CONTAINER_PADDING);
    expect(inside.y).toBeGreaterThanOrEqual(CONTAINER_PADDING);
  });

  it("orders parents before children, whatever order they were made in", () => {
    let graph = addNode(emptyBuilderGraph(), "azurerm_subnet", "snet");
    graph = addNode(graph, "azurerm_virtual_network", "vnet");
    graph = addNode(graph, "azurerm_resource_group", "rg");
    graph = reparent(graph, "vnet", "rg");
    graph = reparent(graph, "snet", "vnet");

    expect(byDepth(graph).map((n) => n.id)).toEqual(["rg", "vnet", "snet"]);
  });

  it("finds the innermost frame under a point", () => {
    const graph = nested();
    const boxes = absoluteBoxes(graph);

    // Inside the vnet, which is inside the resource group: the vnet wins.
    expect(containerAt(graph, boxes, { x: 100, y: 120 })).toBe("vnet");
    // Inside the resource group only.
    expect(containerAt(graph, boxes, { x: 10, y: 10 })).toBe("rg");
    // Outside everything.
    expect(containerAt(graph, boxes, { x: 9999, y: 9999 })).toBeUndefined();
    // A node being dragged never counts as its own destination.
    expect(containerAt(graph, boxes, { x: 100, y: 120 }, "vnet")).toBe("rg");
  });

  it("survives a parent cycle rather than hanging on it", () => {
    const graph: BuilderGraph = {
      nodes: [
        {
          id: "a",
          type: "azurerm_resource_group",
          name: "a",
          attributes: {},
          position: { x: 0, y: 0 },
          parentId: "b",
        },
        {
          id: "b",
          type: "azurerm_virtual_network",
          name: "b",
          attributes: {},
          position: { x: 10, y: 10 },
          parentId: "a",
        },
      ],
      references: [],
    };
    expect(absoluteBoxes(graph).size).toBe(2);
    expect(byDepth(graph)).toHaveLength(2);
  });
});
