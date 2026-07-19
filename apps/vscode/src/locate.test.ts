import assert from "node:assert/strict";
import { test } from "node:test";

import type { Graph } from "@groundplan/graph-parser";

import { nodeAtPosition, sourceOf } from "./locate";

const snapshot: Graph = {
  version: 8,
  nodes: [
    {
      id: "azurerm_virtual_network.main",
      name: "main",
      type: "azurerm_virtual_network",
      provider: "azurerm",
      module_path: [],
      change: null,
      source: { file: "main.tf", start_line: 1, end_line: 10, code: "…" },
    },
    {
      id: "azurerm_subnet.inner",
      name: "inner",
      type: "azurerm_subnet",
      provider: "azurerm",
      module_path: [],
      change: null,
      // Overlapping span (defensive: pick the innermost match).
      source: { file: "main.tf", start_line: 4, end_line: 6, code: "…" },
    },
    {
      id: "module.net.aws_instance.web",
      name: "web",
      type: "aws_instance",
      provider: "aws",
      module_path: ["net"],
      change: null,
      source: {
        file: "modules/net/main.tf",
        start_line: 3,
        end_line: 9,
        code: "…",
      },
    },
    {
      id: "module.net",
      name: "net",
      type: "module",
      provider: null,
      module_path: [],
      change: null,
    },
  ],
  edges: [],
};

test("sourceOf answers a node's file and span; nodes without source say null", () => {
  assert.equal(sourceOf(snapshot, "module.net.aws_instance.web")?.file, "modules/net/main.tf");
  assert.equal(sourceOf(snapshot, "module.net"), null);
  assert.equal(sourceOf(snapshot, "nope"), null);
});

test("the cursor resolves to the innermost resource block on its line", () => {
  assert.equal(nodeAtPosition(snapshot, "main.tf", 2)?.id, "azurerm_virtual_network.main");
  assert.equal(nodeAtPosition(snapshot, "main.tf", 5)?.id, "azurerm_subnet.inner");
  assert.equal(nodeAtPosition(snapshot, "modules/net/main.tf", 3)?.id, "module.net.aws_instance.web");
});

test("comments, other files and out-of-block lines resolve to nothing", () => {
  assert.equal(nodeAtPosition(snapshot, "main.tf", 12), null);
  assert.equal(nodeAtPosition(snapshot, "variables.tf", 1), null);
  assert.equal(nodeAtPosition(snapshot, "modules/net/main.tf", 1), null);
});
