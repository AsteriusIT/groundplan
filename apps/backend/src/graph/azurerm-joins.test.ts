import { test } from "node:test";
import assert from "node:assert/strict";

import { classifyJoins, joinEffects } from "./azurerm-joins.js";
import {
  buildInstancesByBase,
  type DependencySource,
  type EdgeContext,
} from "./dependency-edges.js";

/** Minimal fixture: node ids + types, ctx derived, refs as written in HCL. */
function setup(nodes: Record<string, string>): {
  ctx: EdgeContext;
  typeById: Map<string, string>;
} {
  const resourceIds = new Set(Object.keys(nodes));
  return {
    ctx: {
      resourceIds,
      moduleIds: new Set(),
      instancesByBase: buildInstancesByBase(resourceIds),
    },
    typeById: new Map(Object.entries(nodes)),
  };
}

function source(fromBase: string, ...refs: string[]): DependencySource {
  return {
    fromBase,
    prefix: "",
    refs: refs.map((ref) => ({ ref, inferred: true })),
  };
}

test("subnet_nat_gateway_association contains the NAT gateway in its subnet", () => {
  const { ctx, typeById } = setup({
    "azurerm_nat_gateway.out": "azurerm_nat_gateway",
    "azurerm_subnet.internal": "azurerm_subnet",
    "azurerm_subnet_nat_gateway_association.a":
      "azurerm_subnet_nat_gateway_association",
  });
  const links = classifyJoins(
    [
      source(
        "azurerm_subnet_nat_gateway_association.a",
        "azurerm_nat_gateway.out.id",
        "azurerm_subnet.internal.id",
      ),
    ],
    ctx,
    typeById,
  );
  assert.deepEqual(links, [
    {
      semantic: "contain",
      satelliteId: "azurerm_nat_gateway.out",
      anchorId: "azurerm_subnet.internal",
    },
  ]);
  const fx = joinEffects(links, typeById);
  assert.equal(fx.parents.get("azurerm_nat_gateway.out"), "azurerm_subnet.internal");
  assert.deepEqual(fx.edges, []);
});

test("subnet NSG association attaches the NSG with no extra edge", () => {
  const { ctx, typeById } = setup({
    "azurerm_network_security_group.web": "azurerm_network_security_group",
    "azurerm_subnet.internal": "azurerm_subnet",
    "azurerm_subnet_network_security_group_association.a":
      "azurerm_subnet_network_security_group_association",
  });
  const fx = joinEffects(
    classifyJoins(
      [
        source(
          "azurerm_subnet_network_security_group_association.a",
          "azurerm_network_security_group.web.id",
          "azurerm_subnet.internal.id",
        ),
      ],
      ctx,
      typeById,
    ),
    typeById,
  );
  assert.deepEqual(fx.attachments.get("azurerm_network_security_group.web"), [
    "azurerm_subnet.internal",
  ]);
  assert.deepEqual(fx.edges, []); // the subnet chip carries the relationship
});

test("NIC NSG association attaches AND edges (no chip anchor to ride on)", () => {
  const { ctx, typeById } = setup({
    "azurerm_network_security_group.web": "azurerm_network_security_group",
    "azurerm_network_interface.vm": "azurerm_network_interface",
    "azurerm_network_interface_security_group_association.a":
      "azurerm_network_interface_security_group_association",
  });
  const fx = joinEffects(
    classifyJoins(
      [
        source(
          "azurerm_network_interface_security_group_association.a",
          "azurerm_network_security_group.web.id",
          "azurerm_network_interface.vm.id",
        ),
      ],
      ctx,
      typeById,
    ),
    typeById,
  );
  assert.deepEqual(fx.attachments.get("azurerm_network_security_group.web"), [
    "azurerm_network_interface.vm",
  ]);
  assert.deepEqual(fx.edges, [
    {
      from: "azurerm_network_security_group.web",
      to: "azurerm_network_interface.vm",
    },
  ]);
});

test("NIC backend-pool association collapses to a NIC → pool edge", () => {
  const { ctx, typeById } = setup({
    "azurerm_network_interface.vm": "azurerm_network_interface",
    "azurerm_lb_backend_address_pool.web": "azurerm_lb_backend_address_pool",
    "azurerm_network_interface_backend_address_pool_association.a":
      "azurerm_network_interface_backend_address_pool_association",
  });
  const fx = joinEffects(
    classifyJoins(
      [
        source(
          "azurerm_network_interface_backend_address_pool_association.a",
          "azurerm_network_interface.vm.id",
          "azurerm_lb_backend_address_pool.web.id",
        ),
      ],
      ctx,
      typeById,
    ),
    typeById,
  );
  assert.equal(fx.attachments.size, 0);
  assert.equal(fx.parents.size, 0);
  assert.deepEqual(fx.edges, [
    {
      from: "azurerm_network_interface.vm",
      to: "azurerm_lb_backend_address_pool.web",
    },
  ]);
});

test("vnet peering yields one undirected edge between the two vnets", () => {
  const { ctx, typeById } = setup({
    "azurerm_virtual_network.hub": "azurerm_virtual_network",
    "azurerm_virtual_network.spoke": "azurerm_virtual_network",
    "azurerm_virtual_network_peering.hub_to_spoke": "azurerm_virtual_network_peering",
  });
  const fx = joinEffects(
    classifyJoins(
      [
        source(
          "azurerm_virtual_network_peering.hub_to_spoke",
          "azurerm_virtual_network.hub.name",
          "azurerm_virtual_network.spoke.id",
        ),
      ],
      ctx,
      typeById,
    ),
    typeById,
  );
  assert.equal(fx.edges.length, 1);
});

test("public-IP-prefix association stacks the prefix under the NAT gateway", () => {
  const { ctx, typeById } = setup({
    "azurerm_public_ip_prefix.out": "azurerm_public_ip_prefix",
    "azurerm_nat_gateway.out": "azurerm_nat_gateway",
    "azurerm_nat_gateway_public_ip_prefix_association.a":
      "azurerm_nat_gateway_public_ip_prefix_association",
  });
  const fx = joinEffects(
    classifyJoins(
      [
        source(
          "azurerm_nat_gateway_public_ip_prefix_association.a",
          "azurerm_public_ip_prefix.out.id",
          "azurerm_nat_gateway.out.id",
        ),
      ],
      ctx,
      typeById,
    ),
    typeById,
  );
  assert.equal(fx.parents.get("azurerm_public_ip_prefix.out"), "azurerm_nat_gateway.out");
});

test("a data-disk attachment stacks the disk under its VM", () => {
  const { ctx, typeById } = setup({
    "azurerm_managed_disk.data": "azurerm_managed_disk",
    "azurerm_linux_virtual_machine.app": "azurerm_linux_virtual_machine",
    "azurerm_virtual_machine_data_disk_attachment.a":
      "azurerm_virtual_machine_data_disk_attachment",
  });
  const fx = joinEffects(
    classifyJoins(
      [
        source(
          "azurerm_virtual_machine_data_disk_attachment.a",
          "azurerm_managed_disk.data.id",
          "azurerm_linux_virtual_machine.app.id",
        ),
      ],
      ctx,
      typeById,
    ),
    typeById,
  );
  assert.equal(
    fx.parents.get("azurerm_managed_disk.data"),
    "azurerm_linux_virtual_machine.app",
  );
});

test("a NAT gateway bound to two subnets gets edges, never a guessed parent", () => {
  const { ctx, typeById } = setup({
    "azurerm_nat_gateway.out": "azurerm_nat_gateway",
    "azurerm_subnet.a": "azurerm_subnet",
    "azurerm_subnet.b": "azurerm_subnet",
    "azurerm_subnet_nat_gateway_association.a":
      "azurerm_subnet_nat_gateway_association",
    "azurerm_subnet_nat_gateway_association.b":
      "azurerm_subnet_nat_gateway_association",
  });
  const fx = joinEffects(
    classifyJoins(
      [
        source(
          "azurerm_subnet_nat_gateway_association.a",
          "azurerm_nat_gateway.out.id",
          "azurerm_subnet.a.id",
        ),
        source(
          "azurerm_subnet_nat_gateway_association.b",
          "azurerm_nat_gateway.out.id",
          "azurerm_subnet.b.id",
        ),
      ],
      ctx,
      typeById,
    ),
    typeById,
  );
  assert.equal(fx.parents.size, 0);
  assert.deepEqual(fx.edges, [
    { from: "azurerm_nat_gateway.out", to: "azurerm_subnet.a" },
    { from: "azurerm_nat_gateway.out", to: "azurerm_subnet.b" },
  ]);
});

test("an unknown *_association linking exactly two nodes falls back to an edge", () => {
  const { ctx, typeById } = setup({
    "azurerm_spring_cloud_app.api": "azurerm_spring_cloud_app",
    "azurerm_redis_cache.cache": "azurerm_redis_cache",
    "azurerm_spring_cloud_app_redis_association.a":
      "azurerm_spring_cloud_app_redis_association",
  });
  const fx = joinEffects(
    classifyJoins(
      [
        source(
          "azurerm_spring_cloud_app_redis_association.a",
          "azurerm_spring_cloud_app.api.id",
          "azurerm_redis_cache.cache.id",
        ),
      ],
      ctx,
      typeById,
    ),
    typeById,
  );
  assert.equal(fx.edges.length, 1);
});

test("an unknown *_association with three resolved refs stays untouched", () => {
  const { ctx, typeById } = setup({
    "azurerm_thing.a": "azurerm_thing",
    "azurerm_thing.b": "azurerm_thing",
    "azurerm_thing.c": "azurerm_thing",
    "azurerm_mystery_association.m": "azurerm_mystery_association",
  });
  const fx = joinEffects(
    classifyJoins(
      [
        source(
          "azurerm_mystery_association.m",
          "azurerm_thing.a.id",
          "azurerm_thing.b.id",
          "azurerm_thing.c.id",
        ),
      ],
      ctx,
      typeById,
    ),
    typeById,
  );
  assert.deepEqual(fx.edges, []);
});

test("swift connection edges any app resource to its integration subnet", () => {
  const { ctx, typeById } = setup({
    "azurerm_linux_web_app.site": "azurerm_linux_web_app",
    "azurerm_subnet.integration": "azurerm_subnet",
    "azurerm_app_service_virtual_network_swift_connection.a":
      "azurerm_app_service_virtual_network_swift_connection",
  });
  const fx = joinEffects(
    classifyJoins(
      [
        source(
          "azurerm_app_service_virtual_network_swift_connection.a",
          "azurerm_linux_web_app.site.id",
          "azurerm_subnet.integration.id",
        ),
      ],
      ctx,
      typeById,
    ),
    typeById,
  );
  assert.deepEqual(fx.edges, [
    { from: "azurerm_linux_web_app.site", to: "azurerm_subnet.integration" },
  ]);
});

test("a for_each association expands the satellite over its instances", () => {
  const { ctx, typeById } = setup({
    "azurerm_network_security_group.web": "azurerm_network_security_group",
    'azurerm_subnet.tier["a"]': "azurerm_subnet",
    'azurerm_subnet.tier["b"]': "azurerm_subnet",
    'azurerm_subnet_network_security_group_association.t["a"]':
      "azurerm_subnet_network_security_group_association",
    'azurerm_subnet_network_security_group_association.t["b"]':
      "azurerm_subnet_network_security_group_association",
  });
  // One index-free source (as both producers emit), refs to the subnet base.
  const fx = joinEffects(
    classifyJoins(
      [
        source(
          "azurerm_subnet_network_security_group_association.t",
          "azurerm_network_security_group.web.id",
          "azurerm_subnet.tier.id",
        ),
      ],
      ctx,
      typeById,
    ),
    typeById,
  );
  assert.deepEqual(fx.attachments.get("azurerm_network_security_group.web"), [
    'azurerm_subnet.tier["a"]',
    'azurerm_subnet.tier["b"]',
  ]);
});
