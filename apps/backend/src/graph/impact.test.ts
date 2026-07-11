import { test } from "node:test";
import assert from "node:assert/strict";

import {
  computeGraphStats,
  type Graph,
  type GraphEdge,
  type GraphNode,
} from "./graph.js";
import { propagateImpact } from "./impact.js";

function node(id: string, change: GraphNode["change"]): GraphNode {
  return { id, name: id, type: "t", provider: "p", module_path: [], change };
}

function dep(from: string, to: string) {
  return { from, to, kind: "depends_on" as const, inferred: true };
}

test("marks direct and transitive noop dependents with their distance", () => {
  // subnet (update) <- nic <- vm  (nic/vm are noop and depend on the subnet)
  const graph: Graph = {
    version: 1,
    nodes: [node("subnet", "update"), node("nic", "noop"), node("vm", "noop")],
    edges: [dep("nic", "subnet"), dep("vm", "nic")],
  };
  const out = propagateImpact(graph);
  const byId = new Map(out.nodes.map((n) => [n.id, n]));
  assert.equal(out.version, 2);
  assert.deepEqual(
    { impacted: byId.get("nic")?.impacted, d: byId.get("nic")?.impact_distance },
    { impacted: true, d: 1 },
  );
  assert.deepEqual(
    { impacted: byId.get("vm")?.impacted, d: byId.get("vm")?.impact_distance },
    { impacted: true, d: 2 },
  );
  // The changed seed is never marked impacted.
  assert.equal(byId.get("subnet")?.impacted, undefined);
});

test("unrelated noop nodes are not impacted", () => {
  const graph: Graph = {
    version: 1,
    nodes: [node("a", "create"), node("b", "noop"), node("lonely", "noop")],
    edges: [dep("b", "a")],
  };
  const out = propagateImpact(graph);
  const byId = new Map(out.nodes.map((n) => [n.id, n]));
  assert.equal(byId.get("b")?.impacted, true);
  assert.equal(byId.get("lonely")?.impacted, undefined);
});

test("a dependency that is NOT changed does not impact its dependents", () => {
  const graph: Graph = {
    version: 1,
    nodes: [node("x", "noop"), node("y", "noop")],
    edges: [dep("y", "x")],
  };
  const out = propagateImpact(graph);
  assert.ok(out.nodes.every((n) => n.impacted === undefined));
});

test("cycles in the dependency graph don't hang the traversal", () => {
  const graph: Graph = {
    version: 1,
    nodes: [node("a", "update"), node("b", "noop"), node("c", "noop")],
    // b -> c -> b cycle, both depending (transitively) on changed a via b -> a
    edges: [dep("b", "a"), dep("b", "c"), dep("c", "b")],
  };
  const out = propagateImpact(graph);
  const byId = new Map(out.nodes.map((n) => [n.id, n]));
  assert.equal(byId.get("b")?.impacted, true);
  assert.equal(byId.get("c")?.impacted, true);
});

test("stats.impactedCount reflects the marked nodes", () => {
  const graph: Graph = {
    version: 1,
    nodes: [node("s", "delete"), node("d1", "noop"), node("d2", "noop")],
    edges: [dep("d1", "s"), dep("d2", "d1")],
  };
  const out = propagateImpact(graph);
  assert.equal(computeGraphStats(out).impactedCount, 2);
});

test("propagation on a 500-node chain completes in well under 100ms", () => {
  const nodes: GraphNode[] = [node("root", "update")];
  const edges: GraphEdge[] = [];
  for (let i = 0; i < 500; i++) {
    nodes.push(node(`n${i}`, "noop"));
    edges.push(dep(`n${i}`, i === 0 ? "root" : `n${i - 1}`));
  }
  const graph: Graph = { version: 1, nodes, edges };
  const start = process.hrtime.bigint();
  const out = propagateImpact(graph);
  const ms = Number(process.hrtime.bigint() - start) / 1e6;
  assert.equal(computeGraphStats(out).impactedCount, 500);
  assert.ok(ms < 100, `expected < 100ms, took ${ms.toFixed(1)}ms`);
});
