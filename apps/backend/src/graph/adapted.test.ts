import { test } from "node:test";
import assert from "node:assert/strict";

import { projectAdapted, type AdaptableAnnotation } from "./adapted.js";
import { validateGraph, type Graph, type GraphNode } from "./graph.js";

const node = (id: string, over: Partial<GraphNode> = {}): GraphNode => ({
  id,
  name: id.split(".").pop() ?? id,
  type: id.startsWith("module.") ? "module" : "azurerm_storage_account",
  provider: "azurerm",
  module_path: [],
  change: null,
  ...over,
});

/** web → db → cache, all at the root. */
function fixture(): Graph {
  return {
    version: 1,
    nodes: [
      node("azurerm_linux_virtual_machine.web"),
      node("azurerm_postgresql_server.db"),
      node("azurerm_redis_cache.cache"),
    ],
    edges: [
      {
        from: "azurerm_linux_virtual_machine.web",
        to: "azurerm_postgresql_server.db",
        kind: "depends_on",
      },
      {
        from: "azurerm_postgresql_server.db",
        to: "azurerm_redis_cache.cache",
        kind: "depends_on",
      },
    ],
  };
}

const GROUP_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const GROUP_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

const ann = (over: Partial<AdaptableAnnotation> & { id: string; type: AdaptableAnnotation["type"] }): AdaptableAnnotation => ({
  anchors: [],
  label: null,
  body: null,
  status: "resolved",
  parentGroupId: null,
  ...over,
});

test("an empty annotation set leaves the graph unchanged (bar the version)", () => {
  const adapted = projectAdapted(fixture(), []);
  assert.deepEqual(
    adapted.nodes.map((n) => n.id),
    [
      "azurerm_linux_virtual_machine.web",
      "azurerm_postgresql_server.db",
      "azurerm_redis_cache.cache",
    ],
  );
  assert.equal(adapted.edges.length, 2);
  assert.equal(validateGraph(adapted).valid, true);
});

test("a group becomes a container node holding its members", () => {
  const adapted = projectAdapted(fixture(), [
    ann({
      id: GROUP_A,
      type: "group",
      label: "Storefront",
      anchors: ["azurerm_linux_virtual_machine.web", "azurerm_postgresql_server.db"],
    }),
  ]);

  const container = adapted.nodes.find((n) => n.id === `group:${GROUP_A}`);
  assert.equal(container?.name, "Storefront");
  assert.equal(container?.annotation_group, true);
  assert.equal(container?.provider, null);

  const contains = adapted.edges.filter((e) => e.kind === "contains");
  assert.deepEqual(
    contains.map((e) => e.to),
    ["azurerm_linux_virtual_machine.web", "azurerm_postgresql_server.db"],
  );
  assert.equal(contains.every((e) => e.from === `group:${GROUP_A}`), true);
  assert.equal(validateGraph(adapted).valid, true);
});

test("hide removes the node and every edge touching it — no dangling edges", () => {
  const adapted = projectAdapted(fixture(), [
    ann({ id: "h1", type: "hide", anchors: ["azurerm_postgresql_server.db"] }),
  ]);

  const ids = new Set(adapted.nodes.map((n) => n.id));
  assert.equal(ids.has("azurerm_postgresql_server.db"), false);
  assert.equal(adapted.edges.length, 0); // both edges touched the db
  for (const edge of adapted.edges) {
    assert.equal(ids.has(edge.from) && ids.has(edge.to), true);
  }
});

test("a group left empty by a hide is dropped, not rendered as an empty box", () => {
  const adapted = projectAdapted(fixture(), [
    ann({
      id: GROUP_A,
      type: "group",
      label: "Storefront",
      anchors: ["azurerm_linux_virtual_machine.web"],
    }),
    ann({ id: "h1", type: "hide", anchors: ["azurerm_linux_virtual_machine.web"] }),
  ]);
  assert.equal(
    adapted.nodes.some((n) => n.id === `group:${GROUP_A}`),
    false,
  );
});

test("rename sets display_label and keeps the derived name", () => {
  const adapted = projectAdapted(fixture(), [
    ann({
      id: "r1",
      type: "rename",
      label: "Customer database",
      anchors: ["azurerm_postgresql_server.db"],
    }),
  ]);
  const renamed = adapted.nodes.find((n) => n.id === "azurerm_postgresql_server.db");
  assert.equal(renamed?.display_label, "Customer database");
  assert.equal(renamed?.name, "db"); // the truth is still there
});

test("notes ride on the node they are anchored to", () => {
  const adapted = projectAdapted(fixture(), [
    ann({
      id: "n1",
      type: "note",
      body: "On-call: payments",
      anchors: ["azurerm_redis_cache.cache"],
    }),
    ann({
      id: "n2",
      type: "note",
      body: "Evicts nightly",
      anchors: ["azurerm_redis_cache.cache"],
    }),
  ]);
  const cache = adapted.nodes.find((n) => n.id === "azurerm_redis_cache.cache");
  assert.deepEqual(cache?.notes, ["On-call: payments", "Evicts nightly"]);
});

test("a logical edge between two addresses is added, flagged and labelled", () => {
  const adapted = projectAdapted(fixture(), [
    ann({
      id: "l1",
      type: "link",
      label: "replicates to",
      anchors: ["azurerm_linux_virtual_machine.web", "azurerm_redis_cache.cache"],
    }),
  ]);
  const logical = adapted.edges.filter((e) => e.kind === "logical");
  assert.equal(logical.length, 1);
  assert.equal(logical[0]?.from, "azurerm_linux_virtual_machine.web");
  assert.equal(logical[0]?.to, "azurerm_redis_cache.cache");
  assert.equal(logical[0]?.label, "replicates to");
  assert.equal(validateGraph(adapted).valid, true);
});

test("a logical edge between two groups connects the containers", () => {
  const adapted = projectAdapted(fixture(), [
    ann({
      id: GROUP_A,
      type: "group",
      label: "Front",
      anchors: ["azurerm_linux_virtual_machine.web"],
    }),
    ann({
      id: GROUP_B,
      type: "group",
      label: "Data",
      anchors: ["azurerm_postgresql_server.db"],
    }),
    ann({ id: "l1", type: "link", label: "reads", anchors: [GROUP_A, GROUP_B] }),
  ]);
  const logical = adapted.edges.find((e) => e.kind === "logical");
  assert.equal(logical?.from, `group:${GROUP_A}`);
  assert.equal(logical?.to, `group:${GROUP_B}`);
});

test("a logical edge whose endpoint was hidden is dropped, not left dangling", () => {
  const adapted = projectAdapted(fixture(), [
    ann({ id: "h1", type: "hide", anchors: ["azurerm_redis_cache.cache"] }),
    ann({
      id: "l1",
      type: "link",
      anchors: ["azurerm_linux_virtual_machine.web", "azurerm_redis_cache.cache"],
    }),
  ]);
  assert.equal(adapted.edges.some((e) => e.kind === "logical"), false);
});

test("proposed and orphaned annotations have no effect on the output", () => {
  const untouched = projectAdapted(fixture(), []);
  const withNoise = projectAdapted(fixture(), [
    ann({
      id: GROUP_A,
      type: "group",
      label: "Proposed",
      status: "proposed",
      anchors: ["azurerm_linux_virtual_machine.web"],
    }),
    ann({
      id: "h1",
      type: "hide",
      status: "orphaned",
      anchors: ["azurerm_postgresql_server.db"],
    }),
    ann({
      id: "r1",
      type: "rename",
      status: "proposed",
      label: "Nope",
      anchors: ["azurerm_redis_cache.cache"],
    }),
  ]);
  assert.deepEqual(withNoise, untouched);
});

test("nested groups nest: the child container sits inside the parent", () => {
  const adapted = projectAdapted(fixture(), [
    ann({
      id: GROUP_A,
      type: "group",
      label: "Platform",
      anchors: ["azurerm_linux_virtual_machine.web"],
    }),
    ann({
      id: GROUP_B,
      type: "group",
      label: "Data",
      parentGroupId: GROUP_A,
      anchors: ["azurerm_postgresql_server.db"],
    }),
  ]);
  const nesting = adapted.edges.find(
    (e) => e.kind === "contains" && e.to === `group:${GROUP_B}`,
  );
  assert.equal(nesting?.from, `group:${GROUP_A}`);
  assert.equal(validateGraph(adapted).valid, true);
});

test("a grouped node leaves its module box, and an emptied module is dropped", () => {
  const graph: Graph = {
    version: 1,
    nodes: [
      node("module.payments", { type: "module", provider: null }),
      node("module.payments.azurerm_postgresql_server.db", { module_path: ["payments"] }),
      node("azurerm_linux_virtual_machine.web"),
    ],
    edges: [
      {
        from: "module.payments",
        to: "module.payments.azurerm_postgresql_server.db",
        kind: "contains",
      },
    ],
  };

  const adapted = projectAdapted(graph, [
    ann({
      id: GROUP_A,
      type: "group",
      label: "Storefront",
      anchors: ["module.payments.azurerm_postgresql_server.db"],
    }),
  ]);

  // The resource has exactly one parent — the group — and the module container
  // it emptied is gone rather than lingering as a labelled empty frame.
  const parents = adapted.edges.filter(
    (e) => e.kind === "contains" && e.to === "module.payments.azurerm_postgresql_server.db",
  );
  assert.equal(parents.length, 1);
  assert.equal(parents[0]?.from, `group:${GROUP_A}`);
  assert.equal(
    adapted.nodes.some((n) => n.id === "module.payments"),
    false,
  );
});

test("output is byte-identical across runs and independent of annotation order", () => {
  const annotations: AdaptableAnnotation[] = [
    ann({ id: "n1", type: "note", body: "x", anchors: ["azurerm_redis_cache.cache"] }),
    ann({
      id: GROUP_A,
      type: "group",
      label: "Front",
      anchors: ["azurerm_linux_virtual_machine.web"],
    }),
    ann({
      id: "l1",
      type: "link",
      anchors: ["azurerm_linux_virtual_machine.web", "azurerm_redis_cache.cache"],
    }),
  ];
  const once = JSON.stringify(projectAdapted(fixture(), annotations));
  const twice = JSON.stringify(projectAdapted(fixture(), annotations));
  const shuffled = JSON.stringify(projectAdapted(fixture(), [...annotations].reverse()));

  assert.equal(once, twice);
  assert.equal(once, shuffled);
});
