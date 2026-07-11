import { test } from "node:test";
import assert from "node:assert/strict";

import { computeGraphStats, validateGraph, type Graph } from "./graph.js";

const validGraph: Graph = {
  version: 1,
  nodes: [
    {
      id: "aws_s3_bucket.a",
      name: "a",
      type: "aws_s3_bucket",
      provider: "aws",
      module_path: [],
      change: "create",
    },
    {
      id: "module.net",
      name: "net",
      type: "module",
      provider: null,
      module_path: [],
      change: null,
    },
    {
      id: "module.net.aws_vpc.main",
      name: "main",
      type: "aws_vpc",
      provider: "aws",
      module_path: ["net"],
      change: "update",
    },
  ],
  edges: [
    { from: "module.net", to: "module.net.aws_vpc.main", kind: "contains" },
    { from: "aws_s3_bucket.a", to: "module.net.aws_vpc.main", kind: "depends_on" },
  ],
};

test("validateGraph accepts a well-formed graph", () => {
  const res = validateGraph(validGraph);
  assert.equal(res.valid, true);
  assert.deepEqual(res.errors, []);
});

test("validateGraph rejects an unknown change value", () => {
  const bad = {
    ...validGraph,
    nodes: [{ ...validGraph.nodes[0], change: "explode" }],
  };
  const res = validateGraph(bad);
  assert.equal(res.valid, false);
  assert.ok(res.errors.length > 0, "expected at least one error message");
});

test("validateGraph rejects a node missing required fields", () => {
  const bad = { version: 1, nodes: [{ id: "x" }], edges: [] };
  const res = validateGraph(bad);
  assert.equal(res.valid, false);
});

test("validateGraph rejects an edge with an unknown kind", () => {
  const bad = { ...validGraph, edges: [{ from: "a", to: "b", kind: "references" }] };
  const res = validateGraph(bad);
  assert.equal(res.valid, false);
});

test("validateGraph rejects the wrong version", () => {
  const res = validateGraph({ ...validGraph, version: 2 });
  assert.equal(res.valid, false);
});

test("computeGraphStats counts nodes, edges and changes", () => {
  const stats = computeGraphStats(validGraph);
  assert.equal(stats.nodes, 3);
  assert.equal(stats.edges, 2);
  assert.deepEqual(stats.changes, {
    create: 1,
    update: 1,
    delete: 0,
    noop: 0,
    unchanged: 1,
  });
});
