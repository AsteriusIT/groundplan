import { test } from "node:test";
import assert from "node:assert/strict";

import { reconcileAnnotations } from "./annotation-reconcile.js";
import type { Graph } from "../graph/graph.js";

function graph(nodeIds: string[]): Graph {
  return {
    version: 1,
    nodes: nodeIds.map((id) => ({
      id,
      name: id.split(".").pop() ?? id,
      type: "aws_s3_bucket",
      provider: "aws",
      module_path: [],
      change: null,
    })),
    edges: [],
  };
}

test("all anchors present -> resolved with no missing", () => {
  const [result] = reconcileAnnotations(
    [{ id: "a1", anchors: ["aws_s3_bucket.a", "aws_s3_bucket.b"] }],
    graph(["aws_s3_bucket.a", "aws_s3_bucket.b"]),
  );
  assert.equal(result?.status, "resolved");
  assert.deepEqual(result?.missingAnchors, []);
});

test("any missing anchor -> orphaned, recording exactly which are missing", () => {
  const [result] = reconcileAnnotations(
    [{ id: "a1", anchors: ["aws_s3_bucket.a", "aws_s3_bucket.gone"] }],
    graph(["aws_s3_bucket.a"]),
  );
  assert.equal(result?.status, "orphaned");
  assert.deepEqual(result?.missingAnchors, ["aws_s3_bucket.gone"]);
});

test("a group keeps its resolved members but is orphaned while any are missing", () => {
  const [result] = reconcileAnnotations(
    [{ id: "g1", anchors: ["aws_s3_bucket.a", "aws_s3_bucket.b", "aws_s3_bucket.gone"] }],
    graph(["aws_s3_bucket.a", "aws_s3_bucket.b"]),
  );
  assert.equal(result?.status, "orphaned");
  assert.deepEqual(result?.missingAnchors, ["aws_s3_bucket.gone"]);
});

test("reconciles many annotations independently, keyed by id", () => {
  const results = reconcileAnnotations(
    [
      { id: "resolved", anchors: ["aws_s3_bucket.a"] },
      { id: "orphaned", anchors: ["aws_s3_bucket.missing"] },
    ],
    graph(["aws_s3_bucket.a"]),
  );
  assert.deepEqual(
    results,
    [
      { id: "resolved", status: "resolved", missingAnchors: [] },
      { id: "orphaned", status: "orphaned", missingAnchors: ["aws_s3_bucket.missing"] },
    ],
  );
});

test("empty annotation set reconciles to an empty result", () => {
  assert.deepEqual(reconcileAnnotations([], graph(["aws_s3_bucket.a"])), []);
});

// --- GP-71: group-anchored logical edges, and proposals ----------------------

const GROUP_ID = "11111111-1111-4111-8111-111111111111";
const OTHER_GROUP_ID = "22222222-2222-4222-8222-222222222222";

test("a logical edge anchored to a live group resolves", () => {
  const results = reconcileAnnotations(
    [
      { id: GROUP_ID, type: "group", anchors: ["aws_s3_bucket.a"] },
      { id: "e1", type: "link", anchors: [GROUP_ID, "aws_s3_bucket.b"] },
    ],
    graph(["aws_s3_bucket.a", "aws_s3_bucket.b"]),
  );
  assert.equal(results.find((r) => r.id === "e1")?.status, "resolved");
});

test("a logical edge anchored to an orphaned group is itself orphaned", () => {
  const results = reconcileAnnotations(
    [
      // The group's only member is gone, so the group orphans...
      { id: GROUP_ID, type: "group", anchors: ["aws_s3_bucket.gone"] },
      // ...and the edge that points at the group has nothing to attach to.
      { id: "e1", type: "link", anchors: [GROUP_ID, "aws_s3_bucket.b"] },
    ],
    graph(["aws_s3_bucket.b"]),
  );
  const edge = results.find((r) => r.id === "e1");
  assert.equal(edge?.status, "orphaned");
  assert.deepEqual(edge?.missingAnchors, [GROUP_ID]);
});

test("a logical edge anchored to a group that does not exist is orphaned", () => {
  const [result] = reconcileAnnotations(
    [{ id: "e1", type: "link", anchors: [OTHER_GROUP_ID, "aws_s3_bucket.b"] }],
    graph(["aws_s3_bucket.b"]),
  );
  assert.equal(result?.status, "orphaned");
  assert.deepEqual(result?.missingAnchors, [OTHER_GROUP_ID]);
});

test("a proposal is never reconciled into an accepted annotation", () => {
  // The whole point: no code path may promote an AI proposal without a human
  // PATCH. Even a proposal whose anchors all resolve stays `proposed`.
  const results = reconcileAnnotations(
    [{ id: "p1", type: "group", status: "proposed", anchors: ["aws_s3_bucket.a"] }],
    graph(["aws_s3_bucket.a"]),
  );
  assert.deepEqual(results, []);
});

test("an orphaned annotation flips back to resolved when its address reappears", () => {
  const items = [
    { id: "a1", type: "note" as const, status: "orphaned" as const, anchors: ["aws_s3_bucket.a"] },
  ];
  assert.equal(reconcileAnnotations(items, graph([]))[0]?.status, "orphaned");
  assert.equal(
    reconcileAnnotations(items, graph(["aws_s3_bucket.a"]))[0]?.status,
    "resolved",
  );
});

test("reconciliation is deterministic — same inputs, same result", () => {
  const items = [
    { id: GROUP_ID, type: "group" as const, anchors: ["aws_s3_bucket.a"] },
    { id: "e1", type: "link" as const, anchors: [GROUP_ID, "aws_s3_bucket.gone"] },
    { id: "n1", type: "note" as const, anchors: ["aws_s3_bucket.a"] },
  ];
  const g = graph(["aws_s3_bucket.a"]);
  assert.deepEqual(reconcileAnnotations(items, g), reconcileAnnotations(items, g));
});
