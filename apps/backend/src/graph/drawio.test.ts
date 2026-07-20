import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

import type { Graph } from "./graph.js";
import { layoutGraph } from "./layout.js";
import { renderDrawio } from "./drawio.js";

// A plan snapshot with a module container so container/child geometry is covered.
const GRAPH: Graph = {
  version: 2,
  nodes: [
    { id: "module.net", name: "net", type: "module", provider: null, module_path: [], change: null },
    { id: "module.net.azurerm_virtual_network.this", name: "this", type: "azurerm_virtual_network", provider: "azurerm", module_path: ["net"], change: "create" },
    { id: "module.net.azurerm_subnet.a", name: "a", type: "azurerm_subnet", provider: "azurerm", module_path: ["net"], change: "delete" },
    { id: "aws_s3_bucket.logs", name: "logs", type: "aws_s3_bucket", provider: "aws", module_path: [], change: "noop", impacted: true, impact_distance: 1 },
  ],
  edges: [
    { from: "module.net", to: "module.net.azurerm_virtual_network.this", kind: "contains" },
    { from: "module.net", to: "module.net.azurerm_subnet.a", kind: "contains" },
    { from: "module.net.azurerm_subnet.a", to: "module.net.azurerm_virtual_network.this", kind: "depends_on", inferred: true },
    { from: "aws_s3_bucket.logs", to: "module.net.azurerm_subnet.a", kind: "depends_on" },
  ],
};

const META = {
  repoName: "acme/infra",
  ref: "refs/heads/pr-1",
  sha: "deadbeefcafe1234",
  date: "2026-07-20",
};

test("renderDrawio produces a well-formed mxfile document", async () => {
  const xml = renderDrawio(GRAPH, await layoutGraph(GRAPH), META);

  assert.ok(xml.startsWith("<mxfile"));
  assert.ok(xml.trimEnd().endsWith("</mxfile>"));
  assert.ok(xml.includes("<mxGraphModel"));
  // The two mandatory root cells.
  assert.ok(xml.includes('<mxCell id="0"/>'));
  assert.ok(xml.includes('<mxCell id="1" parent="0"/>'));
});

test("every graph node is a real vertex cell and every dependency a real edge cell", async () => {
  const xml = renderDrawio(GRAPH, await layoutGraph(GRAPH), META);

  assert.equal((xml.match(/vertex="1"/g) ?? []).length, GRAPH.nodes.length);
  assert.equal((xml.match(/edge="1"/g) ?? []).length, 2);
  // Edges reference their endpoint cells by id (real cells, not an image).
  assert.ok(xml.includes('source="aws_s3_bucket.logs"'));
  assert.ok(xml.includes('target="module.net.azurerm_subnet.a"'));
});

test("positions match the server-side canvas layout", async () => {
  const laidOut = await layoutGraph(GRAPH);
  const xml = renderDrawio(GRAPH, laidOut, META);

  const bucket = laidOut.nodes.find((n) => n.id === "aws_s3_bucket.logs")!;
  assert.ok(
    xml.includes(
      `<mxGeometry x="${bucket.x}" y="${bucket.y}" width="${bucket.w}" height="${bucket.h}" as="geometry"/>`,
    ),
  );
});

test("module children live inside the container with parent-relative coordinates", async () => {
  const laidOut = await layoutGraph(GRAPH);
  const xml = renderDrawio(GRAPH, laidOut, META);

  const mod = laidOut.nodes.find((n) => n.id === "module.net")!;
  const child = laidOut.nodes.find((n) => n.id === "module.net.azurerm_subnet.a")!;

  // The child cell is parented to the module cell (so it moves with it)...
  const childCell = xml.slice(xml.indexOf('id="module.net.azurerm_subnet.a"'));
  assert.ok(childCell.slice(0, childCell.indexOf("</mxCell>")).includes('parent="module.net"'));
  // ...and its geometry is expressed relative to the container's origin.
  assert.ok(
    childCell.includes(
      `<mxGeometry x="${child.x - mod.x}" y="${child.y - mod.y}" width="${child.w}" height="${child.h}" as="geometry"/>`,
    ),
  );
});

test("renderDrawio is deterministic for the same input (ADR #3)", async () => {
  const a = renderDrawio(GRAPH, await layoutGraph(GRAPH), META);
  const b = renderDrawio(GRAPH, await layoutGraph(GRAPH), META);
  assert.equal(a, b);
});

// Golden file: the full expected document, byte for byte. Refresh after an
// intentional visual change with: UPDATE_GOLDENS=1 pnpm --filter @groundplan/backend test
test("renderDrawio matches the committed golden file", async () => {
  const golden = fileURLToPath(new URL("./goldens/plan-snapshot.drawio", import.meta.url));
  const xml = renderDrawio(GRAPH, await layoutGraph(GRAPH), META);
  if (process.env.UPDATE_GOLDENS) {
    writeFileSync(golden, xml);
    return;
  }
  assert.equal(xml, readFileSync(golden, "utf8"));
});
