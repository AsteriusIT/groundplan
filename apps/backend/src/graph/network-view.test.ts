import assert from "node:assert/strict";
import { test } from "node:test";

import { drawioNodeWidth, renderDrawio } from "./drawio.js";
import type { Graph, GraphNode } from "./graph.js";
import { layoutGraph } from "./layout.js";
import { networkViewGraph } from "./network-view.js";

const node = (id: string, type: string, extra: Partial<GraphNode> = {}): GraphNode => ({
  id,
  name: id.split(".").at(-1)!,
  type,
  provider: type.startsWith("azurerm_") ? "azurerm" : null,
  module_path: [],
  change: null,
  ...extra,
});

// A realistic slice: vnet ⊃ {web, data} subnets with a vm and a db, an NSG
// associated to the web subnet, an association join, a module container, and
// an app resource outside the network.
const GRAPH: Graph = {
  version: 4,
  nodes: [
    node("azurerm_virtual_network.main", "azurerm_virtual_network"),
    node("azurerm_subnet.web", "azurerm_subnet", { parent_id: "azurerm_virtual_network.main" }),
    node("azurerm_subnet.data", "azurerm_subnet", { parent_id: "azurerm_virtual_network.main" }),
    node("azurerm_linux_virtual_machine.vm", "azurerm_linux_virtual_machine", { parent_id: "azurerm_subnet.web" }),
    node("azurerm_postgresql_flexible_server.db", "azurerm_postgresql_flexible_server", { parent_id: "azurerm_subnet.data" }),
    node("azurerm_network_security_group.web", "azurerm_network_security_group", {
      internet_exposed: true,
      associated_ids: ["azurerm_subnet.web"],
    }),
    node("azurerm_subnet_network_security_group_association.web", "azurerm_subnet_network_security_group_association"),
    node("module.net", "module", { provider: null }),
    node("azurerm_key_vault.kv", "azurerm_key_vault"),
  ],
  edges: [
    { from: "azurerm_subnet.web", to: "azurerm_virtual_network.main", kind: "depends_on" },
    { from: "azurerm_linux_virtual_machine.vm", to: "azurerm_subnet.web", kind: "depends_on" },
    { from: "azurerm_linux_virtual_machine.vm", to: "azurerm_postgresql_flexible_server.db", kind: "depends_on" },
    { from: "azurerm_network_security_group.web", to: "azurerm_subnet.web", kind: "depends_on" },
    { from: "azurerm_key_vault.kv", to: "azurerm_linux_virtual_machine.vm", kind: "depends_on" },
  ],
};

test("keeps network structure and drops modules, plumbing and non-network resources", () => {
  const projected = networkViewGraph(GRAPH);
  const ids = new Set(projected.nodes.map((n) => n.id));

  assert.ok(ids.has("azurerm_virtual_network.main"));
  assert.ok(ids.has("azurerm_subnet.web"));
  assert.ok(ids.has("azurerm_linux_virtual_machine.vm")); // has a parent_id
  assert.ok(!ids.has("module.net")); // modules never appear
  assert.ok(!ids.has("azurerm_subnet_network_security_group_association.web")); // plumbing
  assert.ok(!ids.has("azurerm_key_vault.kv")); // not network, no parent
});

test("parent_id containment becomes contains edges for vnet/subnet containers", () => {
  const projected = networkViewGraph(GRAPH);
  const contains = projected.edges.filter((e) => e.kind === "contains");
  assert.deepEqual(
    contains.map((e) => `${e.from}>${e.to}`).sort(),
    [
      "azurerm_subnet.data>azurerm_postgresql_flexible_server.db",
      "azurerm_subnet.web>azurerm_linux_virtual_machine.vm",
      "azurerm_virtual_network.main>azurerm_subnet.data",
      "azurerm_virtual_network.main>azurerm_subnet.web",
    ],
  );
});

test("depends_on edges duplicating containment are hidden, like the canvas", () => {
  const projected = networkViewGraph(GRAPH);
  const deps = projected.edges.filter((e) => e.kind === "depends_on");
  // subnet→vnet and vm→subnet restate the nesting; the NSG edge went with its
  // chip; the kv edge lost its endpoint. Only the cross-subnet vm→db survives.
  assert.deepEqual(
    deps.map((e) => `${e.from}>${e.to}`),
    ["azurerm_linux_virtual_machine.vm>azurerm_postgresql_flexible_server.db"],
  );
});

test("an associated NSG folds into its anchor: label + exposure, no floating node", () => {
  const projected = networkViewGraph(GRAPH);
  const ids = new Set(projected.nodes.map((n) => n.id));
  assert.ok(!ids.has("azurerm_network_security_group.web")); // a chip, not a node

  const subnet = projected.nodes.find((n) => n.id === "azurerm_subnet.web")!;
  assert.equal(subnet.internet_exposed, true); // exposure propagated
  assert.equal(subnet.display_label, "web · NSG web"); // the chip's name rides along
});

test("the projection renders to draw.io with real network containers", async () => {
  const projected = networkViewGraph(GRAPH);
  const laidOut = await layoutGraph(projected, {
    nodeWidth: drawioNodeWidth,
    nestAllContains: true,
  });
  const xml = renderDrawio(projected, laidOut, {
    repoName: "acme/infra",
    ref: "main",
    sha: "abcd1234",
    date: "2026-07-21",
  });

  // The vnet is a collapsible container, labelled as a resource — never "module.".
  const vnet = xml.slice(xml.indexOf('id="azurerm_virtual_network.main"'));
  const vnetCell = vnet.slice(0, vnet.indexOf("</object>"));
  assert.ok(vnetCell.includes("container=1;"));
  assert.ok(!vnetCell.includes("module."));
  // The vm cell is parented inside the subnet container.
  const vm = xml.slice(xml.indexOf('id="azurerm_linux_virtual_machine.vm"'));
  assert.ok(vm.slice(0, vm.indexOf("</mxCell>")).includes('parent="azurerm_subnet.web"'));
  // The exposed subnet carries the exposed stroke and its NSG chip label.
  const subnet = xml.slice(xml.indexOf('id="azurerm_subnet.web"'));
  const subnetCell = subnet.slice(0, subnet.indexOf("</object>"));
  assert.ok(subnetCell.includes("strokeColor=#d4531e;"));
  assert.ok(subnetCell.includes("NSG web"));
  // Exactly one dependency arrow: vm → db. No NSG or containment edges.
  assert.equal((xml.match(/edge="1"/g) ?? []).length, 1);
});
