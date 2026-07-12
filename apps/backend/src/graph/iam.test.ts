import { test } from "node:test";
import assert from "node:assert/strict";

import { attachIam, isBroadScope, isHighPrivilegeRole } from "./iam.js";
import type { GraphNode } from "./graph.js";

function node(id: string, type: string): GraphNode {
  return {
    id,
    name: id.split(".").pop()!,
    type,
    provider: "azurerm",
    module_path: [],
    change: null,
  };
}

test("isHighPrivilegeRole matches Owner/Contributor/UAA and any *Admin* (case-insensitive)", () => {
  for (const role of [
    "Owner",
    "Contributor",
    "User Access Administrator",
    "owner",
    "  contributor  ",
    "Network Admin",
    "Key Vault Administrator",
  ]) {
    assert.equal(isHighPrivilegeRole(role), true, role);
  }
});

test("isHighPrivilegeRole is false for narrow, non-admin roles", () => {
  for (const role of ["Reader", "AcrPull", "Storage Blob Data Reader"]) {
    assert.equal(isHighPrivilegeRole(role), false, role);
  }
});

test("isBroadScope: a scope resolving to an RG/subscription node is broad; a resource is not", () => {
  const typeById = new Map([
    ["azurerm_resource_group.main", "azurerm_resource_group"],
    ["azurerm_container_registry.main", "azurerm_container_registry"],
  ]);
  assert.equal(isBroadScope("azurerm_resource_group.main", typeById), true);
  assert.equal(isBroadScope("azurerm_container_registry.main", typeById), false);
});

test("isBroadScope: raw subscription / resource-group ids are broad; anything narrower is not", () => {
  const none = new Map<string, string>();
  assert.equal(isBroadScope("/subscriptions/abc", none), true);
  assert.equal(isBroadScope("/subscriptions/abc/resourceGroups/rg1", none), true);
  // Casing of the resourceGroups segment varies across Azure ids.
  assert.equal(isBroadScope("/subscriptions/abc/resourcegroups/rg1", none), true);
  assert.equal(
    isBroadScope(
      "/subscriptions/abc/resourceGroups/rg1/providers/Microsoft.ContainerRegistry/registries/acr",
      none,
    ),
    false,
  );
  assert.equal(isBroadScope("azurerm_container_registry.main", none), false);
});

test("attachIam sets role_assignment + a privileged flag and identity payloads", () => {
  const nodes: GraphNode[] = [
    node("azurerm_role_assignment.owner", "azurerm_role_assignment"),
    node("azurerm_resource_group.main", "azurerm_resource_group"),
    node("azurerm_user_assigned_identity.app", "azurerm_user_assigned_identity"),
  ];
  attachIam(
    nodes,
    new Map([
      [
        "azurerm_role_assignment.owner",
        {
          role: {
            role: "Owner",
            principal: "azurerm_user_assigned_identity.app",
            scope: "azurerm_resource_group.main",
          },
        },
      ],
      ["azurerm_user_assigned_identity.app", { identity: { type: "UserAssigned" } }],
    ]),
  );
  assert.deepEqual(nodes[0]!.role_assignment, {
    role: "Owner",
    principal: "azurerm_user_assigned_identity.app",
    scope: "azurerm_resource_group.main",
  });
  assert.equal(nodes[0]!.privileged, true); // Owner at RG scope
  assert.deepEqual(nodes[2]!.identity, { type: "UserAssigned" });
});

test("attachIam leaves a high-priv role at narrow scope not privileged", () => {
  const nodes: GraphNode[] = [
    node("azurerm_role_assignment.pull", "azurerm_role_assignment"),
    node("azurerm_container_registry.main", "azurerm_container_registry"),
  ];
  attachIam(
    nodes,
    new Map([
      [
        "azurerm_role_assignment.pull",
        {
          role: {
            role: "AcrPull",
            principal: "some-object-id",
            scope: "azurerm_container_registry.main",
          },
        },
      ],
    ]),
  );
  assert.equal(nodes[0]!.privileged, false); // narrow role AND narrow scope
});
