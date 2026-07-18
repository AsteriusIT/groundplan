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

test("validateGraph accepts v2..v8 but rejects an unknown version", () => {
  assert.equal(validateGraph({ ...validGraph, version: 2 }).valid, true);
  assert.equal(validateGraph({ ...validGraph, version: 3 }).valid, true);
  assert.equal(validateGraph({ ...validGraph, version: 4 }).valid, true);
  assert.equal(validateGraph({ ...validGraph, version: 5 }).valid, true);
  // v6 (GP-96) adds node labels. Every bump is additive, so v1 stays valid too.
  assert.equal(validateGraph({ ...validGraph, version: 6 }).valid, true);
  // v7 (GP-102) adds node attributes — what a Kubernetes graph is diffed by.
  assert.equal(validateGraph({ ...validGraph, version: 7 }).valid, true);
  // v8 (GP-120) adds the HCL source snippet a docs node was defined by.
  assert.equal(validateGraph({ ...validGraph, version: 8 }).valid, true);
  assert.equal(validateGraph({ ...validGraph, version: 9 }).valid, false);
});

test("validateGraph accepts a v8 node source, and rejects a malformed one", () => {
  const sourced = {
    version: 8,
    nodes: [
      {
        id: "azurerm_resource_group.main",
        name: "main",
        type: "azurerm_resource_group",
        provider: "azurerm",
        module_path: [],
        change: null,
        source: {
          file: "modules/network/main.tf",
          start_line: 12,
          end_line: 34,
          code: 'resource "azurerm_resource_group" "main" {\n  name = "rg"\n}',
        },
      },
    ],
    edges: [],
  };
  assert.equal(validateGraph(sourced).valid, true);

  // A line span must be a whole line number: a 0 or a float is a parser bug, not
  // a snippet, and storing it would put a nonsense range in the panel header.
  const zeroLine = {
    ...sourced,
    nodes: [{ ...sourced.nodes[0], source: { ...sourced.nodes[0]!.source, start_line: 0 } }],
  };
  assert.equal(validateGraph(zeroLine).valid, false);

  const missingCode = {
    ...sourced,
    nodes: [
      {
        ...sourced.nodes[0],
        source: { file: "main.tf", start_line: 1, end_line: 2 },
      },
    ],
  };
  assert.equal(validateGraph(missingCode).valid, false);
});

test("validateGraph accepts v6 node labels, and rejects non-string values", () => {
  const labelled = {
    version: 6,
    nodes: [
      {
        id: "Deployment/api",
        name: "api",
        type: "Deployment",
        provider: "kubernetes",
        module_path: [],
        change: null,
        labels: { app: "api" },
      },
    ],
    edges: [],
  };
  assert.equal(validateGraph(labelled).valid, true);

  const bad = {
    ...labelled,
    nodes: [{ ...labelled.nodes[0], labels: { replicas: 3 } }],
  };
  assert.equal(validateGraph(bad).valid, false);
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
