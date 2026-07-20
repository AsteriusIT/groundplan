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

test("the library holds one template per category plus a module container", () => {
  const all = entries();
  const titles = all.map((e) => e.title);
  assert.deepEqual(titles, [
    "Compute",
    "Network",
    "Data",
    "Security",
    "Identity",
    "Observability",
    "Other",
    "Module container",
  ]);
  for (const entry of all) {
    assert.ok(decompress(entry.xml).includes("<mxGraphModel>"), `${entry.title} is not a cell template`);
    assert.ok(entry.w > 0 && entry.h > 0);
  }
});

test("templates are styled by the same builder as the export", () => {
  const all = entries();
  const byTitle = new Map(all.map((e) => [e.title, decompress(e.xml)]));

  // A category with a built-in Azure shape…
  assert.ok(
    byTitle.get("Compute")!.includes("image=img/lib/azure2/compute/Virtual_Machine.svg;"),
  );
  // …the icon-less fallback carrying the category colour…
  const other = byTitle.get("Other")!;
  assert.ok(!other.includes("image="));
  assert.ok(other.includes("strokeColor=#5d7391;"));
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
