import assert from "node:assert/strict";
import { test } from "node:test";

import type { Graph, GraphNode } from "./graph.js";
import { summarize } from "./summarize.js";

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

// A representative plan: deletions, updates (with attribute diffs), creations
// across two categories, and an impacted blast radius. The expected Markdown
// below is asserted byte-for-byte — the golden contract for GP-36.
const PLAN: Graph = {
  version: 3,
  nodes: [
    node({ id: "azurerm_public_ip.legacy", type: "azurerm_public_ip", change: "delete" }),
    node({ id: "aws_s3_bucket.old_logs", type: "aws_s3_bucket", provider: "aws", change: "delete" }),
    node({
      id: "azurerm_virtual_network.this",
      type: "azurerm_virtual_network",
      change: "update",
      // Four keys → the fourth collapses to a trailing "…".
      attribute_diff: [
        { key: "address_space", before: "a", after: "b" },
        { key: "dns_servers", before: "a", after: "b" },
        { key: "subnet", before: "{…}", after: "{…}" },
        { key: "tags", before: "{…}", after: "{…}" },
      ],
    }),
    node({
      id: "azurerm_mssql_database.shop_db",
      type: "azurerm_mssql_database",
      change: "update",
      attribute_diff: [
        { key: "sku_name", before: "S0", after: "P1" },
        { key: "tags", before: "{…}", after: "{…}" },
      ],
    }),
    node({ id: "azurerm_subnet.a", type: "azurerm_subnet", change: "create" }),
    node({ id: "azurerm_subnet.b", type: "azurerm_subnet", change: "create" }),
    node({ id: "azurerm_public_ip.new_ip", type: "azurerm_public_ip", change: "create" }),
    node({ id: "azurerm_linux_virtual_machine.web", type: "azurerm_linux_virtual_machine", change: "create" }),
    node({
      id: "azurerm_network_interface.web_nic",
      type: "azurerm_network_interface",
      change: "noop",
      impacted: true,
      impact_distance: 1,
    }),
    node({ id: "azurerm_lb.main", type: "azurerm_lb", change: "noop", impacted: true, impact_distance: 2 }),
  ],
  edges: [],
};

const EXPECTED = `**+4 created · ~2 updated · −2 deleted · 2 impacted** (10 resources)

**Deleted**
- \`aws_s3_bucket.old_logs\`
- \`azurerm_public_ip.legacy\`

**Updated**
- \`azurerm_mssql_database.shop_db\` — sku_name, tags
- \`azurerm_virtual_network.this\` — address_space, dns_servers, subnet, …

**Created**
- Network: 3 (subnet ×2, public_ip)
- Compute: 1 (linux_virtual_machine)

**Impacted**
- \`azurerm_network_interface.web_nic\` (1 hop)
- \`azurerm_lb.main\` (2 hops)`;

test("summarize renders the fixed template byte-for-byte", () => {
  assert.equal(summarize(PLAN), EXPECTED);
});

test("summarize is deterministic (stable across runs)", () => {
  assert.equal(summarize(PLAN), summarize(PLAN));
});

test("deletions are always listed before anything else", () => {
  const md = summarize(PLAN);
  const deleted = md.indexOf("**Deleted**");
  const updated = md.indexOf("**Updated**");
  const created = md.indexOf("**Created**");
  const impacted = md.indexOf("**Impacted**");
  assert.ok(deleted > 0 && deleted < updated);
  assert.ok(updated < created);
  assert.ok(created < impacted);
});

test("an empty plan collapses to a single 'No changes.' line", () => {
  const empty: Graph = { version: 3, nodes: [], edges: [] };
  assert.equal(summarize(empty), "No changes.");
});

test("a docs (all-unchanged) graph is 'No changes.'", () => {
  const docs: Graph = {
    version: 1,
    nodes: [node({ id: "azurerm_subnet.a", type: "azurerm_subnet", change: null })],
    edges: [],
  };
  assert.equal(summarize(docs), "No changes.");
});

test("modules are excluded from the resource count", () => {
  const g: Graph = {
    version: 3,
    nodes: [
      node({ id: "module.net", name: "net", type: "module", provider: null }),
      node({ id: "azurerm_subnet.a", type: "azurerm_subnet", change: "create" }),
    ],
    edges: [],
  };
  assert.match(summarize(g), /\(1 resource\)/);
});

test("caps each section and reports the overflow count", () => {
  const nodes: GraphNode[] = [];
  for (let i = 0; i < 25; i++) {
    nodes.push(node({ id: `azurerm_subnet.d${i}`, type: "azurerm_subnet", change: "delete" }));
  }
  for (let i = 0; i < 8; i++) {
    nodes.push(
      node({
        id: `azurerm_lb.i${i}`,
        type: "azurerm_lb",
        change: "noop",
        impacted: true,
        impact_distance: i + 1,
      }),
    );
  }
  const md = summarize({ version: 3, nodes, edges: [] });
  // 25 deletes → 10 shown + "…and 15 more".
  assert.match(md, /…and 15 more/);
  // 8 impacted → 5 shown + "…and 3 more".
  assert.match(md, /…and 3 more/);
  // Never more than the cap of concrete deleted rows.
  const deletedRows = md.split("\n").filter((l) => /^- `azurerm_subnet\.d/.test(l));
  assert.equal(deletedRows.length, 10);
});

test("scales to a 500-resource plan without exceeding caps", () => {
  const nodes: GraphNode[] = [];
  for (let i = 0; i < 500; i++) {
    nodes.push(node({ id: `azurerm_subnet.s${i}`, type: "azurerm_subnet", change: "create" }));
  }
  const md = summarize({ version: 3, nodes, edges: [] });
  assert.match(md, /\(500 resources\)/);
  // One "Created" category line — well under the cap.
  assert.match(md, /- Network: 500 \(subnet ×500\)/);
});
