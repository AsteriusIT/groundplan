import { describe, expect, it } from "vitest";

import type { Graph, GraphNode } from "../types";
import { changedFocusIds, isNodeOnScreen, planCamera } from "./camera";

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

// --- is a node already on screen? -----------------------------------------

// A 800x600 viewport at 1:1, panned to the origin.
const VIEWPORT = { x: 0, y: 0, zoom: 1 };
const SIZE = { width: 800, height: 600 };

describe("isNodeOnScreen", () => {
  it("sees a node sitting in the middle of the view", () => {
    expect(
      isNodeOnScreen({ x: 300, y: 200, width: 200, height: 56 }, VIEWPORT, SIZE),
    ).toBe(true);
  });

  it("does not see a node panned off to the right", () => {
    expect(
      isNodeOnScreen({ x: 2000, y: 200, width: 200, height: 56 }, VIEWPORT, SIZE),
    ).toBe(false);
  });

  it("does not see a node above the view", () => {
    expect(
      isNodeOnScreen({ x: 100, y: -400, width: 200, height: 56 }, VIEWPORT, SIZE),
    ).toBe(false);
  });

  it("follows the pan", () => {
    // The same node, with the canvas panned so that it comes into view.
    const box = { x: 2000, y: 200, width: 200, height: 56 };

    expect(isNodeOnScreen(box, { x: -1900, y: 0, zoom: 1 }, SIZE)).toBe(true);
  });

  it("follows the zoom", () => {
    // Zoomed out, more of the graph fits — a node that was off screen at 1:1
    // is on screen at 0.25.
    const box = { x: 2000, y: 200, width: 200, height: 56 };

    expect(isNodeOnScreen(box, { x: 0, y: 0, zoom: 0.25 }, SIZE)).toBe(true);
  });

  it("counts a node only half in view as on screen", () => {
    // It is visible. Recentring on something the reader can already see is
    // exactly the camera movement that makes panning feel broken.
    expect(
      isNodeOnScreen({ x: 700, y: 200, width: 200, height: 56 }, VIEWPORT, SIZE),
    ).toBe(true);
  });

  it("treats a node touching the edge from outside as off screen", () => {
    expect(
      isNodeOnScreen({ x: 800, y: 200, width: 200, height: 56 }, VIEWPORT, SIZE),
    ).toBe(false);
  });

  it("cannot answer without a measured viewport", () => {
    // Before the first layout the container has no size. Saying "on screen"
    // there would silently disable revealing altogether.
    expect(
      isNodeOnScreen({ x: 0, y: 0, width: 200, height: 56 }, VIEWPORT, {
        width: 0,
        height: 0,
      }),
    ).toBe(false);
  });
});
