/**
 * The demo topology of GP-131 — resource group → vnet → subnet → NIC → VM —
 * shared by the validation, generation and golden-invariant tests so all three
 * judge the same composition.
 */
import type { BuilderGraph, BuilderNode } from "../builder-graph.js";

/** A node of `type` with the attributes a valid one needs, minus what a test drops. */
export function node(
  id: string,
  type: string,
  name: string,
  attributes: BuilderNode["attributes"] = {},
): BuilderNode {
  return { id, type, name, attributes, position: { x: 0, y: 0 } };
}

/** The demo topology of GP-131: resource group → vnet → subnet → NIC → VM. */
export function demoGraph(): BuilderGraph {
  return {
    nodes: [
      node("rg", "azurerm_resource_group", "this", {
        name: "rg-demo",
        location: "westeurope",
      }),
      node("vnet", "azurerm_virtual_network", "this", {
        name: "vnet-demo",
        location: "westeurope",
        address_space: ["10.0.0.0/16"],
      }),
      node("snet", "azurerm_subnet", "app", {
        name: "snet-app",
        address_prefixes: ["10.0.1.0/24"],
      }),
      node("nic", "azurerm_network_interface", "app", {
        name: "nic-app",
        location: "westeurope",
      }),
      node("vm", "azurerm_linux_virtual_machine", "app", {
        name: "vm-app-01",
        location: "westeurope",
        size: "Standard_B2s",
        admin_username: "azureuser",
      }),
    ],
    references: [
      { from: "vnet", to: "rg", attribute: "resource_group_name" },
      { from: "snet", to: "rg", attribute: "resource_group_name" },
      { from: "snet", to: "vnet", attribute: "virtual_network_name" },
      { from: "nic", to: "rg", attribute: "resource_group_name" },
      { from: "nic", to: "snet", attribute: "subnet_id" },
      { from: "vm", to: "rg", attribute: "resource_group_name" },
      { from: "vm", to: "nic", attribute: "network_interface_ids" },
    ],
  };
}

