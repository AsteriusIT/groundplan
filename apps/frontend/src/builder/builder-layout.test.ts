import { describe, expect, it } from "vitest";

import { emptyBuilderGraph, type BuilderGraph } from "@groundplan/builder";

import {
  absoluteBoxes,
  acceptsDrop,
  byDepth,
  cardHeight,
  cardWidth,
  CARD_MIN_WIDTH,
  containerAt,
  CONTAINER_MIN_HEIGHT,
  CONTAINER_MIN_WIDTH,
  CONTAINER_PADDING,
  drawsAsContainer,
  frameLabelWidth,
  relativePosition,
  textWidth,
} from "./builder-layout";
import { addNode, moveNode, renameNode, reparent, setAttribute } from "./builder-ops";

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
  it("draws a frame only around something", () => {
    const graph = nested();
    expect(drawsAsContainer(graph, "rg")).toBe(true);
    // A virtual network with nothing in it yet is still a card — a frame is
    // what a resource becomes when it holds something.
    expect(drawsAsContainer(graph, "vnet")).toBe(false);

    const withVm = addNode(graph, "azurerm_linux_virtual_machine", "vm");
    expect(drawsAsContainer(withVm, "vm")).toBe(false);
  });

  it("takes a drop on the strength of the catalog, not of what it holds", () => {
    let graph = addNode(emptyBuilderGraph(), "azurerm_resource_group", "rg");
    graph = addNode(graph, "azurerm_subnet", "snet");
    // The resource group is empty, and still where a network belongs…
    expect(acceptsDrop(graph, "rg", undefined, "azurerm_virtual_network")).toBe(
      true,
    );
    // …while a subnet is no home for a storage account, empty or not.
    expect(acceptsDrop(graph, "snet", undefined, "azurerm_storage_account")).toBe(
      false,
    );
  });

  it("sizes an empty resource as the card it is drawn as", () => {
    const graph = addNode(emptyBuilderGraph(), "azurerm_resource_group", "rg");
    const box = absoluteBoxes(graph).get("rg");
    expect(box?.width).toBe(CARD_MIN_WIDTH);
    expect(box?.height).toBe(cardHeight(graph, "rg"));
    // A resource group needs nothing, so its card is all head and no rows.
    expect(box?.height).toBeLessThan(CONTAINER_MIN_HEIGHT);
  });

  it("grows a frame around what is in it, without moving it", () => {
    let graph = nested();
    graph = moveNode(graph, "vnet", { x: 400, y: 300 });
    const box = absoluteBoxes(graph).get("rg");

    // The frame's origin is still where the user left it.
    expect(box?.x).toBe(0);
    expect(box?.y).toBe(0);
    // …and it reaches past the vnet's card, with room to spare.
    expect(box?.width).toBe(400 + cardWidth(graph, "vnet") + CONTAINER_PADDING);
    expect(box?.height).toBe(
      300 + cardHeight(graph, "vnet") + CONTAINER_PADDING,
    );
  });

  it("measures a card by the rows it shows", () => {
    let graph = addNode(emptyBuilderGraph(), "azurerm_resource_group", "rg");
    graph = addNode(graph, "azurerm_subnet", "snet");
    // A resource group asks for nothing; a subnet asks for two things.
    expect(cardHeight(graph, "snet")).toBeGreaterThan(cardHeight(graph, "rg"));
    expect(absoluteBoxes(graph).get("snet")?.width).toBe(CARD_MIN_WIDTH);
  });

  it("widens a card around a long name rather than cutting it", () => {
    let graph = addNode(emptyBuilderGraph(), "azurerm_storage_account", "sa");
    expect(cardWidth(graph, "sa")).toBe(CARD_MIN_WIDTH);

    const long = "st-production-westeurope-payments-ledger-01";
    graph = setAttribute(graph, "sa", "name", long);

    // Wide enough for the name itself, with the icon, the padding and the
    // badge's room still on either side of it.
    expect(cardWidth(graph, "sa")).toBeGreaterThan(textWidth(long, 11) + 60);
    expect(absoluteBoxes(graph).get("sa")?.width).toBe(cardWidth(graph, "sa"));

    // The Terraform label is a line of its own, so a long one counts too.
    const labelled = renameNode(
      addNode(emptyBuilderGraph(), "azurerm_storage_account", "sa2"),
      "sa2",
      "storage_for_the_quarterly_settlement_exports",
    );
    expect(cardWidth(labelled, "sa2")).toBeGreaterThan(CARD_MIN_WIDTH);
  });

  it("never draws a frame narrower than the label on its edge", () => {
    let graph = nested();
    graph = setAttribute(
      graph,
      "rg",
      "name",
      "rg-production-westeurope-platform-shared-01",
    );
    const rg = graph.nodes.find((n) => n.id === "rg")!;
    const box = absoluteBoxes(graph).get("rg");

    // The vnet inside is nowhere near the right-hand edge, so without the
    // label the frame would be its minimum — and the label would run off it.
    expect(frameLabelWidth(rg)).toBeGreaterThan(CONTAINER_MIN_WIDTH);
    expect(box?.width).toBe(frameLabelWidth(rg));
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
    expect(containerAt(graph, boxes, { x: 100, y: 120 }, { ignore: "vnet" })).toBe(
      "rg",
    );
    // And a frame that cannot take what is being dragged is not offered: a
    // virtual network is no home for a resource group.
    expect(
      containerAt(
        graph,
        boxes,
        { x: 100, y: 120 },
        { child: "azurerm_resource_group" },
      ),
    ).toBeUndefined();
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
