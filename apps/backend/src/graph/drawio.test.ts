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
  // Edges reference their endpoint cells by id (real cells, not an image), and
  // depends_on arrows flow dependency → dependent like the canvas (GP-31).
  assert.ok(xml.includes('source="module.net.azurerm_subnet.a" target="aws_s3_bucket.logs"'));
  assert.ok(
    xml.includes(
      'source="module.net.azurerm_virtual_network.this" target="module.net.azurerm_subnet.a"',
    ),
  );
});

test("depends_on edges follow the ELK route through explicit waypoints", async () => {
  // A diamond: two middle nodes share a layer, so the joining edges must bend.
  const resource = (name: string) => ({
    id: `aws_s3_bucket.${name}`,
    name,
    type: "aws_s3_bucket",
    provider: "aws",
    module_path: [],
    change: null,
  });
  const dep = (from: string, to: string) => ({
    from: `aws_s3_bucket.${from}`,
    to: `aws_s3_bucket.${to}`,
    kind: "depends_on" as const,
  });
  const diamond: Graph = {
    version: 2,
    nodes: [resource("root"), resource("left"), resource("right"), resource("top")],
    edges: [dep("left", "root"), dep("right", "root"), dep("top", "left"), dep("top", "right")],
  };

  const laidOut = await layoutGraph(diamond);
  const xml = renderDrawio(diamond, laidOut, META);
  // Every laid-out bend point is carried into the edge geometry, so draw.io
  // draws the same route as the canvas instead of re-routing.
  const bends = laidOut.edges.flatMap((e) => e.points.slice(1, -1));
  assert.ok(bends.length > 0, "fixture should produce at least one bend point");
  for (const p of bends) {
    assert.ok(xml.includes(`<mxPoint x="${p.x}" y="${p.y}"/>`));
  }
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

test("every node carries its Terraform address as the hover tooltip (GP-175)", async () => {
  const xml = renderDrawio(GRAPH, await layoutGraph(GRAPH), META);
  for (const n of GRAPH.nodes) {
    assert.ok(xml.includes(`tooltip="${n.id}"`), `missing tooltip for ${n.id}`);
  }
});

test("labels show the short type and the resource name — no empty boxes (GP-175)", async () => {
  const xml = renderDrawio(GRAPH, await layoutGraph(GRAPH), META);
  // Type-first label on a resource…
  assert.ok(xml.includes("s3_bucket"));
  assert.ok(xml.includes("logs"));
  // …and no vertex without a label.
  assert.equal((xml.match(/label=""/g) ?? []).length, 0);
});

test("edge labels are carried onto the edge cells (GP-175)", async () => {
  const labelled: Graph = {
    version: 5,
    nodes: [
      { id: "aws_lambda_function.f", name: "f", type: "aws_lambda_function", provider: "aws", module_path: [], change: null },
      { id: "aws_s3_bucket.b", name: "b", type: "aws_s3_bucket", provider: "aws", module_path: [], change: null },
    ],
    edges: [
      { from: "aws_lambda_function.f", to: "aws_s3_bucket.b", kind: "logical", label: "reads objects" },
    ],
  };
  const xml = renderDrawio(labelled, await layoutGraph(labelled), META);
  assert.ok(xml.includes('value="reads objects"'));
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
