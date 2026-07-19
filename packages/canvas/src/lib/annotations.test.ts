import { describe, expect, it } from "vitest";

import type { Annotation } from "../types";
import {
  absoluteNodeBoxes,
  annotationLinkEdges,
  groupFrames,
  hiddenNodeIds,
  notedNodeIds,
  notesForNode,
  orphanedAnnotations,
  reanchor,
  renamedLabels,
  renderableAnnotations,
} from "./annotations";

function ann(partial: Partial<Annotation> & Pick<Annotation, "type" | "anchors">): Annotation {
  return {
    id: partial.id ?? Math.random().toString(36).slice(2),
    repositoryId: "r",
    label: null,
    body: null,
    status: "resolved",
    provenance: "human",
    reason: null,
    createdFromSha: null,
    parentGroupId: null,
    missingAnchors: [],
    createdBy: null,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...partial,
  };
}

describe("renderableAnnotations", () => {
  it("keeps only annotations whose every anchor exists in the graph", () => {
    const present = ann({ id: "ok", type: "link", anchors: ["a", "b"] });
    const orphan = ann({ id: "gone", type: "note", anchors: ["missing"] });
    const result = renderableAnnotations([present, orphan], new Set(["a", "b"]));
    expect(result.map((a) => a.id)).toEqual(["ok"]);
  });

  it("never draws a proposal — it belongs in the review inbox, not the diagram", () => {
    const proposed = ann({
      id: "p",
      type: "group",
      anchors: ["a"],
      label: "Suggested",
      status: "proposed",
      provenance: "ai",
    });
    const accepted = ann({ id: "ok", type: "group", anchors: ["a"], label: "Mine" });
    const result = renderableAnnotations([proposed, accepted], new Set(["a"]));
    expect(result.map((a) => a.id)).toEqual(["ok"]);
  });

  it("a logical edge anchored to a live group is renderable (the anchor is not an address)", () => {
    const group = ann({ id: "g1", type: "group", anchors: ["a"], label: "Front" });
    const edge = ann({ id: "e1", type: "link", anchors: ["g1", "b"] });
    const result = renderableAnnotations([group, edge], new Set(["a", "b"]));
    expect(result.map((a) => a.id).sort()).toEqual(["e1", "g1"]);
  });

  it("a logical edge into a group with no members left is not renderable", () => {
    const group = ann({ id: "g1", type: "group", anchors: ["gone"], label: "Front" });
    const edge = ann({ id: "e1", type: "link", anchors: ["g1", "b"] });
    const result = renderableAnnotations([group, edge], new Set(["b"]));
    expect(result).toEqual([]);
  });
});

describe("hiddenNodeIds / renamedLabels", () => {
  it("collects what the adapted view will drop and re-label", () => {
    const annotations = [
      ann({ type: "hide", anchors: ["a"] }),
      ann({ type: "hide", anchors: ["b"], status: "proposed" }), // not accepted
      ann({ type: "rename", anchors: ["c"], label: "Order ledger" }),
    ];
    expect([...hiddenNodeIds(annotations)]).toEqual(["a"]);
    expect(renamedLabels(annotations).get("c")).toBe("Order ledger");
  });
});

describe("notesForNode", () => {
  it("returns notes anchored to the node, ignoring links and groups", () => {
    const note = ann({ id: "n", type: "note", anchors: ["a"], body: "hi" });
    const other = ann({ id: "n2", type: "note", anchors: ["b"] });
    const link = ann({ id: "l", type: "link", anchors: ["a", "b"] });
    expect(notesForNode([note, other, link], "a").map((a) => a.id)).toEqual(["n"]);
  });
});

describe("orphanedAnnotations", () => {
  it("returns annotations with any missing anchor, computed against the graph", () => {
    const note = ann({ id: "n", type: "note", anchors: ["gone"] });
    const link = ann({ id: "l", type: "link", anchors: ["a", "vanished"] });
    const ok = ann({ id: "ok", type: "note", anchors: ["a"] });
    const orphans = orphanedAnnotations([note, link, ok], new Set(["a"]));
    expect(orphans).toEqual([
      { annotation: note, missing: ["gone"] },
      { annotation: link, missing: ["vanished"] },
    ]);
  });
});

describe("reanchor", () => {
  it("replaces the missing anchor with the chosen address", () => {
    expect(reanchor(["a", "gone"], "gone", "renamed")).toEqual(["a", "renamed"]);
  });
  it("leaves other anchors untouched", () => {
    expect(reanchor(["gone"], "gone", "x")).toEqual(["x"]);
    expect(reanchor(["a", "b"], "missing", "x")).toEqual(["a", "b"]);
  });
});

describe("notedNodeIds", () => {
  it("collects the anchor of every note", () => {
    const a = ann({ id: "n1", type: "note", anchors: ["a"] });
    const b = ann({ id: "n2", type: "note", anchors: ["b"] });
    const link = ann({ id: "l", type: "link", anchors: ["a", "c"] });
    expect(notedNodeIds([a, b, link])).toEqual(new Set(["a", "b"]));
  });
});

describe("annotationLinkEdges", () => {
  it("maps link annotations to labeled source→target edge descriptors", () => {
    const link = ann({ id: "l1", type: "link", anchors: ["a", "b"], label: "reads" });
    const note = ann({ id: "n", type: "note", anchors: ["a"] });
    expect(annotationLinkEdges([link, note])).toEqual([
      { id: "l1", source: "a", target: "b", label: "reads" },
    ]);
  });
});

describe("absoluteNodeBoxes", () => {
  it("returns positions unchanged for flat nodes", () => {
    const boxes = absoluteNodeBoxes([
      { id: "a", position: { x: 10, y: 20 }, style: { width: 100, height: 40 } },
    ]);
    expect(boxes.get("a")).toEqual({ x: 10, y: 20, width: 100, height: 40 });
  });

  it("resolves a child's absolute position through its parent", () => {
    const boxes = absoluteNodeBoxes([
      { id: "mod", position: { x: 100, y: 100 }, style: { width: 400, height: 300 } },
      { id: "child", parentId: "mod", position: { x: 20, y: 30 }, style: { width: 50, height: 20 } },
    ]);
    expect(boxes.get("child")).toEqual({ x: 120, y: 130, width: 50, height: 20 });
  });
});

describe("groupFrames", () => {
  const positions = new Map([
    ["a", { x: 0, y: 0, width: 100, height: 40 }],
    ["b", { x: 200, y: 100, width: 100, height: 40 }],
  ]);

  it("computes a padded bounding box around a group's members", () => {
    const group = ann({ id: "g", type: "group", anchors: ["a", "b"], label: "lake" });
    const [frame] = groupFrames([group], positions);
    // Bounding box is (0,0)-(300,140); padded outward by 24 on every side.
    expect(frame).toEqual({
      id: "g",
      label: "lake",
      x: -24,
      y: -24,
      width: 300 + 48,
      height: 140 + 48,
    });
  });

  it("ignores members with no known position and skips empty groups", () => {
    const group = ann({ id: "g", type: "group", anchors: ["a", "ghost"], label: "x" });
    const [frame] = groupFrames([group], positions);
    expect(frame?.width).toBe(100 + 48); // only "a" contributes
    const empty = ann({ id: "e", type: "group", anchors: ["ghost", "phantom"], label: "y" });
    expect(groupFrames([empty], positions)).toEqual([]);
  });
});
