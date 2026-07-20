/**
 * Laid-out GraphSnapshot → draw.io / mxGraph XML converter (GP-174). Every
 * node becomes a real, editable mxCell vertex positioned by the same headless
 * ELK layout as the SVG export (GP-37), so the exported diagram mirrors the
 * canvas; modules become collapsible container cells whose children move with
 * them. Deterministic (ADR #3): same snapshot → byte-identical XML.
 */
import type { Graph } from "./graph.js";
import type { LaidOutGraph, PlacedNode } from "./layout.js";
import { esc, type SvgMeta } from "./svg.js";

const MODULE_STYLE =
  "rounded=1;html=1;verticalAlign=top;align=left;spacingLeft=8;container=1;collapsible=1;";
const RESOURCE_STYLE = "rounded=1;whiteSpace=wrap;html=1;";
const EDGE_STYLE = "edgeStyle=orthogonalEdgeStyle;rounded=1;html=1;";

/** A geometry tag; coordinates are emitted verbatim so they match the layout. */
function geometry(x: number, y: number, w: number, h: number): string {
  return `<mxGeometry x="${x}" y="${y}" width="${w}" height="${h}" as="geometry"/>`;
}

function vertex(p: PlacedNode, parent: PlacedNode | undefined): string {
  const value = p.isModule ? `module.${p.node.name}` : p.node.name;
  const style = p.isModule ? MODULE_STYLE : RESOURCE_STYLE;
  // Children of a draw.io container are positioned relative to its origin.
  const x = p.x - (parent?.x ?? 0);
  const y = p.y - (parent?.y ?? 0);
  return (
    `<mxCell id="${esc(p.id)}" value="${esc(value)}" style="${style}" vertex="1" parent="${esc(parent?.id ?? "1")}">` +
    geometry(x, y, p.w, p.h) +
    `</mxCell>`
  );
}

/**
 * Render a laid-out graph as an uncompressed .drawio (mxfile) document. The
 * graph supplies structure (containment, edges); the layout supplies geometry.
 */
export function renderDrawio(graph: Graph, laidOut: LaidOutGraph, meta: SvgMeta): string {
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

  const edges = graph.edges
    .filter((e) => e.kind !== "contains" && placedById.has(e.from) && placedById.has(e.to))
    .map(
      (e, i) =>
        `<mxCell id="e${i}" style="${EDGE_STYLE}" edge="1" parent="1" source="${esc(e.from)}" target="${esc(e.to)}">` +
        `<mxGeometry relative="1" as="geometry"/>` +
        `</mxCell>`,
    );

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
