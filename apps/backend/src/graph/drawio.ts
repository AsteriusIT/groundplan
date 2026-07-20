/**
 * Laid-out GraphSnapshot → draw.io / mxGraph XML converter (GP-174, styled in
 * GP-175). Every node becomes a real, editable cell positioned by the same
 * headless ELK layout as the SVG export (GP-37), so the exported diagram
 * mirrors the canvas; modules become collapsible container cells whose
 * children move with them. Cells are wrapped in `<object>` so the Terraform
 * address rides along as the hover tooltip. Deterministic (ADR #3): same
 * snapshot → byte-identical XML.
 */
import { categorize, shortType } from "./categories.js";
import { CATEGORY_SHAPE, edgeStyleString, moduleStyleString, nodeStyleString } from "./drawio-style.js";
import type { Graph, GraphNode } from "./graph.js";
import {
  edgeRel,
  MODULE_LEAF_WIDTH,
  RESOURCE_WIDTH,
  type LaidOutGraph,
  type PlacedNode,
} from "./layout.js";
import { esc, type SvgMeta } from "./svg.js";

// Deterministic label-width estimate (draw.io's default 12px font): a node is
// never narrower than the canvas width, but grows so 100% of the text fits.
const BOLD_CHAR_W = 7.5;
const CHAR_W = 7;
const PAD_RIGHT = 16;

/** Width for a node sized to its draw.io label — passed to `layoutGraph`. */
export function drawioNodeWidth(node: GraphNode): number {
  if (node.type === "module") {
    return Math.max(MODULE_LEAF_WIDTH, Math.ceil(8 + `module.${node.name}`.length * CHAR_W + PAD_RIGHT));
  }
  const spacingLeft = CATEGORY_SHAPE[categorize(node.type)] ? 34 : 12;
  const line = Math.max(shortType(node.type).length * BOLD_CHAR_W, node.name.length * CHAR_W);
  return Math.max(RESOURCE_WIDTH, Math.ceil(spacingLeft + line + PAD_RIGHT));
}

/** A geometry tag; coordinates are emitted verbatim so they match the layout. */
function geometry(x: number, y: number, w: number, h: number): string {
  return `<mxGeometry x="${x}" y="${y}" width="${w}" height="${h}" as="geometry"/>`;
}

function vertex(p: PlacedNode, parent: PlacedNode | undefined): string {
  // Resource labels are HTML (html=1): bold short type over the name. The
  // inner esc() protects the HTML, the outer one the XML attribute.
  const label = p.isModule
    ? esc(`module.${p.node.name}`)
    : esc(`<b>${esc(shortType(p.node.type))}</b><br/>${esc(p.node.name)}`);
  const style = p.isModule ? moduleStyleString() : nodeStyleString(p.node);
  // Children of a draw.io container are positioned relative to its origin.
  const x = p.x - (parent?.x ?? 0);
  const y = p.y - (parent?.y ?? 0);
  return (
    `<object id="${esc(p.id)}" label="${label}" tooltip="${esc(p.id)}">` +
    `<mxCell style="${style}" vertex="1" parent="${esc(parent?.id ?? "1")}">` +
    geometry(x, y, p.w, p.h) +
    `</mxCell></object>`
  );
}

/**
 * Render a laid-out graph as an uncompressed .drawio (mxfile) document. The
 * graph supplies structure (containment, edges, labels); the layout supplies
 * geometry.
 */
export function renderDrawio(graph: Graph, laidOut: LaidOutGraph, meta: SvgMeta): string {
  const byId = new Map(graph.nodes.map((n) => [n.id, n]));
  const parentOf = new Map<string, string>();
  for (const edge of graph.edges) {
    if (edge.kind === "contains") parentOf.set(edge.to, edge.from);
  }
  const placedById = new Map(laidOut.nodes.map((p) => [p.id, p]));

  // `laidOut.nodes` is a parent-before-children traversal, so containers are
  // always declared before the cells that reference them.
  const vertices = laidOut.nodes.map((p) => {
    const parent = placedById.get(parentOf.get(p.id) ?? "");
    return vertex(p, parent?.isModule ? parent : undefined);
  });

  // Laid-out routes by edge id (`dep-<index over the depends_on list>`).
  const placedEdgeById = new Map(laidOut.edges.map((pe) => [pe.id, pe]));
  const depIds = new Map<unknown, string>();
  graph.edges
    .filter((e) => e.kind === "depends_on")
    .forEach((e, i) => depIds.set(e, `dep-${i}`));

  const edges = graph.edges
    .filter((e) => e.kind !== "contains" && placedById.has(e.from) && placedById.has(e.to))
    .map((e, i) => {
      const rel = edgeRel(byId.get(e.from), byId.get(e.to));
      const label = [e.label, e.count && e.count > 1 ? `×${e.count}` : null]
        .filter(Boolean)
        .join(" ");
      const valueAttr = label ? ` value="${esc(label)}"` : "";
      // depends_on arrows flow dependency → dependent, like the canvas (GP-31),
      // and carry the ELK bend points so draw.io draws the same route.
      const isDep = e.kind === "depends_on";
      const [source, target] = isDep ? [e.to, e.from] : [e.from, e.to];
      const bends = (isDep ? (placedEdgeById.get(depIds.get(e) ?? "")?.points ?? []) : []).slice(
        1,
        -1,
      );
      const geometry = bends.length
        ? `<mxGeometry relative="1" as="geometry"><Array as="points">${bends
            .map((p) => `<mxPoint x="${p.x}" y="${p.y}"/>`)
            .join("")}</Array></mxGeometry>`
        : `<mxGeometry relative="1" as="geometry"/>`;
      return (
        `<mxCell id="e${i}"${valueAttr} style="${edgeStyleString(rel, e.inferred === true)}" edge="1" parent="1" source="${esc(source)}" target="${esc(target)}">` +
        geometry +
        `</mxCell>`
      );
    });

  const name = [meta.repoName, meta.sha.slice(0, 8)].filter(Boolean).join(" · ") || "groundplan";
  return [
    `<mxfile host="groundplan">`,
    `<diagram id="groundplan" name="${esc(name)}">`,
    `<mxGraphModel dx="0" dy="0" grid="0" gridSize="10" guides="1" tooltips="1" connect="1" arrows="1" fold="1" page="0" pageScale="1" math="0" shadow="0">`,
    `<root>`,
    `<mxCell id="0"/>`,
    `<mxCell id="1" parent="0"/>`,
    ...vertices,
    ...edges,
    `</root>`,
    `</mxGraphModel>`,
    `</diagram>`,
    `</mxfile>`,
  ].join("");
}
