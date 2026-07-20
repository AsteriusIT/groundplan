/**
 * Generate src/graph/drawio-icons.generated.ts from the canvas package's
 * vendored icon set (GP-176): the same type→icon maps the app renders with,
 * plus each SVG inlined as base64 so draw.io exports are self-contained.
 *
 * Run via tsx (this file is outside the backend tsconfig on purpose — it
 * imports canvas TS source across the workspace):
 *
 *   pnpm --filter @groundplan/backend drawio:icons          # write
 *   pnpm --filter @groundplan/backend drawio:icons:check    # CI drift guard
 */
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { AZURERM_ICON_MAP, AZURERM_PREFIX_MAP } from "../../../packages/canvas/src/icons/azurerm.ts";
import { AWS_ICON_MAP, AWS_PREFIX_MAP } from "../../../packages/canvas/src/icons/aws.ts";
import { GCP_ICON_MAP, GCP_PREFIX_MAP } from "../../../packages/canvas/src/icons/gcp.ts";
import {
  KUBERNETES_ICON_MAP,
  KUBERNETES_PREFIX_MAP,
} from "../../../packages/canvas/src/icons/kubernetes.ts";

const iconsDir = fileURLToPath(new URL("../../../packages/canvas/src/icons/", import.meta.url));
const target = fileURLToPath(new URL("../src/graph/drawio-icons.generated.ts", import.meta.url));

// Namespace each provider's icon keys as "<dir>/<key>" — the SVG's path.
const providers: [string, Record<string, string>, Record<string, string>][] = [
  ["azure", AZURERM_ICON_MAP, AZURERM_PREFIX_MAP],
  ["aws", AWS_ICON_MAP, AWS_PREFIX_MAP],
  ["gcp", GCP_ICON_MAP, GCP_PREFIX_MAP],
  ["kubernetes", KUBERNETES_ICON_MAP, KUBERNETES_PREFIX_MAP],
];

const exact: Record<string, string> = {};
const prefix: Record<string, string> = {};
const data: Record<string, string> = {};

for (const [dir, exactMap, prefixMap] of providers) {
  for (const [type, key] of Object.entries(exactMap)) exact[type] = `${dir}/${key}`;
  for (const [p, key] of Object.entries(prefixMap)) prefix[p] = `${dir}/${key}`;
}
for (const id of [...new Set([...Object.values(exact), ...Object.values(prefix)])].sort()) {
  data[id] = readFileSync(`${iconsDir}${id}.svg`).toString("base64");
}

const sortedRecord = (record: Record<string, string>): Record<string, string> =>
  Object.fromEntries(Object.entries(record).sort(([a], [b]) => (a < b ? -1 : 1)));

const body =
  `/**\n` +
  ` * GENERATED — do not edit. Source of truth: packages/canvas/src/icons\n` +
  ` * (the app's vendored official provider icons + type→icon maps, GP-29).\n` +
  ` * Regenerate: pnpm --filter @groundplan/backend drawio:icons\n` +
  ` */\n\n` +
  `/** icon id ("azure/subnet") → base64 of the vendored SVG. */\n` +
  `export const ICON_DATA: Record<string, string> = ` +
  `${JSON.stringify(sortedRecord(data), null, 2)};\n\n` +
  `/** exact resource type → icon id. */\n` +
  `export const EXACT_ICON: Record<string, string> = ` +
  `${JSON.stringify(sortedRecord(exact), null, 2)};\n\n` +
  `/** type-prefix → icon id (longest prefix wins). */\n` +
  `export const PREFIX_ICON: Record<string, string> = ` +
  `${JSON.stringify(sortedRecord(prefix), null, 2)};\n`;

if (process.argv.includes("--check")) {
  if (readFileSync(target, "utf8") !== body) {
    console.error(
      "drawio-icons.generated.ts is stale — regenerate with: pnpm --filter @groundplan/backend drawio:icons",
    );
    process.exit(1);
  }
  console.log("drawio-icons.generated.ts is up to date");
} else {
  writeFileSync(target, body);
  console.log(`wrote ${target}`);
}
