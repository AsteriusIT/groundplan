/**
 * The downloadable draw.io shape library (GP-176): one template per vendored
 * app icon — the whole GP-29 set, so extending an exported diagram offers the
 * same official provider icons the app draws — plus a generic resource and a
 * module container, all styled by the same builders as the export. The
 * committed artifact is apps/frontend/public/groundplan-shapes.xml —
 * regenerate with `pnpm --filter @groundplan/backend drawio:library` (CI
 * fails when it drifts from the builder).
 */
import { deflateRawSync } from "node:zlib";

import { iconDataUri } from "./drawio-icons.js";
import { ICON_DATA } from "./drawio-icons.generated.js";
import { moduleStyleString, templateStyleString } from "./drawio-style.js";
import { CATEGORY_COLOR, esc } from "./svg.js";

const PROVIDER_LABEL: Record<string, string> = {
  azure: "Azure",
  aws: "AWS",
  gcp: "GCP",
  kubernetes: "Kubernetes",
};

const RESOURCE_W = 220;
const RESOURCE_H = 56;
const MODULE_W = 260;
const MODULE_H = 120;

/**
 * draw.io's content encoding for library entries (and diagrams): URI-encode →
 * raw deflate → base64. Compressing keeps the JSON payload free of raw '<'/'&'
 * — the whole file must XML-parse before draw.io JSON-parses the payload.
 */
function compress(xml: string): string {
  return deflateRawSync(Buffer.from(encodeURIComponent(xml))).toString("base64");
}

/** One library entry: a self-contained, compressed cell template. */
function cellTemplate(style: string, label: string, w: number, h: number): string {
  return compress(
    `<mxGraphModel><root><mxCell id="0"/><mxCell id="1" parent="0"/>` +
      `<mxCell id="2" value="${esc(label)}" style="${style}" vertex="1" parent="1">` +
      `<mxGeometry width="${w}" height="${h}" as="geometry"/>` +
      `</mxCell></root></mxGraphModel>`,
  );
}

/** Render the whole library as draw.io's `<mxlibrary>` format. */
export function buildShapeLibrary(): string {
  const entries = [
    // The whole vendored icon set, one template per icon, "Azure subnet" style.
    ...Object.keys(ICON_DATA).map((id) => {
      const [provider, key] = id.split("/") as [string, string];
      const name = key.replaceAll("-", " ");
      return {
        xml: cellTemplate(
          templateStyleString(iconDataUri(id)),
          `<b>${name}</b><br/>resource`,
          RESOURCE_W,
          RESOURCE_H,
        ),
        w: RESOURCE_W,
        h: RESOURCE_H,
        title: `${PROVIDER_LABEL[provider] ?? provider} ${name}`,
      };
    }),
    {
      xml: cellTemplate(
        templateStyleString(null, CATEGORY_COLOR.other),
        `<b>Resource</b><br/>name`,
        RESOURCE_W,
        RESOURCE_H,
      ),
      w: RESOURCE_W,
      h: RESOURCE_H,
      title: "Generic resource",
    },
    {
      xml: cellTemplate(moduleStyleString(), "module.name", MODULE_W, MODULE_H),
      w: MODULE_W,
      h: MODULE_H,
      title: "Module container",
    },
  ];
  return `<mxlibrary>${JSON.stringify(entries)}</mxlibrary>`;
}
