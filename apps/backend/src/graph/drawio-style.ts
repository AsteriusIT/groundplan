/**
 * draw.io style-string builders (GP-175). One builder per cell kind. The
 * category comes from the existing `categorize()` table and the colours are the
 * same GP-28 hex tokens the SVG export uses — no second mapping table. Also the
 * single source for the shape library (GP-176). Any visual change here warrants
 * a STYLE_VERSION bump in svg.ts (shared export cache key).
 */
import { categorize } from "./categories.js";
import { drawioIconUri } from "./drawio-icons.js";
import type { GraphNode } from "./graph.js";
import type { EdgeRel } from "./layout.js";
import { CATEGORY_COLOR, COLOR, EDGE_COLOR, nodeStyle } from "./svg.js";

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

/**
 * Exposure ring (GP-45): internet-exposed nodes get the exposed stroke — but a
 * diff colour always wins, so a changed node still reads as its change.
 */
function withExposure(node: GraphNode, stroke: string): { color: string; wide: boolean } {
  if (node.internet_exposed && stroke === COLOR.border) {
    return { color: COLOR.exposed, wide: true };
  }
  return { color: stroke, wide: false };
}

/** Resource vertex style: the type's own embedded app icon + change fill/stroke. */
export function nodeStyleString(node: GraphNode): string {
  const icon = drawioIconUri(node.type);
  const { fill, stroke, dashed } = nodeStyle(node);
  // An icon-less node shows its category as the border colour instead — but
  // never at the cost of a diff colour.
  const base = icon || stroke !== COLOR.border ? stroke : CATEGORY_COLOR[categorize(node.type)];
  const exposure = withExposure(node, node.internet_exposed ? stroke : base);
  return (
    resourceStyle(icon, fill, node.internet_exposed ? exposure.color : base, dashed) +
    (exposure.wide ? "strokeWidth=2;" : "")
  );
}

/**
 * Network container style (vnet/subnet in the network view): a collapsible
 * frame carrying the network hue — or the exposed ring when an associated NSG
 * is open to the internet.
 */
export function containerStyleString(node: GraphNode): string {
  const { stroke } = nodeStyle(node);
  const base = stroke !== COLOR.border ? stroke : CATEGORY_COLOR.network;
  const exposure = withExposure(node, stroke);
  const strokeColor = exposure.wide ? exposure.color : base;
  return (
    `rounded=1;html=1;verticalAlign=top;align=left;spacingLeft=8;container=1;collapsible=1;` +
    `fillColor=${COLOR.card};strokeColor=${strokeColor};fontColor=${COLOR.ink};` +
    (exposure.wide ? "strokeWidth=2;" : "")
  );
}

/** The neutral (no change state) template style for a library entry (GP-176). */
export function templateStyleString(icon: string | null, strokeColor: string = COLOR.border): string {
  return resourceStyle(icon, COLOR.card, strokeColor, false);
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
