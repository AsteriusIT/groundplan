/**
 * draw.io style-string builders (GP-175). One builder per cell kind. The
 * category comes from the existing `categorize()` table and the colours are the
 * same GP-28 hex tokens the SVG export uses — no second mapping table. Also the
 * single source for the shape library (GP-176). Any visual change here warrants
 * a STYLE_VERSION bump in svg.ts (shared export cache key).
 */
import { categorize, type Category } from "./categories.js";
import type { GraphNode } from "./graph.js";
import type { EdgeRel } from "./layout.js";
import { CATEGORY_COLOR, COLOR, EDGE_COLOR, nodeStyle } from "./svg.js";

/**
 * Category → built-in Azure shape. diagrams.net (web and desktop) bundles the
 * azure2 image library, so these render without any network access. `other`
 * deliberately has none — it stays a plain rectangle.
 */
export const CATEGORY_SHAPE: Record<Category, string | null> = {
  compute: "img/lib/azure2/compute/Virtual_Machine.svg",
  network: "img/lib/azure2/networking/Virtual_Networks.svg",
  data: "img/lib/azure2/databases/SQL_Database.svg",
  security: "img/lib/azure2/security/Key_Vaults.svg",
  identity: "img/lib/azure2/identity/Managed_Identities.svg",
  observability: "img/lib/azure2/management_governance/Monitor.svg",
  other: null,
};

function resourceStyle(
  icon: string | null,
  fill: string,
  strokeColor: string,
  dashed: boolean,
): string {
  return (
    (icon ? `shape=label;image=${icon};imageWidth=22;imageHeight=22;` : "") +
    `rounded=1;whiteSpace=wrap;html=1;align=left;verticalAlign=middle;` +
    // The label must clear the icon on the left, or the two overlap.
    (icon ? "spacingLeft=34;spacing=6;" : "spacingLeft=12;") +
    `fillColor=${fill};strokeColor=${strokeColor};fontColor=${COLOR.ink};` +
    (dashed ? "dashed=1;" : "")
  );
}

/** Resource vertex style: category icon + change-state fill/stroke. */
export function nodeStyleString(node: GraphNode): string {
  const category = categorize(node.type);
  const icon = CATEGORY_SHAPE[category];
  const { fill, stroke, dashed } = nodeStyle(node);
  // An icon-less node shows its category as the border colour instead — but
  // never at the cost of a diff colour.
  const strokeColor = icon || stroke !== COLOR.border ? stroke : CATEGORY_COLOR[category];
  return resourceStyle(icon, fill, strokeColor, dashed);
}

/** The neutral (no change state) template style for a category (GP-176). */
export function templateStyleString(category: Category): string {
  const icon = CATEGORY_SHAPE[category];
  return resourceStyle(icon, COLOR.card, icon ? COLOR.border : CATEGORY_COLOR[category], false);
}

/** Module container style: collapsible, dashed boundary like the canvas. */
export function moduleStyleString(): string {
  return (
    `rounded=1;html=1;verticalAlign=top;align=left;spacingLeft=8;container=1;collapsible=1;` +
    `fillColor=${COLOR.accentSoft};strokeColor=${COLOR.borderStrong};dashed=1;dashPattern=4 3;` +
    `fontColor=${COLOR.muted};`
  );
}

/**
 * Edge style: relationship colour, dashed when the dependency was inferred.
 * No edgeStyle router — edges carry the ELK route as explicit waypoints, so
 * draw.io draws the same polyline the canvas does.
 */
export function edgeStyleString(rel: EdgeRel, inferred: boolean): string {
  return (
    `rounded=1;html=1;strokeColor=${EDGE_COLOR[rel]};` +
    `fontColor=${COLOR.muted};` +
    (inferred ? "dashed=1;dashPattern=4 3;" : "")
  );
}
