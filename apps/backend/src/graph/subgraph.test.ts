import assert from "node:assert/strict";
import { test } from "node:test";

import type { Graph } from "./graph.js";
import { changesSubgraph } from "./subgraph.js";

const GRAPH: Graph = {
  version: 2,
  nodes: [
    { id: "module.net", name: "net", type: "module", provider: null, module_path: [], change: null },
    { id: "vnet.this", name: "this", type: "azurerm_virtual_network", provider: "azurerm", module_path: ["net"], change: "create" },
    { id: "subnet.a", name: "a", type: "azurerm_subnet", provider: "azurerm", module_path: ["net"], change: "noop" },
    { id: "lb.main", name: "main", type: "azurerm_lb", provider: "azurerm", module_path: [], change: "noop", impacted: true, impact_distance: 1 },
    { id: "s3.untouched", name: "untouched", type: "aws_s3_bucket", provider: "aws", module_path: [], change: "noop" },
  ],
  edges: [
    { from: "module.net", to: "vnet.this", kind: "contains" },
    { from: "module.net", to: "subnet.a", kind: "contains" },
    { from: "subnet.a", to: "vnet.this", kind: "depends_on" },
    { from: "lb.main", to: "subnet.a", kind: "depends_on" },
  ],
};

test("changesSubgraph keeps changed + impacted nodes and their 1-hop neighbours", () => {
  const sub = changesSubgraph(GRAPH);
  const ids = new Set(sub.nodes.map((n) => n.id));
  // vnet.this is created, lb.main is impacted — both kept.
  assert.ok(ids.has("vnet.this"));
  assert.ok(ids.has("lb.main"));
  // subnet.a is unchanged but a 1-hop neighbour of both → kept.
  assert.ok(ids.has("subnet.a"));
});

test("changesSubgraph drops unrelated unchanged nodes", () => {
  const sub = changesSubgraph(GRAPH);
  assert.ok(!sub.nodes.some((n) => n.id === "s3.untouched"));
});

test("changesSubgraph pulls in module containers of kept resources", () => {
  const sub = changesSubgraph(GRAPH);
  assert.ok(sub.nodes.some((n) => n.id === "module.net"));
});

test("changesSubgraph only keeps edges with both endpoints present", () => {
  const sub = changesSubgraph(GRAPH);
  for (const edge of sub.edges) {
    const ids = new Set(sub.nodes.map((n) => n.id));
    assert.ok(ids.has(edge.from) && ids.has(edge.to));
  }
});

test("an all-unchanged docs graph yields an empty change set", () => {
  const docs: Graph = {
    version: 1,
    nodes: [
      { id: "s3.a", name: "a", type: "aws_s3_bucket", provider: "aws", module_path: [], change: null },
    ],
    edges: [],
  };
  assert.equal(changesSubgraph(docs).nodes.length, 0);
});
