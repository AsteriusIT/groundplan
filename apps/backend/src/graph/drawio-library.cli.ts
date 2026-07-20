/**
 * Write — or with --check, verify — the committed draw.io shape library
 * (GP-176). CI runs the check so apps/frontend/public/groundplan-shapes.xml
 * can never drift from the style builder.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { buildShapeLibrary } from "./drawio-library.js";

const target = fileURLToPath(
  new URL("../../../frontend/public/groundplan-shapes.xml", import.meta.url),
);
const expected = buildShapeLibrary() + "\n";

if (process.argv.includes("--check")) {
  if (readFileSync(target, "utf8") !== expected) {
    console.error(
      "groundplan-shapes.xml is stale — regenerate with: pnpm --filter @groundplan/backend drawio:library",
    );
    process.exit(1);
  }
  console.log("groundplan-shapes.xml is up to date");
} else {
  writeFileSync(target, expected);
  console.log(`wrote ${target}`);
}
