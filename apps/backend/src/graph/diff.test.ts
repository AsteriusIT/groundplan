import assert from "node:assert/strict";
import { test } from "node:test";

import type { Graph, GraphNode } from "./graph.js";
import { diffGraphs } from "./diff.js";

function res(id: string, type: string, name: string, modulePath: string[] = []): GraphNode {
  return { id, name, type, provider: "azurerm", module_path: modulePath, change: null };
}

function graph(nodes: GraphNode[]): Graph {
  return { version: 1, nodes, edges: [] };
}

test("reports added and removed resources by address", () => {
  const base = graph([
    res("azurerm_subnet.a", "azurerm_subnet", "a"),
    res("azurerm_subnet.b", "azurerm_subnet", "b"),
  ]);
  const target = graph([
    res("azurerm_subnet.a", "azurerm_subnet", "a"),
    res("azurerm_subnet.c", "azurerm_subnet", "c"),
  ]);
  const diff = diffGraphs(base, target);
  assert.deepEqual(diff.added.map((n) => n.id), ["azurerm_subnet.c"]);
  assert.deepEqual(diff.removed.map((n) => n.id), ["azurerm_subnet.b"]);
  assert.equal(diff.unchangedCount, 1);
  assert.equal(diff.moved.length, 0);
});

test("identical snapshots produce no differences", () => {
  const g = graph([res("azurerm_subnet.a", "azurerm_subnet", "a")]);
  const diff = diffGraphs(g, g);
  assert.equal(diff.added.length, 0);
  assert.equal(diff.removed.length, 0);
  assert.equal(diff.moved.length, 0);
  assert.equal(diff.unchangedCount, 1);
});

test("a same-address resource in a new module is reported as moved, not add+remove", () => {
  const base = graph([
    res("azurerm_subnet.a", "azurerm_subnet", "a", []),
  ]);
  const target = graph([
    res("module.net.azurerm_subnet.a", "azurerm_subnet", "a", ["net"]),
  ]);
  const diff = diffGraphs(base, target);
  assert.equal(diff.added.length, 0);
  assert.equal(diff.removed.length, 0);
  assert.equal(diff.moved.length, 1);
  assert.deepEqual(diff.moved[0]!.from_module_path, []);
  assert.deepEqual(diff.moved[0]!.to_module_path, ["net"]);
});

test("modules are ignored (structural, not resources)", () => {
  const base = graph([
    { id: "module.net", name: "net", type: "module", provider: null, module_path: [], change: null },
    res("azurerm_subnet.a", "azurerm_subnet", "a", ["net"]),
  ]);
  const target = graph([res("azurerm_subnet.a", "azurerm_subnet", "a", ["net"])]);
  const diff = diffGraphs(base, target);
  assert.equal(diff.added.length, 0);
  assert.equal(diff.removed.length, 0);
  assert.equal(diff.unchangedCount, 1);
});

test("output lists are sorted by id for determinism", () => {
  const base = graph([]);
  const target = graph([
    res("azurerm_subnet.z", "azurerm_subnet", "z"),
    res("azurerm_subnet.a", "azurerm_subnet", "a"),
  ]);
  const diff = diffGraphs(base, target);
  assert.deepEqual(diff.added.map((n) => n.id), ["azurerm_subnet.a", "azurerm_subnet.z"]);
});
