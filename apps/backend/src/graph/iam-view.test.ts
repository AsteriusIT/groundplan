import assert from "node:assert/strict";
import { test } from "node:test";

import type { Graph, GraphNode } from "./graph.js";
import { iamViewGraph } from "./iam-view.js";

const node = (id: string, type: string, extra: Partial<GraphNode> = {}): GraphNode => ({
  id,
  name: id.split(".").at(-1)!,
  type,
  provider: "azurerm",
  module_path: [],
  change: null,
  ...extra,
});

const GRAPH: Graph = {
  version: 4,
  nodes: [
    node("azurerm_user_assigned_identity.app", "azurerm_user_assigned_identity"),
    node("azurerm_key_vault.kv", "azurerm_key_vault"),
    node("azurerm_role_assignment.kv_reader", "azurerm_role_assignment", {
      role_assignment: {
        role: "Key Vault Secrets User",
        principal: "azurerm_user_assigned_identity.app",
        scope: "azurerm_key_vault.kv",
      },
    }),
    node("azurerm_role_assignment.owner", "azurerm_role_assignment", {
      privileged: true,
      role_assignment: {
        role: "Owner",
        principal: "11111111-2222-3333-4444-555555555555",
        scope: "/subscriptions/sub-id",
      },
    }),
    node("azurerm_storage_account.data", "azurerm_storage_account"), // no assignment — dropped
  ],
  edges: [],
};

test("only grant participants appear; assignments become labelled edges", () => {
  const projected = iamViewGraph(GRAPH);
  const ids = new Set(projected.nodes.map((n) => n.id));

  assert.ok(ids.has("azurerm_user_assigned_identity.app")); // real node, carried over
  assert.ok(ids.has("azurerm_key_vault.kv"));
  assert.ok(!ids.has("azurerm_storage_account.data")); // not part of any grant
  assert.ok(!ids.has("azurerm_role_assignment.kv_reader")); // the assignment IS the edge

  const edge = projected.edges.find((e) => e.label === "Key Vault Secrets User")!;
  assert.ok(edge, "grant edge missing");
  // Emitted scope→principal so the converter's GP-31 reversal draws the arrow
  // principal → scope, reading "principal is granted role on scope".
  assert.equal(edge.from, "azurerm_key_vault.kv");
  assert.equal(edge.to, "azurerm_user_assigned_identity.app");
});

test("unresolved principals/scopes become synthetic nodes; privileged is called out", () => {
  const projected = iamViewGraph(GRAPH);
  const byId = new Map(projected.nodes.map((n) => [n.id, n]));

  const principal = byId.get("11111111-2222-3333-4444-555555555555")!;
  assert.equal(principal.type, "principal");
  const scope = byId.get("/subscriptions/sub-id")!;
  assert.equal(scope.type, "scope");

  const owner = projected.edges.find((e) => e.label?.startsWith("Owner"))!;
  assert.ok(owner.label!.includes("privileged"));
});

test("a graph with no assignments projects to an empty graph", () => {
  const empty = iamViewGraph({ version: 4, nodes: [node("azurerm_key_vault.kv", "azurerm_key_vault")], edges: [] });
  assert.equal(empty.nodes.length, 0);
  assert.equal(empty.edges.length, 0);
});
