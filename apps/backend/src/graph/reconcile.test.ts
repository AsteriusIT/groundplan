/**
 * GP-209: comparing the graph of the code with the graph of the cloud.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import type { Graph, GraphNode } from "./graph.js";
import { reconcile, summarizeReconciliation } from "./reconcile.js";

const node = (
  partial: Partial<GraphNode> & Pick<GraphNode, "id" | "type">,
): GraphNode => ({
  name: partial.id.split(".").pop() ?? partial.id,
  provider: "azurerm",
  module_path: [],
  change: null,
  ...partial,
});

const graph = (nodes: GraphNode[], edges: Graph["edges"] = []): Graph => ({
  version: 7,
  nodes,
  edges,
});

const VNET = node({ id: "azurerm_virtual_network.main", type: "azurerm_virtual_network" });
const SUBNET = node({ id: "azurerm_subnet.web", type: "azurerm_subnet" });
const ORPHAN = node({
  id: "azurerm_storage_account.tmp",
  type: "azurerm_storage_account",
});

test("a resource in both, unchanged, is simply managed", () => {
  const result = reconcile(graph([VNET]), graph([VNET]));
  assert.deepEqual(result.counts, {
    unmanaged: 0,
    notApplied: 0,
    divergent: 0,
    matching: 1,
  });
  assert.equal(result.graph.nodes[0]?.change, "noop");
});

test("a resource created by hand is unmanaged — in the cloud, not in the code", () => {
  const result = reconcile(graph([VNET]), graph([VNET, ORPHAN]));

  assert.equal(result.counts.unmanaged, 1);
  assert.deepEqual(result.unmanaged, ["azurerm_storage_account.tmp"]);
  const found = result.graph.nodes.find((n) => n.id === ORPHAN.id);
  assert.equal(found?.change, "create", "reality has it, the code does not");
});

test("a resource the code declares but the cloud does not have is not applied", () => {
  const result = reconcile(graph([VNET, SUBNET]), graph([VNET]));

  assert.equal(result.counts.notApplied, 1);
  assert.deepEqual(result.notApplied, ["azurerm_subnet.web"]);
  assert.equal(
    result.graph.nodes.find((n) => n.id === SUBNET.id)?.change,
    "delete",
  );
});

test("a resource whose attributes differ on the two sides is divergent", () => {
  const result = reconcile(
    graph([node({ ...VNET, attributes: { location: "westeurope" } })]),
    graph([node({ ...VNET, attributes: { location: "northeurope" } })]),
  );

  assert.equal(result.counts.divergent, 1);
  assert.deepEqual(result.divergent, ["azurerm_virtual_network.main"]);
  const found = result.graph.nodes[0];
  assert.equal(found?.change, "update");
  assert.deepEqual(found?.attribute_diff, [
    { key: "location", before: "westeurope", after: "northeurope" },
  ]);
});

test("an attribute only one side carries is not, by itself, a divergence", () => {
  // The reality producer keeps a scalar bag; the docs producer keeps CIDRs and
  // little else. Reading "the code did not record this" as "the cloud changed
  // it" would flag a whole estate for the crime of being described differently.
  const result = reconcile(
    graph([node({ ...VNET, attributes: { location: "westeurope" } })]),
    graph([
      node({
        ...VNET,
        attributes: { location: "westeurope", sku: "Standard", tier: "Hot" },
      }),
    ]),
  );

  assert.equal(result.counts.divergent, 0);
  assert.equal(result.counts.matching, 1);
});

test("the module containers the two sides share are not counted as resources", () => {
  const module = node({ id: "module.network", type: "module", provider: null });
  const result = reconcile(graph([module, VNET]), graph([module, VNET]));
  assert.equal(result.counts.matching, 1, "the module is scaffolding, not a resource");
});

test("edges from both sides survive where both ends are still drawn", () => {
  const edge = {
    from: "azurerm_subnet.web",
    to: "azurerm_virtual_network.main",
    kind: "depends_on" as const,
  };
  const result = reconcile(graph([VNET, SUBNET], [edge]), graph([VNET, SUBNET]));
  assert.deepEqual(result.graph.edges, [edge]);
});

test("the comparison is a pure function of its two inputs", () => {
  const code = graph([VNET, SUBNET]);
  const reality = graph([VNET, ORPHAN]);
  assert.equal(
    JSON.stringify(reconcile(code, reality)),
    JSON.stringify(reconcile(code, reality)),
  );
});

// --- The deterministic summary ---------------------------------------------

test("the summary uses reconciliation words, never plan words", () => {
  const md = summarizeReconciliation(
    reconcile(graph([VNET, SUBNET]), graph([VNET, ORPHAN])),
  );

  assert.match(md, /not managed by this repository/i);
  assert.match(md, /azurerm_storage_account\.tmp/);
  assert.match(md, /declared but not found/i);
  assert.match(md, /azurerm_subnet\.web/);
  // "created" / "destroyed" belong to a plan; nothing here is being proposed.
  assert.ok(!/\bwill be created\b/i.test(md));
  assert.ok(!/\bdestroy\b/i.test(md));
});

test("an estate that matches its code says so in one line", () => {
  const md = summarizeReconciliation(reconcile(graph([VNET]), graph([VNET])));
  assert.match(md, /matches/i);
});
