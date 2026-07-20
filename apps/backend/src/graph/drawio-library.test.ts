import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { inflateRawSync } from "node:zlib";

import { buildShapeLibrary } from "./drawio-library.js";

type LibraryEntry = { xml: string; w: number; h: number; title: string };

/** draw.io's entry encoding, reversed: base64 → raw inflate → URI-decode. */
function decompress(data: string): string {
  return decodeURIComponent(inflateRawSync(Buffer.from(data, "base64")).toString());
}

function payload(): string {
  const library = buildShapeLibrary();
  assert.ok(library.startsWith("<mxlibrary>"));
  assert.ok(library.trimEnd().endsWith("</mxlibrary>"));
  return library.slice("<mxlibrary>".length, library.lastIndexOf("</mxlibrary>"));
}

function entries(): LibraryEntry[] {
  return JSON.parse(payload());
}

test("the library file is valid XML: no raw markup inside the payload", () => {
  // draw.io XML-parses the whole file before JSON-parsing the payload, so any
  // raw '<' or '&' in the JSON breaks loading ("This page contains the
  // following errors…" → 'is not valid JSON'). Entries are compressed like
  // draw.io's own saved libraries, leaving the payload XML-inert.
  const inner = payload();
  assert.ok(!inner.includes("<"));
  assert.ok(!inner.includes("&"));
});

test("the library holds the whole vendored icon set plus generic + module templates", () => {
  const all = entries();
  const titles = all.map((e) => e.title);
  // One entry per vendored app icon (the whole GP-29 set)…
  assert.ok(all.length >= 100, `expected the whole icon set, got ${all.length}`);
  assert.ok(titles.includes("Azure subnet"));
  assert.ok(titles.includes("Azure virtual network"));
  assert.ok(titles.includes("AWS s3"));
  assert.ok(titles.includes("Kubernetes deployment"));
  // …plus the icon-less templates, last.
  assert.deepEqual(titles.slice(-2), ["Generic resource", "Module container"]);
  for (const entry of all) {
    assert.ok(decompress(entry.xml).includes("<mxGraphModel>"), `${entry.title} is not a cell template`);
    assert.ok(entry.w > 0 && entry.h > 0);
  }
});

test("templates are styled by the same builder as the export", () => {
  const all = entries();
  const byTitle = new Map(all.map((e) => [e.title, decompress(e.xml)]));

  // Every icon template embeds its vendored SVG, subnet ≠ vnet…
  const subnet = byTitle.get("Azure subnet")!;
  const vnet = byTitle.get("Azure virtual network")!;
  assert.ok(subnet.includes("image=data:image/svg+xml,"));
  assert.notEqual(subnet, vnet);
  // …the icon-less fallback carries the category colour…
  const generic = byTitle.get("Generic resource")!;
  assert.ok(!generic.includes("image="));
  assert.ok(generic.includes("strokeColor=#5d7391;"));
  // …and the collapsible module container.
  const mod = byTitle.get("Module container")!;
  assert.ok(mod.includes("container=1;"));
  assert.ok(mod.includes("collapsible=1;"));
});

test("buildShapeLibrary is deterministic", () => {
  assert.equal(buildShapeLibrary(), buildShapeLibrary());
});

// The committed, user-downloadable artifact must always match the builder.
// Refresh with: pnpm --filter @groundplan/backend drawio:library
test("the committed groundplan-shapes.xml is generated from the current style builder", () => {
  const committed = fileURLToPath(
    new URL("../../../frontend/public/groundplan-shapes.xml", import.meta.url),
  );
  const expected = buildShapeLibrary() + "\n";
  if (process.env.UPDATE_GOLDENS) {
    writeFileSync(committed, expected);
    return;
  }
  assert.equal(readFileSync(committed, "utf8"), expected);
});
