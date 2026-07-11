import { describe, expect, it } from "vitest";

import type { Graph, GraphEdge, GraphNode } from "@/api/types";
import { HUB_DEGREE_THRESHOLD } from "./hub-config";
import { detectHubs, hubEdgeRevealed, isHubEdge } from "./hub";

function node(id: string, type = "aws_instance"): GraphNode {
  return { id, name: id, type, provider: "aws", module_path: [], change: null };
}
const dep = (from: string, to: string): GraphEdge => ({ from, to, kind: "depends_on" });

describe("detectHubs", () => {
  it("flags a node whose degree exceeds the threshold", () => {
    const leaves = Array.from({ length: HUB_DEGREE_THRESHOLD + 1 }, (_, i) => `leaf${i}`);
    const graph: Graph = {
      version: 1,
      nodes: [node("hub"), ...leaves.map((l) => node(l))],
      edges: leaves.map((l) => dep(l, "hub")),
    };
    expect(detectHubs(graph).has("hub")).toBe(true);
  });

  it("does not flag a node at or below the threshold", () => {
    const leaves = Array.from({ length: HUB_DEGREE_THRESHOLD }, (_, i) => `leaf${i}`);
    const graph: Graph = {
      version: 1,
      nodes: [node("mid"), ...leaves.map((l) => node(l))],
      edges: leaves.map((l) => dep(l, "mid")),
    };
    expect(detectHubs(graph).has("mid")).toBe(false);
  });

  it("flags a known fan-out type regardless of degree", () => {
    const graph: Graph = {
      version: 1,
      nodes: [node("rg", "azurerm_resource_group"), node("vm", "azurerm_linux_virtual_machine")],
      edges: [dep("vm", "rg")],
    };
    const hubs = detectHubs(graph);
    expect(hubs.has("rg")).toBe(true);
    expect(hubs.has("vm")).toBe(false);
  });

  it("never flags module nodes", () => {
    const graph: Graph = {
      version: 1,
      nodes: [{ id: "module.x", name: "x", type: "module", provider: null, module_path: [], change: null }],
      edges: [],
    };
    expect(detectHubs(graph).size).toBe(0);
  });
});

describe("isHubEdge", () => {
  const hubs = new Set(["hub"]);
  it("is true when either endpoint is a hub", () => {
    expect(isHubEdge(dep("a", "hub"), hubs)).toBe(true);
    expect(isHubEdge(dep("hub", "b"), hubs)).toBe(true);
  });
  it("is false between two non-hubs", () => {
    expect(isHubEdge(dep("a", "b"), hubs)).toBe(false);
  });
  it("is false for a contains edge", () => {
    expect(isHubEdge({ from: "hub", to: "a", kind: "contains" }, hubs)).toBe(false);
  });
});

describe("hubEdgeRevealed", () => {
  const edge = dep("vm", "hub");
  it("reveals everything when the toggle is on", () => {
    expect(hubEdgeRevealed(edge, null, true)).toBe(true);
  });
  it("reveals an edge that touches the selected node", () => {
    expect(hubEdgeRevealed(edge, "hub", false)).toBe(true);
    expect(hubEdgeRevealed(edge, "vm", false)).toBe(true);
  });
  it("hides an edge unrelated to the selection", () => {
    expect(hubEdgeRevealed(edge, "other", false)).toBe(false);
    expect(hubEdgeRevealed(edge, null, false)).toBe(false);
  });
});
