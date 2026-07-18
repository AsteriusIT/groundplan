import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import {
  computeGraphStats,
  validateGraph,
  type Graph,
  type GraphNode,
  type UnresolvedReference,
} from "./graph.js";
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

test("a reference to a resource absent from the plan is captured; data refs are not", () => {
  const plan = {
    format_version: "1.0",
    resource_changes: [
      {
        address: "aws_s3_bucket.logs",
        mode: "managed",
        type: "aws_s3_bucket",
        name: "logs",
        provider_name: "registry.terraform.io/hashicorp/aws",
        change: { actions: ["create"], before: null, after: {} },
      },
    ],
    configuration: {
      root_module: {
        resources: [
          {
            address: "aws_s3_bucket.logs",
            expressions: {
              // A bucket that is not in the plan (its type IS present, so this is
              // a real dangling reference), and a data source (excluded from a
              // plan graph on purpose — not a dangling reference).
              replication: { references: ["aws_s3_bucket.other.arn", "aws_s3_bucket.other"] },
              region: {
                references: ["data.aws_region.current.name", "data.aws_region.current"],
              },
            },
          },
        ],
      },
    },
  };

  const out = { unresolved: [] as UnresolvedReference[] };
  parsePlanToGraph(plan, out);

  const captured = out.unresolved.find(
    (u) => u.from === "aws_s3_bucket.logs" && u.ref.includes("aws_s3_bucket.other"),
  );
  assert.ok(
    captured,
    `expected the absent bucket ref captured, got ${JSON.stringify(out.unresolved)}`,
  );
  assert.ok(captured.reason, "an unresolved reference explains itself");
  // The data-source reference is intentionally excluded, so it must NOT appear.
  assert.ok(!out.unresolved.some((u) => u.ref.includes("data.aws_region")));
});

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

test("derives satellite stacking from a plan: probe/pool/rule → lb, public IP → host, NIC → VM (GP-86)", () => {
  const graph = parsePlanToGraph(readJson("plans/stacking.plan.json"));
  const parent = new Map(graph.nodes.map((n) => [n.id, n.parent_id]));
  assert.equal(parent.get("azurerm_lb.main"), "azurerm_subnet.internal");
  assert.equal(parent.get("azurerm_lb_probe.https"), "azurerm_lb.main");
  assert.equal(parent.get("azurerm_lb_backend_address_pool.pool"), "azurerm_lb.main");
  assert.equal(parent.get("azurerm_lb_rule.http"), "azurerm_lb.main");
  assert.equal(parent.get("azurerm_public_ip.appgw"), "azurerm_application_gateway.appgw");
  assert.equal(parent.get("azurerm_public_ip.bastion"), "azurerm_bastion_host.bastion");
  assert.equal(parent.get("azurerm_network_interface.nic"), "azurerm_linux_virtual_machine.vm");
  // A NAT gateway binds its public IP via an association resource → resolved through it.
  assert.equal(parent.get("azurerm_public_ip.nat"), "azurerm_nat_gateway.nat");
});

test("attaches NSG rules, internet_exposed, and associations from a plan (GP-43)", () => {
  const graph = parsePlanToGraph(readJson("plans/nsg.plan.json"));
  assert.equal(graph.version, 4);
  const byId = new Map(graph.nodes.map((n) => [n.id, n]));
  const open = byId.get("azurerm_network_security_group.open")!;
  assert.equal(open.rules?.length, 2);
  assert.deepEqual(open.rules?.[0], {
    name: "allow-https",
    priority: 100,
    direction: "Inbound",
    access: "Allow",
    protocol: "Tcp",
    ports: "443",
    source: "Internet",
    destination: "*",
  });
  assert.equal(open.internet_exposed, true);
  assert.deepEqual(open.associated_ids, ["azurerm_subnet.web"]);
  assert.equal(byId.get("azurerm_network_security_group.closed")!.internet_exposed, false);
});

test("attaches route-table associated_ids to the route table, without NSG payload (GP-89)", () => {
  const graph = parsePlanToGraph(readJson("plans/nsg.plan.json"));
  const rt = new Map(graph.nodes.map((n) => [n.id, n])).get("azurerm_route_table.rt")!;
  assert.deepEqual(rt.associated_ids, ["azurerm_subnet.web"]);
  // A route table is not a security group — it carries no rules / exposure flag.
  assert.equal(rt.rules, undefined);
  assert.equal(rt.internet_exposed, undefined);
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

// --- IAM extraction (GP-47) ---------------------------------------------------

function iamNode(id: string): GraphNode | undefined {
  return parsePlanToGraph(readJson("plans/iam.plan.json")).nodes.find(
    (n) => n.id === id,
  );
}

test("a plan carrying IAM payloads is a valid graph at schema version 4", () => {
  const graph = parsePlanToGraph(readJson("plans/iam.plan.json"));
  assert.equal(validateGraph(graph).valid, true);
  assert.equal(graph.version, 4);
});

test("role assignments carry the role/principal/scope triple, resolving references", () => {
  // AcrPull: principal resolves to the app identity, scope to the registry.
  assert.deepEqual(iamNode("azurerm_role_assignment.acr_pull")?.role_assignment, {
    role: "AcrPull",
    principal: "azurerm_user_assigned_identity.aks",
    scope: "azurerm_container_registry.main",
  });
  // Owner at RG: literal principal id kept raw, scope resolved to the RG node.
  assert.deepEqual(iamNode("azurerm_role_assignment.owner_rg")?.role_assignment, {
    role: "Owner",
    principal: "11111111-1111-1111-1111-111111111111",
    scope: "azurerm_resource_group.main",
    principal_type: "ServicePrincipal",
  });
  // Contributor at subscription: raw subscription id scope kept as-is.
  assert.deepEqual(
    iamNode("azurerm_role_assignment.contributor_sub")?.role_assignment,
    {
      role: "Contributor",
      principal: "22222222-2222-2222-2222-222222222222",
      scope: "/subscriptions/00000000-0000-0000-0000-000000000000",
    },
  );
});

test("privileged is true exactly for high-privilege roles at broad scope (GP-47)", () => {
  assert.equal(iamNode("azurerm_role_assignment.owner_rg")?.privileged, true); // Owner @ RG
  assert.equal(iamNode("azurerm_role_assignment.contributor_sub")?.privileged, true); // Contributor @ sub
  assert.equal(iamNode("azurerm_role_assignment.net_admin")?.privileged, true); // *Admin* @ sub
  assert.equal(iamNode("azurerm_role_assignment.acr_pull")?.privileged, false); // narrow role + scope
  assert.equal(iamNode("azurerm_role_assignment.reader_rg")?.privileged, false); // broad scope, weak role
});

test("managed identities carry an identity payload with resolved user-assigned refs", () => {
  assert.deepEqual(iamNode("azurerm_user_assigned_identity.aks")?.identity, {
    type: "UserAssigned",
  });
  assert.deepEqual(iamNode("azurerm_kubernetes_cluster.main")?.identity, {
    type: "UserAssigned",
    identity_ids: ["azurerm_user_assigned_identity.aks"],
  });
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

test("the join catalog places, attaches, and edges association resources (azurerm joins)", () => {
  const graph = parsePlanToGraph(readJson("plans/joins.plan.json"));
  assert.equal(validateGraph(graph).valid, true);
  const byId = new Map(graph.nodes.map((n) => [n.id, n]));
  const hasEdge = (from: string, to: string) =>
    graph.edges.some((e) => e.kind === "depends_on" && e.from === from && e.to === to);

  // subnet_nat_gateway_association → the NAT gateway nests in its subnet.
  assert.equal(byId.get("azurerm_nat_gateway.out")?.parent_id, "azurerm_subnet.internal");
  // data-disk attachment → the disk stacks under its VM.
  assert.equal(
    byId.get("azurerm_managed_disk.data")?.parent_id,
    "azurerm_linux_virtual_machine.app",
  );
  // vnet peering collapses to one direct vnet ⇄ vnet edge.
  assert.ok(
    hasEdge("azurerm_virtual_network.hub", "azurerm_virtual_network.spoke") ||
      hasEdge("azurerm_virtual_network.spoke", "azurerm_virtual_network.hub"),
    "expected a direct edge between the peered vnets",
  );
  // NIC ↔ LB pool association collapses to a direct NIC → pool edge.
  assert.ok(
    hasEdge("azurerm_network_interface.nic", "azurerm_lb_backend_address_pool.pool"),
    "expected a direct NIC → pool edge",
  );
  // VMSS inline NSG duality: the NSG records the scale set it guards.
  assert.deepEqual(byId.get("azurerm_network_security_group.web")?.associated_ids, [
    "azurerm_linux_virtual_machine_scale_set.workers",
  ]);
});

test("a synthetic join edge never duplicates an existing reference edge", () => {
  const graph = parsePlanToGraph(readJson("plans/joins.plan.json"));
  // The VMSS already references its NSG inline — the attach semantic must not
  // add a second (reversed) edge between the same two nodes.
  const between = graph.edges.filter(
    (e) =>
      e.kind === "depends_on" &&
      [e.from, e.to].includes("azurerm_network_security_group.web") &&
      [e.from, e.to].includes("azurerm_linux_virtual_machine_scale_set.workers"),
  );
  assert.equal(between.length, 1);
});
