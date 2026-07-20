import assert from "node:assert/strict";
import { test } from "node:test";

import type { Graph } from "./graph.js";
import { layoutGraph } from "./layout.js";

// Two resources inside a subnet inside a vnet: the edge between them is
// expressed by ELK relative to the subnet, and must come out absolute.
const NESTED: Graph = {
  version: 4,
  nodes: [
    { id: "vnet", name: "main", type: "azurerm_virtual_network", provider: "azurerm", module_path: [], change: null },
    { id: "subnet", name: "web", type: "azurerm_subnet", provider: "azurerm", module_path: [], change: null },
    { id: "app", name: "api", type: "azurerm_linux_web_app", provider: "azurerm", module_path: [], change: null },
    { id: "db", name: "main", type: "azurerm_postgresql_flexible_server", provider: "azurerm", module_path: [], change: null },
  ],
  edges: [
    { from: "vnet", to: "subnet", kind: "contains" },
    { from: "subnet", to: "app", kind: "contains" },
    { from: "subnet", to: "db", kind: "contains" },
    { from: "app", to: "db", kind: "depends_on" },
  ],
};

test("edge routes come out in absolute coordinates, even nested in containers", async () => {
  const laidOut = await layoutGraph(NESTED, { nestAllContains: true });
  const byId = new Map(laidOut.nodes.map((n) => [n.id, n]));
  const db = byId.get("db")!;
  const app = byId.get("app")!;

  const edge = laidOut.edges[0]!;
  assert.ok(edge.points.length >= 2);
  const start = edge.points[0]!;
  const end = edge.points.at(-1)!;

  // depends_on is laid out reversed (GP-31): the route runs dependency → dependent.
  // Layered RIGHT: it leaves the db's right edge and enters the app's left edge.
  assert.ok(
    Math.abs(start.x - (db.x + db.w)) < 1,
    `start.x ${start.x} should sit on the db's right edge ${db.x + db.w}`,
  );
  assert.ok(
    start.y >= db.y && start.y <= db.y + db.h,
    `start.y ${start.y} should be within the db's vertical span ${db.y}..${db.y + db.h}`,
  );
  assert.ok(
    Math.abs(end.x - app.x) < 1,
    `end.x ${end.x} should sit on the app's left edge ${app.x}`,
  );
  assert.ok(
    end.y >= app.y && end.y <= app.y + app.h,
    `end.y ${end.y} should be within the app's vertical span ${app.y}..${app.y + app.h}`,
  );
});
