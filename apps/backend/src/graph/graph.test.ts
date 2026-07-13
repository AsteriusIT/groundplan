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

test("validateGraph accepts v2..v5 but rejects an unknown version", () => {
  assert.equal(validateGraph({ ...validGraph, version: 2 }).valid, true);
  assert.equal(validateGraph({ ...validGraph, version: 3 }).valid, true);
  assert.equal(validateGraph({ ...validGraph, version: 4 }).valid, true);
  assert.equal(validateGraph({ ...validGraph, version: 5 }).valid, true);
  assert.equal(validateGraph({ ...validGraph, version: 6 }).valid, false);
});

test("validateGraph accepts a v4 graph with parent_id containment", () => {
  const graph = {
    version: 4,
    nodes: [
      {
        id: "azurerm_virtual_network.main",
        name: "main",
        type: "azurerm_virtual_network",
        provider: "azurerm",
        module_path: [],
        change: "create",
      },
      {
        id: "azurerm_subnet.internal",
        name: "internal",
        type: "azurerm_subnet",
        provider: "azurerm",
        module_path: [],
        change: "create",
        parent_id: "azurerm_virtual_network.main",
      },
    ],
    edges: [],
  };
  assert.deepEqual(validateGraph(graph), { valid: true, errors: [] });
});

test("validateGraph rejects a non-string parent_id", () => {
  const bad = {
    version: 4,
    nodes: [
      {
        id: "a",
        name: "a",
        type: "t",
        provider: null,
        module_path: [],
        change: null,
        parent_id: 5,
      },
    ],
    edges: [],
  };
  assert.equal(validateGraph(bad).valid, false);
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
