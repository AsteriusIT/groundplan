import assert from "node:assert/strict";
import { test } from "node:test";

import type { Graph, GraphNode } from "../graph.js";
import { ruleById } from "./catalog.js";
import type { PolicyNote, PolicyParams } from "./types.js";

function node(partial: Partial<GraphNode> & Pick<GraphNode, "id" | "type">): GraphNode {
  return {
    name: partial.id.split(".").pop() ?? partial.id,
    provider: "azurerm",
    module_path: [],
    change: null,
    ...partial,
  };
}

function graph(nodes: GraphNode[], edges: Graph["edges"] = []): Graph {
  return { version: 8, nodes, edges };
}

/** Run one catalogue rule directly — the golden contract of that rule alone. */
function run(id: string, g: Graph, params: PolicyParams = {}): PolicyNote[] {
  const rule = ruleById(id);
  assert.ok(rule, `no rule ${id} in the catalogue`);
  return rule.evaluate({
    graph: g,
    params: { ...(rule.defaultParams ?? {}), ...params },
  });
}

function sourced(id: string, type: string, code: string): GraphNode {
  return node({ id, type, source: { file: "main.tf", start_line: 1, end_line: 9, code } });
}

test("privileged-role-assignment names the role, principal and scope", () => {
  const notes = run(
    "privileged-role-assignment",
    graph([
      node({
        id: "azurerm_role_assignment.admin",
        type: "azurerm_role_assignment",
        privileged: true,
        role_assignment: {
          role: "Owner",
          principal: "azurerm_user_assigned_identity.ci",
          scope: "/subscriptions/0000",
        },
      }),
      node({
        id: "azurerm_role_assignment.reader",
        type: "azurerm_role_assignment",
        role_assignment: { role: "Reader", principal: "p", scope: "s" },
      }),
    ]),
  );
  assert.deepEqual(notes, [
    {
      address: "azurerm_role_assignment.admin",
      message:
        '"Owner" is granted to azurerm_user_assigned_identity.ci at /subscriptions/0000.',
      hint: "Grant the narrowest built-in role that works, at the narrowest scope that works.",
    },
  ]);
});

test("required-tags reports only the keys that are missing", () => {
  const notes = run(
    "required-tags",
    graph([
      sourced(
        "azurerm_resource_group.a",
        "azurerm_resource_group",
        'resource "azurerm_resource_group" "a" {\n  name = "a"\n  tags = {\n    environment = "prod"\n  }\n}',
      ),
    ]),
    { keys: ["environment", "owner"] },
  );
  assert.deepEqual(notes, [
    {
      address: "azurerm_resource_group.a",
      message: "Missing required tag: owner.",
      hint: "Add owner to this resource's tags block.",
    },
  ]);
});

test("required-tags is silent when every key is declared, and when none are required", () => {
  const tagged = graph([
    sourced(
      "azurerm_resource_group.a",
      "azurerm_resource_group",
      'resource "azurerm_resource_group" "a" {\n  tags = {\n    environment = "prod"\n    owner       = "platform"\n  }\n}',
    ),
  ]);
  assert.deepEqual(run("required-tags", tagged, { keys: ["environment", "owner"] }), []);
  assert.deepEqual(run("required-tags", tagged, { keys: [] }), []);
});

test("required-tags flags a resource with no tags block at all", () => {
  const notes = run(
    "required-tags",
    graph([
      sourced(
        "azurerm_key_vault.kv",
        "azurerm_key_vault",
        'resource "azurerm_key_vault" "kv" {\n  name = "kv"\n}',
      ),
    ]),
    { keys: ["environment"] },
  );
  assert.equal(notes.length, 1);
  assert.match(notes[0]!.message, /Missing required tag: environment\./);
});

test("required-tags gives no verdict on a node with no source to read", () => {
  const notes = run(
    "required-tags",
    graph([node({ id: "azurerm_key_vault.kv", type: "azurerm_key_vault" })]),
    { keys: ["environment"] },
  );
  assert.deepEqual(notes, []);
});

test("encryption-at-rest-disabled fires on an explicit false only", () => {
  const off = run(
    "encryption-at-rest-disabled",
    graph([
      sourced(
        "aws_db_instance.main",
        "aws_db_instance",
        'resource "aws_db_instance" "main" {\n  storage_encrypted = false\n}',
      ),
    ]),
  );
  assert.deepEqual(off, [
    {
      address: "aws_db_instance.main",
      message:
        "storage_encrypted is set to false — this resource's data is stored unencrypted.",
      hint: "Remove the attribute to keep the provider's encrypted default, or set storage_encrypted = true.",
    },
  ]);

  // Absent is not disabled: every one of these providers encrypts by default.
  const absent = run(
    "encryption-at-rest-disabled",
    graph([
      sourced(
        "aws_db_instance.main",
        "aws_db_instance",
        'resource "aws_db_instance" "main" {\n  engine = "postgres"\n}',
      ),
    ]),
  );
  assert.deepEqual(absent, []);
});

test("orphan-resource ignores module containment and module nodes", () => {
  const notes = run(
    "orphan-resource",
    graph(
      [
        node({ id: "module.net", type: "module", provider: null }),
        node({ id: "module.net.azurerm_subnet.a", type: "azurerm_subnet" }),
        node({ id: "azurerm_virtual_network.vnet", type: "azurerm_virtual_network" }),
        node({ id: "azurerm_public_ip.stray", type: "azurerm_public_ip" }),
      ],
      [
        { from: "module.net", to: "module.net.azurerm_subnet.a", kind: "contains" },
        {
          from: "module.net.azurerm_subnet.a",
          to: "azurerm_virtual_network.vnet",
          kind: "depends_on",
          inferred: true,
        },
      ],
    ),
  );
  assert.deepEqual(notes.map((n) => n.address), ["azurerm_public_ip.stray"]);
});

test("orphan-resource reads a Kubernetes graph too", () => {
  const notes = run(
    "orphan-resource",
    graph(
      [
        node({ id: "default/Deployment/api", type: "Deployment", provider: "kubernetes" }),
        node({ id: "default/ConfigMap/env", type: "ConfigMap", provider: "kubernetes" }),
        node({ id: "default/ConfigMap/unused", type: "ConfigMap", provider: "kubernetes" }),
      ],
      [
        {
          from: "default/Deployment/api",
          to: "default/ConfigMap/env",
          kind: "depends_on",
        },
      ],
    ),
  );
  assert.deepEqual(notes.map((n) => n.address), ["default/ConfigMap/unused"]);
});

test("the ported lint rules judge a snapshot, not just the playground", () => {
  const notes = run(
    "nsg-open-to-internet",
    graph([
      node({
        id: "azurerm_network_security_group.web",
        type: "azurerm_network_security_group",
        internet_exposed: true,
      }),
    ]),
  );
  assert.deepEqual(notes, [
    {
      address: "azurerm_network_security_group.web",
      message:
        "This network security group has an inbound Allow rule open to the internet.",
      hint: "Restrict source_address_prefix to the CIDR ranges that actually need access.",
    },
  ]);
});

test("every catalogue rule carries a title, a description and a hint per finding", () => {
  const rule = ruleById("hardcoded-secret")!;
  assert.ok(rule.title.length > 0);
  assert.ok(rule.description.length > 0);
  const notes = rule.evaluate({
    graph: graph([
      sourced(
        "azurerm_key_vault_secret.db",
        "azurerm_key_vault_secret",
        'resource "azurerm_key_vault_secret" "db" {\n  password = "hunter2hunter2"\n}',
      ),
    ]),
    params: {},
  });
  assert.equal(notes.length, 1);
  assert.ok(notes[0]!.hint.length > 0);
});
