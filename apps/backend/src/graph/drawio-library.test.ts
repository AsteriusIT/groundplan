import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

import { buildShapeLibrary } from "./drawio-library.js";

type LibraryEntry = { xml: string; w: number; h: number; title: string };

function entries(): LibraryEntry[] {
  const library = buildShapeLibrary();
  assert.ok(library.startsWith("<mxlibrary>"));
  assert.ok(library.trimEnd().endsWith("</mxlibrary>"));
  return JSON.parse(library.slice("<mxlibrary>".length, library.lastIndexOf("</mxlibrary>")));
}

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
    assert.ok(entry.xml.includes("<mxGraphModel>"), `${entry.title} is not a cell template`);
    assert.ok(entry.w > 0 && entry.h > 0);
  }
});

test("templates are styled by the same builder as the export", () => {
  const all = entries();
  const byTitle = new Map(all.map((e) => [e.title, e]));

  // A category with a built-in Azure shape…
  assert.ok(
    byTitle.get("Compute")!.xml.includes("image=img/lib/azure2/compute/Virtual_Machine.svg;"),
  );
  // …the icon-less fallback carrying the category colour…
  const other = byTitle.get("Other")!.xml;
  assert.ok(!other.includes("image="));
  assert.ok(other.includes("strokeColor=#5d7391;"));
  // …and the collapsible module container.
  const mod = byTitle.get("Module container")!.xml;
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
