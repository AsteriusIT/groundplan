import { describe, expect, it } from "vitest";

import type { Graph, GraphNode } from "../types";
import { changedFocusIds, planCamera } from "./camera";

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

const calm: Graph = {
  version: 1,
  nodes: [node("a", null), node("b", null)],
  edges: [],
};

const diff: Graph = {
  version: 3,
  nodes: [
    node("x", "update"),
    node("dep", "noop", true),
    node("rest", "noop"),
    { ...node("module.m", null), type: "module" },
  ],
  edges: [],
};

describe("changedFocusIds", () => {
  it("is the changed ∪ impacted resource set, modules excluded", () => {
    expect(changedFocusIds(diff)).toEqual(["x", "dep"]);
    expect(changedFocusIds(calm)).toEqual([]);
  });
});

describe("planCamera", () => {
  it("the first layout of a view fits the whole graph", () => {
    expect(
      planCamera({ first: true, graph: diff, prevFocusIds: null, prevSelectedId: null }),
    ).toEqual({ kind: "fit-all" });
  });

  it("a refresh that introduces changes frames the blast radius", () => {
    expect(
      planCamera({ first: false, graph: diff, prevFocusIds: [], prevSelectedId: null }),
    ).toEqual({ kind: "fit-changed", ids: ["x", "dep"] });
  });

  it("a refresh with the same change set leaves the camera alone", () => {
    expect(
      planCamera({
        first: false,
        graph: diff,
        prevFocusIds: ["x", "dep"],
        prevSelectedId: null,
      }),
    ).toEqual({ kind: "keep" });
  });

  it("a no-change refresh re-centers on a surviving selection", () => {
    expect(
      planCamera({ first: false, graph: calm, prevFocusIds: [], prevSelectedId: "b" }),
    ).toEqual({ kind: "recenter", id: "b" });
  });

  it("a no-change refresh with no selection keeps the viewport as-is", () => {
    expect(
      planCamera({ first: false, graph: calm, prevFocusIds: [], prevSelectedId: null }),
    ).toEqual({ kind: "keep" });
  });

  it("a deleted selection falls back to the blast radius, never to origin", () => {
    expect(
      planCamera({
        first: false,
        graph: diff,
        prevFocusIds: [],
        prevSelectedId: "gone-from-graph",
      }),
    ).toEqual({ kind: "fit-changed", ids: ["x", "dep"] });
  });

  it("a deleted selection with no changes at all keeps the viewport", () => {
    expect(
      planCamera({
        first: false,
        graph: calm,
        prevFocusIds: [],
        prevSelectedId: "gone-from-graph",
      }),
    ).toEqual({ kind: "keep" });
  });

  it("set comparison ignores order — a reshuffle is not a new change set", () => {
    expect(
      planCamera({
        first: false,
        graph: diff,
        prevFocusIds: ["dep", "x"],
        prevSelectedId: null,
      }),
    ).toEqual({ kind: "keep" });
  });
});
