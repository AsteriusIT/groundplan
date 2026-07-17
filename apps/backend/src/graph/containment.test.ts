import { test } from "node:test";
import assert from "node:assert/strict";

import { deriveContainment } from "./containment.js";
import {
  buildInstancesByBase,
  type DependencySource,
  type EdgeContext,
} from "./dependency-edges.js";
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

function ctxFor(nodes: GraphNode[]): EdgeContext {
  const resourceIds = new Set(
    nodes.filter((n) => n.type !== "module").map((n) => n.id),
  );
  return {
    resourceIds,
    moduleIds: new Set(),
    instancesByBase: buildInstancesByBase(resourceIds),
  };
}

test("subnet is contained by the vnet it references", () => {
  const nodes = [
    node("azurerm_virtual_network.main", "azurerm_virtual_network"),
    node("azurerm_subnet.internal", "azurerm_subnet"),
  ];
  const sources: DependencySource[] = [
    {
      fromBase: "azurerm_subnet.internal",
      prefix: "",
      refs: [{ ref: "azurerm_virtual_network.main.name", inferred: true }],
    },
  ];
  deriveContainment(nodes, sources, ctxFor(nodes));
  assert.equal(nodes[1]!.parent_id, "azurerm_virtual_network.main");
  assert.equal(nodes[0]!.parent_id, undefined); // vnet has no parent
});

test("a NIC is contained by the subnet it references", () => {
  const nodes = [
    node("azurerm_subnet.internal", "azurerm_subnet"),
    node("azurerm_network_interface.main", "azurerm_network_interface"),
  ];
  const sources: DependencySource[] = [
    {
      fromBase: "azurerm_network_interface.main",
      prefix: "",
      refs: [{ ref: "azurerm_subnet.internal.id", inferred: true }],
    },
  ];
  deriveContainment(nodes, sources, ctxFor(nodes));
  assert.equal(nodes[1]!.parent_id, "azurerm_subnet.internal");
});

test("a VM referencing only a NIC has no subnet parent", () => {
  const nodes = [
    node("azurerm_network_interface.main", "azurerm_network_interface"),
    node("azurerm_virtual_machine.main", "azurerm_virtual_machine"),
  ];
  const sources: DependencySource[] = [
    {
      fromBase: "azurerm_virtual_machine.main",
      prefix: "",
      refs: [{ ref: "azurerm_network_interface.main.id", inferred: true }],
    },
  ];
  deriveContainment(nodes, sources, ctxFor(nodes));
  assert.equal(nodes[1]!.parent_id, undefined);
});

test("an ambiguous (count) subnet reference yields no parent", () => {
  const nodes = [
    node("azurerm_subnet.extra[0]", "azurerm_subnet"),
    node("azurerm_subnet.extra[1]", "azurerm_subnet"),
    node("azurerm_route_table.rt", "azurerm_route_table"),
  ];
  const sources: DependencySource[] = [
    {
      fromBase: "azurerm_route_table.rt",
      prefix: "",
      refs: [{ ref: "azurerm_subnet.extra", inferred: true }],
    },
  ];
  deriveContainment(nodes, sources, ctxFor(nodes));
  assert.equal(nodes[2]!.parent_id, undefined);
});

test("containment resolves under a module prefix", () => {
  const nodes = [
    node("module.net.azurerm_virtual_network.main", "azurerm_virtual_network"),
    node("module.net.azurerm_subnet.internal", "azurerm_subnet"),
  ];
  const sources: DependencySource[] = [
    {
      fromBase: "module.net.azurerm_subnet.internal",
      prefix: "module.net.",
      refs: [{ ref: "azurerm_virtual_network.main.name", inferred: true }],
    },
  ];
  deriveContainment(nodes, sources, ctxFor(nodes));
  assert.equal(
    nodes[1]!.parent_id,
    "module.net.azurerm_virtual_network.main",
  );
});

// --- GP-86: satellite stacking (resource → host) --------------------------

/** Every LB satellite type nests under the load balancer it references (forward). */
for (const satellite of [
  "azurerm_lb_probe",
  "azurerm_lb_backend_address_pool",
  "azurerm_lb_rule",
  "azurerm_lb_nat_rule",
  "azurerm_lb_outbound_rule",
]) {
  test(`${satellite} nests under the load balancer it references`, () => {
    const nodes = [
      node("azurerm_lb.main", "azurerm_lb"),
      node(`${satellite}.x`, satellite),
    ];
    const sources: DependencySource[] = [
      {
        fromBase: `${satellite}.x`,
        prefix: "",
        refs: [{ ref: "azurerm_lb.main.id", inferred: true }],
      },
    ];
    deriveContainment(nodes, sources, ctxFor(nodes));
    assert.equal(nodes[1]!.parent_id, "azurerm_lb.main");
  });
}

/** A public IP is stacked under the one host that references it (reverse). */
for (const host of [
  "azurerm_application_gateway",
  "azurerm_bastion_host",
  "azurerm_nat_gateway",
  "azurerm_lb",
]) {
  test(`a public IP nests under the ${host} that references it`, () => {
    const nodes = [
      node("azurerm_public_ip.ip", "azurerm_public_ip"),
      node(`${host}.main`, host),
    ];
    const sources: DependencySource[] = [
      {
        fromBase: `${host}.main`,
        prefix: "",
        refs: [{ ref: "azurerm_public_ip.ip.id", inferred: true }],
      },
    ];
    deriveContainment(nodes, sources, ctxFor(nodes));
    assert.equal(nodes[0]!.parent_id, `${host}.main`);
  });
}

test("a NIC nests under the linux VM that references it, not its subnet", () => {
  const nodes = [
    node("azurerm_subnet.internal", "azurerm_subnet"),
    node("azurerm_network_interface.main", "azurerm_network_interface"),
    node("azurerm_linux_virtual_machine.main", "azurerm_linux_virtual_machine"),
  ];
  const sources: DependencySource[] = [
    {
      fromBase: "azurerm_network_interface.main",
      prefix: "",
      refs: [{ ref: "azurerm_subnet.internal.id", inferred: true }],
    },
    {
      fromBase: "azurerm_linux_virtual_machine.main",
      prefix: "",
      refs: [{ ref: "azurerm_network_interface.main.id", inferred: true }],
    },
  ];
  deriveContainment(nodes, sources, ctxFor(nodes));
  // The satellite rule (NIC → VM) wins over the generic subnet rule.
  assert.equal(nodes[1]!.parent_id, "azurerm_linux_virtual_machine.main");
});

test("a NIC referenced by a windows VM nests under it too", () => {
  const nodes = [
    node("azurerm_network_interface.main", "azurerm_network_interface"),
    node("azurerm_windows_virtual_machine.main", "azurerm_windows_virtual_machine"),
  ];
  const sources: DependencySource[] = [
    {
      fromBase: "azurerm_windows_virtual_machine.main",
      prefix: "",
      refs: [{ ref: "azurerm_network_interface.main.id", inferred: true }],
    },
  ];
  deriveContainment(nodes, sources, ctxFor(nodes));
  assert.equal(nodes[0]!.parent_id, "azurerm_windows_virtual_machine.main");
});

test("a satellite rule wins over the generic subnet rule", () => {
  // A probe references both its LB (present) and a subnet — it stacks under the LB.
  const nodes = [
    node("azurerm_subnet.internal", "azurerm_subnet"),
    node("azurerm_lb.main", "azurerm_lb"),
    node("azurerm_lb_probe.https", "azurerm_lb_probe"),
  ];
  const sources: DependencySource[] = [
    {
      fromBase: "azurerm_lb_probe.https",
      prefix: "",
      refs: [
        { ref: "azurerm_lb.main.id", inferred: true },
        { ref: "azurerm_subnet.internal.id", inferred: true },
      ],
    },
  ];
  deriveContainment(nodes, sources, ctxFor(nodes));
  assert.equal(nodes[2]!.parent_id, "azurerm_lb.main");
});

test("an ambiguous public IP (two host referrers) stays unstacked", () => {
  const nodes = [
    node("azurerm_public_ip.shared", "azurerm_public_ip"),
    node("azurerm_lb.a", "azurerm_lb"),
    node("azurerm_nat_gateway.b", "azurerm_nat_gateway"),
  ];
  const sources: DependencySource[] = [
    {
      fromBase: "azurerm_lb.a",
      prefix: "",
      refs: [{ ref: "azurerm_public_ip.shared.id", inferred: true }],
    },
    {
      fromBase: "azurerm_nat_gateway.b",
      prefix: "",
      refs: [{ ref: "azurerm_public_ip.shared.id", inferred: true }],
    },
  ];
  deriveContainment(nodes, sources, ctxFor(nodes));
  // Two candidates ⇒ determinism over completeness: it stays where it is.
  assert.equal(nodes[0]!.parent_id, undefined);
});

test("a probe whose LB is absent falls back to today's behaviour (subnet)", () => {
  const nodes = [
    node("azurerm_subnet.internal", "azurerm_subnet"),
    node("azurerm_lb_probe.https", "azurerm_lb_probe"),
  ];
  const sources: DependencySource[] = [
    {
      fromBase: "azurerm_lb_probe.https",
      prefix: "",
      refs: [
        { ref: "azurerm_lb.gone.id", inferred: true }, // LB not in the graph
        { ref: "azurerm_subnet.internal.id", inferred: true },
      ],
    },
  ];
  deriveContainment(nodes, sources, ctxFor(nodes));
  assert.equal(nodes[1]!.parent_id, "azurerm_subnet.internal");
});

test("a probe whose LB is absent and referencing no subnet keeps no parent", () => {
  const nodes = [node("azurerm_lb_probe.https", "azurerm_lb_probe")];
  const sources: DependencySource[] = [
    {
      fromBase: "azurerm_lb_probe.https",
      prefix: "",
      refs: [{ ref: "azurerm_lb.gone.id", inferred: true }],
    },
  ];
  deriveContainment(nodes, sources, ctxFor(nodes));
  assert.equal(nodes[0]!.parent_id, undefined);
});

/** The full demo estate from the epic screenshot, golden-asserted end to end. */
function demoEstate(): { nodes: GraphNode[]; sources: DependencySource[] } {
  const nodes = [
    node("azurerm_virtual_network.main", "azurerm_virtual_network"),
    node("azurerm_subnet.internal", "azurerm_subnet"),
    node("azurerm_lb.main", "azurerm_lb"),
    node("azurerm_lb_probe.https", "azurerm_lb_probe"),
    node("azurerm_lb_backend_address_pool.pool", "azurerm_lb_backend_address_pool"),
    node("azurerm_lb_rule.http", "azurerm_lb_rule"),
    node("azurerm_application_gateway.appgw", "azurerm_application_gateway"),
    node("azurerm_public_ip.appgw", "azurerm_public_ip"),
    node("azurerm_bastion_host.bastion", "azurerm_bastion_host"),
    node("azurerm_public_ip.bastion", "azurerm_public_ip"),
    node("azurerm_linux_virtual_machine.vm", "azurerm_linux_virtual_machine"),
    node("azurerm_network_interface.nic", "azurerm_network_interface"),
  ];
  const ref = (r: string) => ({ ref: r, inferred: true });
  const sources: DependencySource[] = [
    { fromBase: "azurerm_subnet.internal", prefix: "", refs: [ref("azurerm_virtual_network.main.name")] },
    { fromBase: "azurerm_lb.main", prefix: "", refs: [ref("azurerm_subnet.internal.id")] },
    { fromBase: "azurerm_lb_probe.https", prefix: "", refs: [ref("azurerm_lb.main.id")] },
    { fromBase: "azurerm_lb_backend_address_pool.pool", prefix: "", refs: [ref("azurerm_lb.main.id")] },
    { fromBase: "azurerm_lb_rule.http", prefix: "", refs: [ref("azurerm_lb.main.id")] },
    { fromBase: "azurerm_application_gateway.appgw", prefix: "", refs: [ref("azurerm_subnet.internal.id"), ref("azurerm_public_ip.appgw.id")] },
    { fromBase: "azurerm_bastion_host.bastion", prefix: "", refs: [ref("azurerm_subnet.internal.id"), ref("azurerm_public_ip.bastion.id")] },
    { fromBase: "azurerm_linux_virtual_machine.vm", prefix: "", refs: [ref("azurerm_network_interface.nic.id")] },
    { fromBase: "azurerm_network_interface.nic", prefix: "", refs: [ref("azurerm_subnet.internal.id")] },
  ];
  return { nodes, sources };
}

test("the demo estate produces the full stacked parent_id map", () => {
  const { nodes, sources } = demoEstate();
  deriveContainment(nodes, sources, ctxFor(nodes));
  const map = Object.fromEntries(nodes.map((n) => [n.id, n.parent_id ?? null]));
  assert.deepEqual(map, {
    "azurerm_virtual_network.main": null,
    "azurerm_subnet.internal": "azurerm_virtual_network.main",
    "azurerm_lb.main": "azurerm_subnet.internal",
    "azurerm_lb_probe.https": "azurerm_lb.main",
    "azurerm_lb_backend_address_pool.pool": "azurerm_lb.main",
    "azurerm_lb_rule.http": "azurerm_lb.main",
    "azurerm_application_gateway.appgw": "azurerm_subnet.internal",
    "azurerm_public_ip.appgw": "azurerm_application_gateway.appgw",
    "azurerm_bastion_host.bastion": "azurerm_subnet.internal",
    "azurerm_public_ip.bastion": "azurerm_bastion_host.bastion",
    "azurerm_linux_virtual_machine.vm": null,
    "azurerm_network_interface.nic": "azurerm_linux_virtual_machine.vm",
  });
});

test("every containment chain is acyclic and at most resource → host → subnet → vnet", () => {
  const { nodes, sources } = demoEstate();
  deriveContainment(nodes, sources, ctxFor(nodes));
  const parentOf = new Map(nodes.map((n) => [n.id, n.parent_id]));
  for (const start of nodes) {
    const seen = new Set<string>();
    let current: string | undefined = start.id;
    let depth = 0;
    while (current !== undefined) {
      assert.ok(!seen.has(current), `cycle through ${current}`);
      seen.add(current);
      current = parentOf.get(current);
      depth += 1;
      assert.ok(depth <= 4, `chain from ${start.id} deeper than 4`);
    }
  }
});
