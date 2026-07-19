import { expect, it } from "vitest";
import ELK from "elkjs/lib/elk.bundled.js";

import type { Graph } from "../types";
import { networkProjection, toElkGraph, type ElkGraphNode } from "./graph-layout";

/**
 * Layout smoke test against REAL elkjs — the pure-mapping unit tests cannot
 * catch a layout option that makes ELK itself throw (which the canvas swallows,
 * leaving a stale, scattered diagram). This graph mirrors the estate shape that
 * broke: vnet ⊃ CIDR'd subnets, a stacked host, chips, and edges into subnets.
 */
function estateShapedGraph(): Graph {
  const n = (id: string, type: string, over: Partial<Graph["nodes"][number]> = {}) => ({
    id, name: id, type, provider: "azurerm" as const, module_path: [] as string[], change: null, ...over,
  });
  return {
    version: 7,
    nodes: [
      n("vnet", "azurerm_virtual_network", { attributes: { address_space: "10.0.0.0/16" } }),
      n("s1", "azurerm_subnet", { parent_id: "vnet", attributes: { address_prefixes: "10.0.2.0/24" } }),
      n("s2", "azurerm_subnet", { parent_id: "vnet", attributes: { address_prefixes: "10.0.1.0/24" } }),
      n("s3", "azurerm_subnet", { parent_id: "vnet" }),
      n("nat", "azurerm_nat_gateway", { parent_id: "vnet" }),
      n("vm", "azurerm_linux_virtual_machine", { parent_id: "s2" }),
      n("nic", "azurerm_network_interface", { parent_id: "vm" }),
      n("avset", "azurerm_availability_set", { associated_ids: ["vm"] }),
      n("nsg", "azurerm_network_security_group", { associated_ids: ["s1"] }),
    ],
    edges: [
      { from: "nat", to: "s1", kind: "depends_on", inferred: true },
      { from: "nat", to: "s2", kind: "depends_on", inferred: true },
      { from: "vm", to: "nic", kind: "depends_on", inferred: true },
    ],
  };
}

it("real ELK lays out the projected estate with nested, positioned containers", async () => {
  const { graph: projected, containerIds, stacks, chips } = networkProjection(estateShapedGraph());
  const input = toElkGraph(projected, undefined, containerIds, stacks, chips);
  // Must not reject — a swallowed rejection renders as a scattered stale layout.
  const result = (await new ELK().layout(input)) as ElkGraphNode;
  const vnet = result.children?.find((c) => c.id === "vnet");
  const childIds = vnet?.children?.map((c) => c.id) ?? [];
  expect(childIds).toEqual(expect.arrayContaining(["s1", "s2", "s3", "nat"]));
  // Every laid-out child carries real coordinates inside its parent.
  for (const child of vnet?.children ?? []) {
    expect(child.x, `${child.id} x`).toBeTypeOf("number");
    expect(child.y, `${child.id} y`).toBeTypeOf("number");
  }
}, 30000);
