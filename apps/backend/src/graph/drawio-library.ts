/**
 * The downloadable draw.io shape library (GP-176): one template shape per
 * category plus a module container, generated from the same style builders as
 * the export so a dragged-in template is visually consistent with exported
 * nodes. The committed artifact is apps/frontend/public/groundplan-shapes.xml
 * — regenerate with `pnpm --filter @groundplan/backend drawio:library` (CI
 * fails when it drifts from the builder).
 */
import { CATEGORY_LABEL, type Category } from "./categories.js";
import { moduleStyleString, templateStyleString } from "./drawio-style.js";
import { esc } from "./svg.js";

const CATEGORIES: Category[] = [
  "compute",
  "network",
  "data",
  "security",
  "identity",
  "observability",
  "other",
];

const RESOURCE_W = 220;
const RESOURCE_H = 56;
const MODULE_W = 260;
const MODULE_H = 120;

/** One library entry: a self-contained cell template. */
function cellTemplate(style: string, label: string, w: number, h: number): string {
  return (
    `<mxGraphModel><root><mxCell id="0"/><mxCell id="1" parent="0"/>` +
    `<mxCell id="2" value="${esc(label)}" style="${style}" vertex="1" parent="1">` +
    `<mxGeometry width="${w}" height="${h}" as="geometry"/>` +
    `</mxCell></root></mxGraphModel>`
  );
}

/** Render the whole library as draw.io's `<mxlibrary>` format. */
export function buildShapeLibrary(): string {
  const entries = [
    ...CATEGORIES.map((category) => ({
      xml: cellTemplate(
        templateStyleString(category),
        `<b>${CATEGORY_LABEL[category]}</b><br/>resource`,
        RESOURCE_W,
        RESOURCE_H,
      ),
      w: RESOURCE_W,
      h: RESOURCE_H,
      title: CATEGORY_LABEL[category],
    })),
    {
      xml: cellTemplate(moduleStyleString(), "module.name", MODULE_W, MODULE_H),
      w: MODULE_W,
      h: MODULE_H,
      title: "Module container",
    },
  ];
  return `<mxlibrary>${JSON.stringify(entries)}</mxlibrary>`;
}
