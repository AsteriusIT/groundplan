import { test } from "node:test";
import assert from "node:assert/strict";

import type { Graph, GraphNode } from "@groundplan/graph-parser";

import { changedOnly } from "./changed-only.js";

function node(id: string, change: GraphNode["change"]): GraphNode {
  return { id, name: id, type: "t", provider: "p", module_path: [], change };
}

const dep = (from: string, to: string) =>
  ({ from, to, kind: "depends_on" as const, inferred: true });
const contains = (from: string, to: string) =>
  ({ from, to, kind: "contains" as const });

test("keeps changed nodes plus one-hop neighbors; drops the far noop tail", () => {
  // changed <- near (noop, 1 hop) <- far (noop, 2 hops)   lonely (noop)
  const graph: Graph = {
    version: 3,
    nodes: [
      node("changed", "update"),
      node("near", "noop"),
      node("far", "noop"),
      node("lonely", "noop"),
    ],
    edges: [dep("near", "changed"), dep("far", "near")],
  };
  const out = changedOnly(graph);
  assert.deepEqual(
    out.nodes.map((n) => n.id),
    ["changed", "near"],
  );
  assert.deepEqual(out.edges, [dep("near", "changed")]);
});

test("neighbors count in both directions and through contains edges", () => {
  const graph: Graph = {
    version: 3,
    nodes: [
      node("module.m", "noop"),
      node("created", "create"),
      node("downstream", "noop"),
    ],
    edges: [contains("module.m", "created"), dep("created", "downstream")],
  };
  const out = changedOnly(graph);
  assert.deepEqual(
    out.nodes.map((n) => n.id).sort(),
    ["created", "downstream", "module.m"],
  );
});

test("ghost deletes are changed nodes and keep their context", () => {
  const graph: Graph = {
    version: 3,
    nodes: [node("ghost", "delete"), node("user", "noop"), node("unrelated", "noop")],
    edges: [dep("user", "ghost")],
  };
  const out = changedOnly(graph);
  assert.deepEqual(
    out.nodes.map((n) => n.id).sort(),
    ["ghost", "user"],
  );
});

test("an all-noop graph filters to nothing", () => {
  const graph: Graph = {
    version: 3,
    nodes: [node("a", "noop"), node("b", "noop")],
    edges: [dep("a", "b")],
  };
  const out = changedOnly(graph);
  assert.deepEqual(out.nodes, []);
  assert.deepEqual(out.edges, []);
  assert.equal(out.version, 3);
});
