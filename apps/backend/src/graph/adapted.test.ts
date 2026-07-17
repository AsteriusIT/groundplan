import { test } from "node:test";
import assert from "node:assert/strict";

import {
  collapseToGroups,
  projectAdapted,
  UNGROUPED_ID,
  type AdaptableAnnotation,
} from "./adapted.js";
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

// --- C4: group granularity (GP-77) ------------------------------------------

/** Two groups, an edge each way between their members, plus a loose resource. */
function grouped(): { graph: Graph; annotations: AdaptableAnnotation[] } {
  const graph: Graph = {
    version: 1,
    nodes: [
      node("azurerm_x.web"),
      node("azurerm_x.api"),
      node("azurerm_x.db"),
      node("azurerm_x.cache"),
      node("azurerm_x.loose"),
    ],
    edges: [
      // Two separate crossings between the same pair of groups...
      { from: "azurerm_x.web", to: "azurerm_x.db", kind: "depends_on" },
      { from: "azurerm_x.api", to: "azurerm_x.cache", kind: "depends_on" },
      // ...and one edge *inside* the front group.
      { from: "azurerm_x.web", to: "azurerm_x.api", kind: "depends_on" },
    ],
  };
  const annotations = [
    ann({
      id: GROUP_A,
      type: "group",
      label: "Storefront",
      anchors: ["azurerm_x.web", "azurerm_x.api"],
    }),
    ann({
      id: GROUP_B,
      type: "group",
      label: "Data",
      anchors: ["azurerm_x.db", "azurerm_x.cache"],
    }),
  ];
  return { graph, annotations };
}

test("each top-level group collapses to one node carrying its member count", () => {
  const { graph, annotations } = grouped();
  const c4 = collapseToGroups(projectAdapted(graph, annotations));

  const front = c4.nodes.find((n) => n.id === `group:${GROUP_A}`);
  assert.equal(front?.member_count, 2);
  assert.equal(front?.name, "Storefront");
  // The members themselves are gone — that is what collapsing means.
  assert.equal(c4.nodes.some((n) => n.id === "azurerm_x.web"), false);
  assert.equal(validateGraph(c4).valid, true);
});

test("edges between two groups aggregate into one, carrying the count", () => {
  const { graph, annotations } = grouped();
  const c4 = collapseToGroups(projectAdapted(graph, annotations));

  const between = c4.edges.filter(
    (e) => e.from === `group:${GROUP_A}` && e.to === `group:${GROUP_B}`,
  );
  assert.equal(between.length, 1);
  assert.equal(between[0]?.count, 2);
  assert.equal(between[0]?.label, "×2");
});

test("edges inside a group vanish — at this altitude they are internal detail", () => {
  const { graph, annotations } = grouped();
  const c4 = collapseToGroups(projectAdapted(graph, annotations));
  assert.equal(
    c4.edges.some((e) => e.from === e.to),
    false,
  );
  // web→api was intra-group; only the one aggregated inter-group edge remains.
  assert.equal(c4.edges.filter((e) => e.kind === "depends_on").length, 1);
});

test("a logical edge survives aggregation and stays a logical edge", () => {
  const { graph, annotations } = grouped();
  const c4 = collapseToGroups(
    projectAdapted(graph, [
      ...annotations,
      ann({ id: "l1", type: "link", label: "replicates to", anchors: [GROUP_A, GROUP_B] }),
    ]),
  );
  const logical = c4.edges.filter((e) => e.kind === "logical");
  assert.equal(logical.length, 1);
  // Never merged into the structural edge beside it: a relationship a human
  // asserted and one the code declares are different claims.
  assert.equal(logical[0]?.label, "replicates to");
  assert.equal(
    c4.edges.some((e) => e.kind === "depends_on"),
    true,
  );
});

test("few ungrouped resources are drawn; many collapse into one bucket", () => {
  const { graph, annotations } = grouped();

  // One loose resource — worth seeing.
  const few = collapseToGroups(projectAdapted(graph, annotations));
  assert.equal(few.nodes.some((n) => n.id === "azurerm_x.loose"), true);
  assert.equal(few.nodes.some((n) => n.id === UNGROUPED_ID), false);

  // Seven loose resources — the noise the view exists to remove.
  const noisy: Graph = {
    ...graph,
    nodes: [
      ...graph.nodes,
      ...["a", "b", "c", "d", "e", "f"].map((n) => node(`azurerm_x.${n}`)),
    ],
  };
  const many = collapseToGroups(projectAdapted(noisy, annotations));
  const bucket = many.nodes.find((n) => n.id === UNGROUPED_ID);
  assert.equal(bucket?.member_count, 7);
  assert.equal(many.nodes.some((n) => n.id === "azurerm_x.loose"), false);
});

test("expandGroup opens one group in place and leaves the others collapsed", () => {
  const { graph, annotations } = grouped();
  const c4 = collapseToGroups(projectAdapted(graph, annotations), {
    expandGroup: GROUP_A,
  });

  // The opened group is a container again: its members are back, under it.
  const front = c4.nodes.find((n) => n.id === `group:${GROUP_A}`);
  assert.equal(front?.member_count, undefined); // not collapsed
  assert.equal(c4.nodes.some((n) => n.id === "azurerm_x.web"), true);
  assert.equal(
    c4.edges.some(
      (e) => e.kind === "contains" && e.from === `group:${GROUP_A}` && e.to === "azurerm_x.web",
    ),
    true,
  );

  // Its sibling is untouched by the drill-in.
  const data = c4.nodes.find((n) => n.id === `group:${GROUP_B}`);
  assert.equal(data?.member_count, 2);
  assert.equal(c4.nodes.some((n) => n.id === "azurerm_x.db"), false);
  assert.equal(validateGraph(c4).valid, true);
});

test("a nested group collapses inside its expanded parent", () => {
  const graph: Graph = {
    version: 1,
    nodes: [node("azurerm_x.web"), node("azurerm_x.db")],
    edges: [],
  };
  const c4 = collapseToGroups(
    projectAdapted(graph, [
      ann({ id: GROUP_A, type: "group", label: "Platform", anchors: ["azurerm_x.web"] }),
      ann({
        id: GROUP_B,
        type: "group",
        label: "Data",
        parentGroupId: GROUP_A,
        anchors: ["azurerm_x.db"],
      }),
    ]),
    { expandGroup: GROUP_A },
  );

  // Top-level group open; the child group inside it is a single node — the C4
  // levels line up with the one level of nesting the model allows (GP-71).
  assert.equal(c4.nodes.find((n) => n.id === `group:${GROUP_B}`)?.member_count, 1);
  assert.equal(c4.nodes.some((n) => n.id === "azurerm_x.db"), false);
});

test("a note inside a collapsed group is counted at the group", () => {
  const { graph, annotations } = grouped();
  const c4 = collapseToGroups(
    projectAdapted(graph, [
      ...annotations,
      ann({ id: "n1", type: "note", body: "On-call: payments", anchors: ["azurerm_x.web"] }),
    ]),
  );
  assert.deepEqual(
    c4.nodes.find((n) => n.id === `group:${GROUP_A}`)?.notes,
    ["On-call: payments"],
  );
});

test("collapsing is deterministic — same input, byte-identical output", () => {
  const { graph, annotations } = grouped();
  const once = JSON.stringify(collapseToGroups(projectAdapted(graph, annotations)));
  const twice = JSON.stringify(collapseToGroups(projectAdapted(graph, annotations)));
  assert.equal(once, twice);
});

test("no groups at all collapses to an empty-of-groups graph, not a broken one", () => {
  const c4 = collapseToGroups(projectAdapted(fixture(), []));
  assert.equal(c4.nodes.some((n) => n.annotation_group), false);
  assert.equal(validateGraph(c4).valid, true);
});

// GP-86: resource stacking is a network-view concern. Adding satellite parent_ids
// must not change what the adapted or C4 projection draws — stacking cannot leak
// out of the network view by accident.
function withStacking(graph: Graph): Graph {
  const host = graph.nodes.find((n) => n.type !== "module" && !n.annotation_group);
  return {
    ...graph,
    nodes: graph.nodes.map((n) =>
      n === host || n.type === "module" || n.annotation_group
        ? n
        : { ...n, parent_id: host!.id },
    ),
  };
}

test("stacking never leaks: adapted projection ignores resource-level parent_id (GP-86)", () => {
  const flat = projectAdapted(fixture(), []);
  const stacked = projectAdapted(withStacking(fixture()), []);
  assert.deepEqual(stacked.nodes.map((n) => n.id), flat.nodes.map((n) => n.id));
  assert.deepEqual(stacked.edges, flat.edges);
});

test("stacking never leaks: C4 collapse ignores resource-level parent_id (GP-86)", () => {
  const { graph, annotations } = grouped();
  const flat = collapseToGroups(projectAdapted(graph, annotations));
  const stacked = collapseToGroups(projectAdapted(withStacking(graph), annotations));
  assert.deepEqual(stacked.nodes.map((n) => n.id), flat.nodes.map((n) => n.id));
  assert.deepEqual(stacked.edges, flat.edges);
});
