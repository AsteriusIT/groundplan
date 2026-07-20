import assert from "node:assert/strict";
import { test } from "node:test";

import type { GraphNode } from "./graph.js";
import { edgeStyleString, moduleStyleString, nodeStyleString } from "./drawio-style.js";

const node = (overrides: Partial<GraphNode>): GraphNode => ({
  id: "azurerm_linux_virtual_machine.web",
  name: "web",
  type: "azurerm_linux_virtual_machine",
  provider: "azurerm",
  module_path: [],
  change: null,
  ...overrides,
});

test("a mapped type gets its vendored app icon, embedded", () => {
  const style = nodeStyleString(node({}));
  assert.ok(style.includes("shape=label;"));
  assert.ok(style.includes("image=data:image/svg+xml,"));
  // The label must clear the 22px icon or the two overlap.
  assert.ok(style.includes("spacingLeft=34;"));
});

test("each type carries its own icon; unknown types fall back to a plain rectangle", () => {
  const styles = [
    "azurerm_virtual_network.a",
    "azurerm_subnet.a", // must differ from the vnet — not a shared category icon
    "aws_s3_bucket.a",
    "azurerm_key_vault.a",
    "azurerm_monitor_diagnostic_setting.a",
  ].map((id) => {
    const [type] = id.split(".");
    return nodeStyleString(node({ id, type: type! }));
  });
  const images = styles.map((s) => /image=([^;]+);/.exec(s)?.[1]);
  assert.equal(new Set(images).size, images.length);
  for (const image of images) assert.match(image!, /^data:image\/svg\+xml,/);

  // Unknown type → generic rectangle carrying the category colour, never an image.
  const fallback = nodeStyleString(node({ type: "mystery_widget", change: null }));
  assert.ok(!fallback.includes("image="));
  assert.ok(!fallback.includes("shape=label"));
  assert.ok(fallback.includes("strokeColor=#5d7391;")); // cat-other
});

test("change state is encoded as fill/stroke per the GP-28 tokens", () => {
  const create = nodeStyleString(node({ change: "create" }));
  assert.ok(create.includes("fillColor=#e8f7ef;"));
  assert.ok(create.includes("strokeColor=#189a5c;"));

  const update = nodeStyleString(node({ change: "update" }));
  assert.ok(update.includes("fillColor=#fbf3e4;"));
  assert.ok(update.includes("strokeColor=#c77e10;"));

  const del = nodeStyleString(node({ change: "delete" }));
  assert.ok(del.includes("fillColor=#fdf1ef;"));
  assert.ok(del.includes("strokeColor=#d8503f;"));
  assert.ok(del.includes("dashed=1;"));

  const impacted = nodeStyleString(node({ change: "noop", impacted: true }));
  assert.ok(impacted.includes("fillColor=#f1edfc;"));
  assert.ok(impacted.includes("strokeColor=#7b5bd6;"));

  const untouched = nodeStyleString(node({ change: "noop" }));
  assert.ok(untouched.includes("fillColor=#ffffff;"));
  assert.ok(untouched.includes("strokeColor=#e3e9f2;"));
  assert.ok(!untouched.includes("dashed=1;"));
});

test("module containers are collapsible and styled like the canvas", () => {
  const style = moduleStyleString();
  assert.ok(style.includes("container=1;"));
  assert.ok(style.includes("collapsible=1;"));
  assert.ok(style.includes("fillColor=#eaf1fe;"));
  assert.ok(style.includes("dashed=1;"));
});

test("edges carry the relationship colour and the inferred dash", () => {
  assert.ok(edgeStyleString("new", false).includes("strokeColor=#189a5c;"));
  assert.ok(edgeStyleString("removed", false).includes("strokeColor=#d8503f;"));
  assert.ok(edgeStyleString("impact", false).includes("strokeColor=#7b5bd6;"));
  const neutral = edgeStyleString("neutral", true);
  assert.ok(neutral.includes("strokeColor=#a6b8d0;"));
  assert.ok(neutral.includes("dashed=1;"));
  assert.ok(!edgeStyleString("neutral", false).includes("dashed=1;"));
  // Edges carry explicit ELK waypoints — no draw.io auto-router on top.
  assert.ok(!neutral.includes("edgeStyle="));
});
