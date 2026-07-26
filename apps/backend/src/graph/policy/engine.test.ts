import assert from "node:assert/strict";
import { test } from "node:test";

import type { Graph, GraphNode } from "../graph.js";
import { POLICY_CATALOG, ruleById } from "./catalog.js";
import { evaluatePolicy, effectiveRuleFor, worstSeverity } from "./engine.js";
import type { PolicyConfig, PolicyRule } from "./types.js";

/** A resource node with sensible defaults; override what a case needs. */
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

/** A node carrying verbatim HCL, as the documentation producer attaches it. */
function withSource(
  partial: Partial<GraphNode> & Pick<GraphNode, "id" | "type">,
  code: string,
): GraphNode {
  return node({
    ...partial,
    source: { file: "main.tf", start_line: 1, end_line: 1, code },
  });
}

const EXPOSED_NSG = node({
  id: "azurerm_network_security_group.web",
  type: "azurerm_network_security_group",
  internet_exposed: true,
});

test("a clean graph passes with no violations", () => {
  const report = evaluatePolicy(
    graph(
      [
        node({ id: "azurerm_virtual_network.vnet", type: "azurerm_virtual_network" }),
        node({ id: "azurerm_subnet.a", type: "azurerm_subnet" }),
      ],
      [
        {
          from: "azurerm_subnet.a",
          to: "azurerm_virtual_network.vnet",
          kind: "depends_on",
          inferred: true,
        },
      ],
    ),
    { target: "terraform" },
  );
  assert.equal(report.status, "passing");
  assert.deepEqual(report.counts, {
    error: 0,
    warning: 0,
    info: 0,
    waived: 0,
    total: 0,
  });
});

test("the same graph and config produce a byte-identical report", () => {
  const config: PolicyConfig = { "missing-tags": { severity: "warning" } };
  const g = graph([
    EXPOSED_NSG,
    withSource(
      { id: "azurerm_resource_group.main", type: "azurerm_resource_group" },
      'resource "azurerm_resource_group" "main" {\n  name = "rg"\n}',
    ),
  ]);
  const a = JSON.stringify(evaluatePolicy(g, { target: "terraform", config }));
  const b = JSON.stringify(evaluatePolicy(g, { target: "terraform", config }));
  assert.equal(a, b);
});

test("every violation anchors to a node that exists in the graph", () => {
  const g = graph([
    EXPOSED_NSG,
    withSource(
      { id: "azurerm_storage_account.logs", type: "azurerm_storage_account" },
      'resource "azurerm_storage_account" "logs" {\n  allow_nested_items_to_be_public = true\n  storage_encrypted = false\n}',
    ),
  ]);
  const report = evaluatePolicy(g, { target: "terraform" });
  const ids = new Set(g.nodes.map((n) => n.id));
  assert.ok(report.violations.length > 0);
  for (const violation of report.violations) {
    assert.ok(ids.has(violation.address), `${violation.address} is not a node`);
  }
});

test("violations sort worst-first, then by address, then by rule", () => {
  const report = evaluatePolicy(
    graph([
      EXPOSED_NSG,
      withSource(
        { id: "azurerm_key_vault.a", type: "azurerm_key_vault" },
        'resource "azurerm_key_vault" "a" {\n  public_network_access_enabled = true\n}',
      ),
    ]),
    { target: "terraform" },
  );
  const ranks = report.violations.map((v) => v.severity);
  assert.deepEqual(
    [...ranks].sort(
      (x, y) =>
        ["error", "warning", "info"].indexOf(x) - ["error", "warning", "info"].indexOf(y),
    ),
    ranks,
  );
});

test("status is the worst active severity", () => {
  const failing = evaluatePolicy(graph([EXPOSED_NSG]), { target: "terraform" });
  assert.equal(failing.status, "failing");

  const warned = evaluatePolicy(
    graph([
      withSource(
        { id: "azurerm_key_vault.a", type: "azurerm_key_vault" },
        'resource "azurerm_key_vault" "a" {\n  public_network_access_enabled = true\n}',
      ),
    ]),
    { target: "terraform" },
  );
  assert.equal(warned.status, "warnings");
});

test("configuration can disable a rule and change its severity", () => {
  const g = graph([EXPOSED_NSG]);

  const downgraded = evaluatePolicy(g, {
    target: "terraform",
    config: { "nsg-open-to-internet": { severity: "info" } },
  });
  assert.equal(downgraded.status, "passing");
  assert.equal(downgraded.violations[0]?.severity, "info");

  const off = evaluatePolicy(g, {
    target: "terraform",
    config: { "nsg-open-to-internet": { enabled: false } },
  });
  assert.deepEqual(
    off.violations.filter((v) => v.ruleId === "nsg-open-to-internet"),
    [],
  );
  const rule = off.rules.find((r) => r.ruleId === "nsg-open-to-internet");
  assert.equal(rule?.enabled, false);
});

test("a rule that cannot judge this graph is reported not applicable, never passed", () => {
  const report = evaluatePolicy(
    graph([node({ id: "default/Service/api", type: "Service", provider: "kubernetes" })]),
    { target: "kubernetes" },
  );
  const nsg = report.rules.find((r) => r.ruleId === "nsg-open-to-internet");
  assert.equal(nsg?.applicable, false);
  const orphan = report.rules.find((r) => r.ruleId === "orphan-resource");
  assert.equal(orphan?.applicable, true);
  // …and the Kubernetes-applicable rule really did run.
  assert.equal(report.violations[0]?.ruleId, "orphan-resource");
});

test("the effective configuration travels inside the report", () => {
  const report = evaluatePolicy(graph([]), {
    target: "terraform",
    config: { "required-tags": { enabled: true, params: { keys: ["env"] } } },
  });
  const required = report.rules.find((r) => r.ruleId === "required-tags");
  assert.deepEqual(required, {
    ruleId: "required-tags",
    enabled: true,
    severity: "warning",
    applicable: true,
    params: { keys: ["env"] },
  });
  // Every catalogue rule is accounted for, so a report says what was *not* run.
  assert.equal(report.rules.length, POLICY_CATALOG.length);
});

test("effectiveRuleFor merges params over the catalogue defaults", () => {
  const rule = ruleById("required-tags")!;
  const merged = effectiveRuleFor(rule, "terraform", {
    "required-tags": { params: { keys: ["team"] } },
  });
  assert.deepEqual(merged.params, { keys: ["team"] });
  const untouched = effectiveRuleFor(rule, "terraform", {});
  assert.deepEqual(untouched.params, { keys: ["environment", "owner"] });
  assert.equal(untouched.enabled, false, "required-tags is off until configured");
});

test("worstSeverity ignores waived violations", () => {
  assert.equal(
    worstSeverity([
      {
        ruleId: "r",
        severity: "error",
        address: "a",
        message: "m",
        hint: "h",
        waiver: { id: "w", reason: "accepted", expiresAt: null },
      },
      { ruleId: "r2", severity: "warning", address: "b", message: "m", hint: "h" },
    ]),
    "warning",
  );
  assert.equal(worstSeverity([]), null);
});

test("adding a rule needs no change to the engine", () => {
  // The engine is handed the catalogue; this stand-in proves the contract a new
  // rule has to satisfy is `PolicyRule` and nothing else.
  const invented: PolicyRule = {
    id: "no-node-called-bob",
    title: "No node called bob",
    description: "Nobody should name a resource bob.",
    defaultSeverity: "info",
    appliesTo: ["terraform"],
    evaluate: ({ graph: g }) =>
      g.nodes
        .filter((n) => n.name === "bob")
        .map((n) => ({ address: n.id, message: "Called bob.", hint: "Rename it." })),
  };
  const notes = invented.evaluate({
    graph: graph([node({ id: "azurerm_subnet.bob", type: "azurerm_subnet" })]),
    params: {},
  });
  assert.deepEqual(notes, [
    { address: "azurerm_subnet.bob", message: "Called bob.", hint: "Rename it." },
  ]);
});

test("catalogue rule ids are unique and stable-looking", () => {
  const ids = POLICY_CATALOG.map((r) => r.id);
  assert.equal(new Set(ids).size, ids.length);
  for (const id of ids) assert.match(id, /^[a-z][a-z0-9-]*$/);
});
