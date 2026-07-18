import { test } from "node:test";
import assert from "node:assert/strict";

import { attachAssociations, attachNsg, computeInternetExposed, normalizePorts } from "./nsg.js";
import type { GraphNode, NsgRule } from "./graph.js";

function rule(p: Partial<NsgRule> = {}): NsgRule {
  return {
    name: "r",
    priority: 100,
    direction: "Inbound",
    access: "Allow",
    protocol: "Tcp",
    ports: "*",
    source: "*",
    destination: "*",
    ...p,
  };
}

test("internet_exposed is true for an inbound Allow from an internet source", () => {
  for (const source of ["*", "0.0.0.0/0", "Internet", "internet"]) {
    assert.equal(computeInternetExposed([rule({ source })]), true, source);
  }
});

test("internet_exposed is false for specific CIDR / outbound / deny / empty", () => {
  assert.equal(computeInternetExposed([rule({ source: "10.0.0.0/8" })]), false);
  assert.equal(computeInternetExposed([rule({ source: "*", direction: "Outbound" })]), false);
  assert.equal(computeInternetExposed([rule({ source: "*", access: "Deny" })]), false);
  assert.equal(computeInternetExposed([]), false);
});

test("normalizePorts renders single, range, any, and numbers", () => {
  assert.equal(normalizePorts("80"), "80");
  assert.equal(normalizePorts("80-443"), "80-443");
  assert.equal(normalizePorts("*"), "*");
  assert.equal(normalizePorts(443), "443");
  assert.equal(normalizePorts(undefined), "*");
  assert.equal(normalizePorts(""), "*");
});

test("attachNsg sets sorted rules and internet_exposed", () => {
  const nodes: GraphNode[] = [
    { id: "nsg", name: "nsg", type: "azurerm_network_security_group", provider: "azurerm", module_path: [], change: null },
  ];
  attachNsg(nodes, new Map([
    ["nsg", {
      rules: [rule({ name: "b", priority: 200, source: "10.0.0.0/8" }), rule({ name: "a", priority: 100, source: "Internet" })],
    }],
  ]));
  assert.deepEqual(nodes[0]!.rules?.map((r) => r.name), ["a", "b"]); // sorted by priority
  assert.equal(nodes[0]!.internet_exposed, true);
});

test("attachAssociations sets deduped, sorted associated_ids on any satellite", () => {
  const nodes: GraphNode[] = [
    { id: "nsg", name: "nsg", type: "azurerm_network_security_group", provider: "azurerm", module_path: [], change: null },
  ];
  attachAssociations(nodes, new Map([["nsg", ["sub2", "sub1", "sub1"]]]));
  assert.deepEqual(nodes[0]!.associated_ids, ["sub1", "sub2"]);
});
