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
