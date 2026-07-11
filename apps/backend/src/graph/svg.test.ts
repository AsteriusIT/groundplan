import assert from "node:assert/strict";
import { test } from "node:test";

import type { Graph } from "./graph.js";
import { layoutGraph } from "./layout.js";
import { esc, renderSvg, STYLE_VERSION } from "./svg.js";

test("esc escapes the five XML-significant characters", () => {
  assert.equal(esc(`a & b < c > d " e ' f`), "a &amp; b &lt; c &gt; d &quot; e &#39; f");
});

test("STYLE_VERSION is a non-empty string (part of the cache key)", () => {
  assert.ok(typeof STYLE_VERSION === "string" && STYLE_VERSION.length > 0);
});

const GRAPH: Graph = {
  version: 2,
  nodes: [
    { id: "azurerm_virtual_network.this", name: "this", type: "azurerm_virtual_network", provider: "azurerm", module_path: [], change: "create" },
    { id: "azurerm_subnet.a", name: "a", type: "azurerm_subnet", provider: "azurerm", module_path: [], change: "delete" },
    { id: "azurerm_lb.main", name: "main", type: "azurerm_lb", provider: "azurerm", module_path: [], change: "noop", impacted: true, impact_distance: 1 },
  ],
  edges: [
    { from: "azurerm_subnet.a", to: "azurerm_virtual_network.this", kind: "depends_on", inferred: true },
    { from: "azurerm_lb.main", to: "azurerm_subnet.a", kind: "depends_on" },
  ],
};

test("renderSvg produces a well-formed document with nodes, edges and a title block", async () => {
  const laidOut = await layoutGraph(GRAPH);
  const svg = renderSvg(laidOut, {
    repoName: "acme/infra",
    ref: "refs/heads/main",
    sha: "deadbeefcafe1234",
    date: "2026-07-11",
  });

  assert.ok(svg.startsWith("<svg"));
  assert.ok(svg.trimEnd().endsWith("</svg>"));
  // One rounded rect per resource node.
  assert.equal((svg.match(/rx="8"/g) ?? []).length, 3);
  // Arrowhead markers for every relationship colour.
  assert.equal((svg.match(/<marker id="arrow-/g) ?? []).length, 4);
  // Title block carries the repo + short sha + date.
  assert.ok(svg.includes("acme/infra"));
  assert.ok(svg.includes("deadbeef")); // short sha
  assert.ok(svg.includes("2026-07-11"));
  // Labels are type-first.
  assert.ok(svg.includes("virtual_network"));
});

test("renderSvg is deterministic for the same input", async () => {
  const a = renderSvg(await layoutGraph(GRAPH), { repoName: "r", ref: "main", sha: "abcd1234", date: "2026-07-11" });
  const b = renderSvg(await layoutGraph(GRAPH), { repoName: "r", ref: "main", sha: "abcd1234", date: "2026-07-11" });
  assert.equal(a, b);
});

test("a changes-only render carries the scope label", async () => {
  const svg = renderSvg(await layoutGraph(GRAPH), {
    repoName: "r",
    ref: "main",
    sha: "abcd1234",
    date: "2026-07-11",
    scopeLabel: "changes only",
  });
  assert.ok(svg.includes("changes only"));
});
