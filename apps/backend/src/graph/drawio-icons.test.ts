import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

import { drawioIconUri } from "./drawio-icons.js";
import { EXACT_ICON, ICON_DATA, PREFIX_ICON } from "./drawio-icons.generated.js";

test("every resource type resolves to its own vendored icon, not a category stand-in", () => {
  const subnet = drawioIconUri("azurerm_subnet");
  const vnet = drawioIconUri("azurerm_virtual_network");
  assert.ok(subnet && vnet);
  assert.notEqual(subnet, vnet);
  // draw.io style-safe data URI: comma form, no semicolons (a ';' would end
  // the style key/value pair).
  for (const uri of [subnet, vnet]) {
    assert.ok(uri.startsWith("data:image/svg+xml,"));
    assert.ok(!uri.includes(";"));
  }
});

test("the type-prefix heuristic covers unmapped family members", () => {
  // Not in the exact map, but the storage family prefix catches it.
  assert.equal(drawioIconUri("azurerm_storage_share"), drawioIconUri("azurerm_storage_account"));
  assert.equal(drawioIconUri("some_unknown_provider_thing"), null);
});

test("all four providers resolve", () => {
  for (const type of ["azurerm_key_vault", "aws_s3_bucket", "google_compute_instance", "Deployment"]) {
    assert.ok(drawioIconUri(type), `no icon for ${type}`);
  }
});

test("the generated icon data mirrors the canvas package's vendored SVGs", () => {
  const iconsDir = fileURLToPath(new URL("../../../../packages/canvas/src/icons/", import.meta.url));
  const ids = Object.keys(ICON_DATA);
  assert.ok(ids.length >= 100, `expected the whole icon set, got ${ids.length}`);
  for (const id of ids) {
    const svg = readFileSync(`${iconsDir}${id}.svg`);
    assert.equal(ICON_DATA[id], svg.toString("base64"), `${id} is stale — run drawio:icons`);
  }
  // Every mapping target must exist in the data table.
  for (const target of [...Object.values(EXACT_ICON), ...Object.values(PREFIX_ICON)]) {
    assert.ok(ICON_DATA[target], `mapping points at missing icon ${target}`);
  }
});
