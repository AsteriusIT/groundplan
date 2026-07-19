import { describe, expect, it } from "vitest";

import type { Graph, GraphNode } from "../types";
import { edgeGhosted, emphasisMap } from "./emphasis";

function node(id: string, change: GraphNode["change"], impacted = false): GraphNode {
  return {
    id,
    name: id,
    type: "t",
    provider: "p",
    module_path: [],
    change,
    ...(impacted ? { impacted: true, impact_distance: 1 } : {}),
  };
}

const dep = (from: string, to: string) =>
  ({ from, to, kind: "depends_on" as const, inferred: true });

// changed <- impacted <- context <- far (ghost)     lonely (ghost)
const graph: Graph = {
  version: 3,
  nodes: [
    node("changed", "update"),
    node("hit", "noop", true),
    node("near", "noop"),
    node("far", "noop"),
    node("lonely", "noop"),
  ],
  edges: [dep("hit", "changed"), dep("near", "hit"), dep("far", "near")],
};

describe("emphasisMap", () => {
  it("tiers nodes: changed, impacted, one-hop context, ghost", () => {
    const map = emphasisMap(graph, true);
    expect(map?.get("changed")).toBe("changed");
    expect(map?.get("hit")).toBe("impacted");
    expect(map?.get("near")).toBe("context");
    expect(map?.get("far")).toBe("ghost");
    expect(map?.get("lonely")).toBe("ghost");
  });

  it("is null when inactive — HEAD/MAIN views render untouched", () => {
    expect(emphasisMap(graph, false)).toBeNull();
  });

  it("is null when nothing changed — an all-noop diff must not dim the estate", () => {
    const calm: Graph = {
      version: 3,
      nodes: [node("a", "noop"), node("b", "noop")],
      edges: [dep("a", "b")],
    };
    expect(emphasisMap(calm, true)).toBeNull();
  });

  it("is null for a docs graph with no change data at all", () => {
    const docs: Graph = {
      version: 1,
      nodes: [node("a", null), node("b", null)],
      edges: [dep("a", "b")],
    };
    expect(emphasisMap(docs, true)).toBeNull();
  });

  it("module containers carry no emphasis — structure never ghosts", () => {
    const withModule: Graph = {
      version: 3,
      nodes: [
        { ...node("module.m", null), type: "module" },
        node("changed", "create"),
      ],
      edges: [{ from: "module.m", to: "changed", kind: "contains" }],
    };
    const map = emphasisMap(withModule, true);
    expect(map?.has("module.m")).toBe(false);
    expect(map?.get("changed")).toBe("changed");
  });

  it("ghost deletes count as changed (they are the review)", () => {
    const withDelete: Graph = {
      version: 3,
      nodes: [node("gone", "delete"), node("stays", "noop")],
      edges: [],
    };
    expect(emphasisMap(withDelete, true)?.get("gone")).toBe("changed");
  });
});

describe("edgeGhosted", () => {
  const map = emphasisMap(graph, true);

  it("keeps full contrast when an endpoint is changed or impacted", () => {
    expect(edgeGhosted(dep("hit", "changed"), map)).toBe(false);
    expect(edgeGhosted(dep("near", "hit"), map)).toBe(false);
  });

  it("recedes when both endpoints are context or ghost", () => {
    expect(edgeGhosted(dep("far", "near"), map)).toBe(true);
  });

  it("never ghosts without an active map", () => {
    expect(edgeGhosted(dep("far", "near"), null)).toBe(false);
  });
});
