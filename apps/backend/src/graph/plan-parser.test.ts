import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { computeGraphStats, validateGraph, type Graph, type GraphNode } from "./graph.js";
import { isTerraformPlan, parsePlanToGraph } from "./plan-parser.js";

function readJson(rel: string): unknown {
  const path = fileURLToPath(new URL(`./__fixtures__/${rel}`, import.meta.url));
  return JSON.parse(readFileSync(path, "utf8"));
}

for (const name of ["simple", "modules", "replace", "plan-expressions", "attributes"]) {
  test(`parses the ${name} plan into the expected golden graph`, () => {
    const plan = readJson(`plans/${name}.plan.json`);
    const expected = readJson(`graphs/${name}.graph.json`);

    const graph = parsePlanToGraph(plan);

    assert.equal(validateGraph(graph).valid, true, "output must be a valid graph");
    assert.deepEqual(graph, expected);
    // Byte-stable: parsing twice yields identical serialized output.
    assert.equal(JSON.stringify(graph), JSON.stringify(parsePlanToGraph(plan)));
  });
}

test("expression references connect the previously floating chain (GP-20)", () => {
  const graph = parsePlanToGraph(readJson("plans/plan-expressions.plan.json"));
  const has = (from: string, to: string) =>
    graph.edges.some((e) => e.from === from && e.to === to && e.kind === "depends_on");
  // vm -> nic -> subnet -> vnet is now a connected chain.
  assert.ok(has("azurerm_virtual_machine.main", "azurerm_network_interface.main"));
  assert.ok(has("azurerm_network_interface.main", "azurerm_subnet.internal"));
  assert.ok(has("azurerm_subnet.internal", "azurerm_virtual_network.main"));
});

test("explicit depends_on wins over an inferred edge to the same target", () => {
  const graph = parsePlanToGraph(readJson("plans/plan-expressions.plan.json"));
  const vmEdge = graph.edges.find(
    (e) => e.from === "azurerm_virtual_machine.main" && e.to === "azurerm_network_interface.main",
  );
  assert.equal(vmEdge?.inferred, false);
  const nicEdge = graph.edges.find(
    (e) => e.from === "azurerm_network_interface.main" && e.to === "azurerm_subnet.internal",
  );
  assert.equal(nicEdge?.inferred, true);
});

test("derives vnet⊃subnet⊃NIC containment (parent_id) and escalates to v4 (GP-42)", () => {
  const graph = parsePlanToGraph(readJson("plans/plan-expressions.plan.json"));
  const byId = new Map(graph.nodes.map((n) => [n.id, n]));
  assert.equal(graph.version, 4);
  assert.equal(
    byId.get("azurerm_subnet.internal")?.parent_id,
    "azurerm_virtual_network.main",
  );
  assert.equal(
    byId.get("azurerm_network_interface.main")?.parent_id,
    "azurerm_subnet.internal",
  );
  // A VM references only a NIC (not a subnet) → no containment parent.
  assert.equal(byId.get("azurerm_virtual_machine.main")?.parent_id, undefined);
  // route_table references a count subnet (2 instances) → ambiguous → no parent.
  assert.equal(byId.get("azurerm_route_table.rt")?.parent_id, undefined);
});

test("a reference to a count resource fans out to all its instances", () => {
  const graph = parsePlanToGraph(readJson("plans/plan-expressions.plan.json"));
  const targets = graph.edges
    .filter((e) => e.from === "azurerm_route_table.rt")
    .map((e) => e.to)
    .sort();
  assert.deepEqual(targets, ["azurerm_subnet.extra[0]", "azurerm_subnet.extra[1]"]);
});

test("var. references never produce edges; no self-edges or duplicates", () => {
  const graph = parsePlanToGraph(readJson("plans/plan-expressions.plan.json"));
  assert.ok(!graph.edges.some((e) => e.to.startsWith("var.") || e.from.startsWith("var.")));
  assert.ok(!graph.edges.some((e) => e.from === e.to), "no self-edges");
  const keys = graph.edges.map((e) => `${e.kind} ${e.from} ${e.to}`);
  assert.equal(new Set(keys).size, keys.length, "no duplicate edges");
});

test("stats expose edge count and inferred-edge count", () => {
  const graph = parsePlanToGraph(readJson("plans/plan-expressions.plan.json"));
  const stats = computeGraphStats(graph);
  assert.equal(stats.edges, 7);
  assert.equal(stats.inferredEdges, 6); // all but the explicit vm -> nic edge
});

test("data resources are excluded from the plan graph", () => {
  const plan = readJson("plans/simple.plan.json");
  const graph = parsePlanToGraph(plan);
  assert.ok(
    !graph.nodes.some((n) => n.id.startsWith("data.")),
    "data resources must not appear as nodes",
  );
});

test("replace actions ([delete,create] / [create,delete]) map to update", () => {
  const graph = parsePlanToGraph(readJson("plans/replace.plan.json"));
  const web = graph.nodes.find((n) => n.id === "aws_instance.web");
  const worker = graph.nodes.find((n) => n.id === "aws_instance.worker");
  assert.equal(web?.change, "update");
  assert.equal(worker?.change, "update");
});

test("isTerraformPlan detects plans via format_version + resource_changes", () => {
  assert.equal(isTerraformPlan({ format_version: "1.2", resource_changes: [] }), true);
  assert.equal(isTerraformPlan({ hello: "world" }), false);
  assert.equal(isTerraformPlan({ format_version: "1.2" }), false);
  assert.equal(isTerraformPlan({ resource_changes: [] }), false);
  assert.equal(isTerraformPlan(null), false);
});

test("a 500-resource plan parses in under 2 seconds", () => {
  const resource_changes = Array.from({ length: 500 }, (_, i) => ({
    address: `aws_s3_bucket.b${i}`,
    mode: "managed",
    type: "aws_s3_bucket",
    name: `b${i}`,
    provider_name: "registry.terraform.io/hashicorp/aws",
    change: { actions: ["create"] },
  }));
  const plan = { format_version: "1.2", resource_changes };

  const start = process.hrtime.bigint();
  const graph = parsePlanToGraph(plan);
  const ms = Number(process.hrtime.bigint() - start) / 1e6;

  assert.equal(graph.nodes.length, 500);
  assert.ok(ms < 2000, `expected < 2000ms, took ${ms.toFixed(1)}ms`);
});

test("an invalid graph would be caught by validation (empty address)", () => {
  const graph: Graph = parsePlanToGraph({
    format_version: "1.2",
    resource_changes: [
      { address: "", mode: "managed", type: "aws_s3_bucket", name: "x", change: { actions: ["create"] } },
    ],
  });
  // The parser is faithful (produces the empty id); validation is the gate.
  assert.equal(validateGraph(graph).valid, false);
});

// --- Attribute diff (GP-32) ---------------------------------------------------

function attrNode(id: string): GraphNode | undefined {
  return parsePlanToGraph(readJson("plans/attributes.plan.json")).nodes.find(
    (n) => n.id === id,
  );
}

test("a plan carrying attribute diffs is emitted at schema version 3", () => {
  const graph = parsePlanToGraph(readJson("plans/attributes.plan.json"));
  assert.equal(graph.version, 3);
  assert.equal(validateGraph(graph).valid, true);
});

test("plans with no before/after stay at version 2 (backward compatible)", () => {
  const graph = parsePlanToGraph(readJson("plans/replace.plan.json"));
  assert.equal(graph.version, 2);
  assert.ok(!graph.nodes.some((n) => n.attribute_diff !== undefined));
});

test("shop-db update yields exactly the changed attributes with before/after", () => {
  assert.deepEqual(attrNode("azurerm_mssql_database.shop_db")?.attribute_diff, [
    { key: "sku_name", before: "S0", after: "P1" },
    { key: "tags", before: "{…}", after: "{…}" }, // nested change → marker only
    { key: "zone_redundant", before: "false", after: "true" },
  ]);
});

test("sensitive attributes never store plaintext anywhere in the graph", () => {
  const graph = parsePlanToGraph(readJson("plans/attributes.plan.json"));
  const server = graph.nodes.find((n) => n.id === "azurerm_mssql_server.main");
  assert.deepEqual(server?.attribute_diff, [
    { key: "administrator_login_password", before: "(sensitive)", after: "(sensitive)" },
  ]);
  // Hard guarantee: no plaintext secret survives serialization (unchanged
  // non-sensitive "version" is also correctly excluded, so it can't leak).
  assert.ok(!JSON.stringify(graph).includes("PLAINTEXT"));
});

test("known-after-apply attributes render as (known after apply) on create", () => {
  const assets = attrNode("azurerm_storage_account.assets");
  assert.deepEqual(assets?.attribute_diff, [
    { key: "account_tier", before: null, after: "Standard" },
    { key: "id", before: null, after: "(known after apply)" },
    { key: "primary_access_key", before: null, after: "(known after apply)" },
  ]);
});

test("delete rows carry the old value with a null after", () => {
  assert.deepEqual(attrNode("azurerm_public_ip.legacy")?.attribute_diff, [
    { key: "allocation_method", before: "Static", after: null },
    { key: "ip_address", before: "20.1.2.3", after: null },
  ]);
});

test("a change with >20 attributes caps the diff and flags truncation", () => {
  const before: Record<string, number> = {};
  const after: Record<string, number> = {};
  for (let i = 0; i < 30; i++) {
    const k = `attr_${String(i).padStart(2, "0")}`;
    before[k] = i;
    after[k] = i + 1;
  }
  const graph = parsePlanToGraph({
    format_version: "1.2",
    resource_changes: [
      {
        address: "aws_instance.big",
        mode: "managed",
        type: "aws_instance",
        name: "big",
        provider_name: "registry.terraform.io/hashicorp/aws",
        change: { actions: ["update"], before, after },
      },
    ],
  });
  const node = graph.nodes.find((n) => n.id === "aws_instance.big");
  assert.equal(node?.attribute_diff?.length, 20);
  assert.equal(node?.attribute_diff_truncated, true);
  assert.equal(graph.version, 3);
});

test("attribute_diff_truncated is omitted when nothing was capped", () => {
  const node = attrNode("azurerm_mssql_database.shop_db");
  assert.equal(node?.attribute_diff_truncated, undefined);
});

test("validateGraph accepts both a hand-written v1 node and a v3 node", () => {
  const v1Node: GraphNode = {
    id: "aws_s3_bucket.a",
    name: "a",
    type: "aws_s3_bucket",
    provider: "aws",
    module_path: [],
    change: "create",
  };
  assert.equal(validateGraph({ version: 1, nodes: [v1Node], edges: [] }).valid, true);

  const v3Node: GraphNode = {
    ...v1Node,
    change: "update",
    attribute_diff: [{ key: "sku_name", before: "S0", after: "P1" }],
    attribute_diff_truncated: false,
  };
  assert.equal(validateGraph({ version: 3, nodes: [v3Node], edges: [] }).valid, true);
});
