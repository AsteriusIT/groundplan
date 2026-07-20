/**
 * Deterministic, template-based SVG rendering of a laid-out GraphSnapshot
 * (GP-37). No headless browser: we emit SVG by hand so the output is stable,
 * cacheable and cheap. Colours mirror the frontend blueprint tokens (the single
 * source of colour truth) — restated here as hex because the backend has no CSS.
 *
 * Bump STYLE_VERSION whenever the visual output changes; it is part of the
 * export cache key, so a bump transparently invalidates every cached image.
 */
import type { LaidOutGraph, PlacedNode, PlacedEdge, EdgeRel } from "./layout.js";
import { categorize, shortType, type Category } from "./categories.js";
import type { ChangeKind, GraphNode } from "./graph.js";

/** Cache-busting version tag — bump on any visual change. */
export const STYLE_VERSION = "6";

// Blueprint tokens (see apps/frontend/src/index.css). Restated as hex here and
// shared with the draw.io exporter (GP-175) — the backend's single colour table.
export const COLOR = {
  canvas: "#fbfdff",
  card: "#ffffff",
  ink: "#182a42",
  muted: "#5d7391",
  border: "#e3e9f2",
  borderStrong: "#cdd8e8",
  edge: "#a6b8d0",
  accentSoft: "#eaf1fe",
  create: "#189a5c",
  createSoft: "#e8f7ef",
  update: "#c77e10",
  updateSoft: "#fbf3e4",
  delete: "#d8503f",
  deleteSoft: "#fdf1ef",
  impacted: "#7b5bd6",
  impactedSoft: "#f1edfc",
  exposed: "#d4531e",
} as const;

export const CATEGORY_COLOR: Record<Category, string> = {
  compute: "#2563c9",
  network: "#0e8f9e",
  data: "#4f46c7",
  security: "#c23a63",
  identity: "#b5760f",
  observability: "#a032b8",
  other: "#5d7391",
};

export const EDGE_COLOR: Record<EdgeRel, string> = {
  new: COLOR.create,
  removed: COLOR.delete,
  impact: COLOR.impacted,
  neutral: COLOR.edge,
};

/** Fill / stroke for a node given its change + impacted status. */
export function nodeStyle(node: GraphNode): { fill: string; stroke: string; dashed: boolean } {
  if (node.impacted && node.change !== "create" && node.change !== "delete") {
    return { fill: COLOR.impactedSoft, stroke: COLOR.impacted, dashed: false };
  }
  const change: ChangeKind | null = node.change;
  switch (change) {
    case "create":
      return { fill: COLOR.createSoft, stroke: COLOR.create, dashed: false };
    case "update":
      return { fill: COLOR.updateSoft, stroke: COLOR.update, dashed: false };
    case "delete":
      return { fill: COLOR.deleteSoft, stroke: COLOR.delete, dashed: true };
    default:
      return { fill: COLOR.card, stroke: COLOR.border, dashed: false };
  }
}

/** Escape the five XML-significant characters. */
export function esc(text: string): string {
  return text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

/** Truncate a label to a character budget with an ellipsis. */
function clip(text: string, max: number): string {
  return text.length > max ? text.slice(0, max - 1) + "…" : text;
}

const round = (n: number): string => (Math.round(n * 100) / 100).toString();

/** Metadata shown in the title block; `date` is passed in so output is stable. */
export interface SvgMeta {
  repoName: string;
  ref: string;
  sha: string;
  /** Human date string (deterministic — derived from the snapshot, not "now"). */
  date: string;
  /** Extra label, e.g. "changes only". */
  scopeLabel?: string;
}

const FONT_SANS = "'Helvetica Neue', Helvetica, Arial, sans-serif";
const FONT_MONO = "'DejaVu Sans Mono', 'Courier New', monospace";

const PAD = 28; // gutter around the diagram
const TITLE_H = 70; // title block band at the top
const LEGEND_H = 34; // legend band at the bottom

const LEGEND: { label: string; color: string }[] = [
  { label: "Create", color: COLOR.create },
  { label: "Update", color: COLOR.update },
  { label: "Delete", color: COLOR.delete },
  { label: "Impacted", color: COLOR.impacted },
];

function renderNode(p: PlacedNode): string {
  if (p.isModule) {
    // Module container: dashed boundary + floating label.
    return [
      `<rect x="${round(p.x)}" y="${round(p.y)}" width="${round(p.w)}" height="${round(p.h)}" rx="10"`,
      ` fill="${COLOR.accentSoft}" fill-opacity="0.35" stroke="${COLOR.borderStrong}" stroke-width="1" stroke-dasharray="4 3"/>`,
      `<text x="${round(p.x + 12)}" y="${round(p.y + 18)}" font-family="${FONT_MONO}" font-size="11" fill="${COLOR.muted}">module.${esc(clip(p.node.name, 28))}</text>`,
    ].join("");
  }

  const style = nodeStyle(p.node);
  const cat = CATEGORY_COLOR[categorize(p.node.type)];
  const dash = style.dashed ? ` stroke-dasharray="5 3"` : "";
  const label = clip(shortType(p.node.type), 24);
  const name = clip(p.node.name, 26);
  return [
    `<rect x="${round(p.x)}" y="${round(p.y)}" width="${round(p.w)}" height="${round(p.h)}" rx="8"`,
    ` fill="${style.fill}" stroke="${style.stroke}" stroke-width="1.5"${dash}/>`,
    `<circle cx="${round(p.x + 14)}" cy="${round(p.y + p.h / 2)}" r="5" fill="${cat}"/>`,
    `<text x="${round(p.x + 28)}" y="${round(p.y + 22)}" font-family="${FONT_SANS}" font-size="13" font-weight="600" fill="${COLOR.ink}">${esc(label)}</text>`,
    `<text x="${round(p.x + 28)}" y="${round(p.y + 40)}" font-family="${FONT_MONO}" font-size="11" fill="${COLOR.muted}">${esc(name)}</text>`,
  ].join("");
}

function renderEdge(e: PlacedEdge): string {
  if (e.points.length < 2) return "";
  const d =
    `M ${round(e.points[0]!.x)} ${round(e.points[0]!.y)} ` +
    e.points
      .slice(1)
      .map((pt) => `L ${round(pt.x)} ${round(pt.y)}`)
      .join(" ");
  const color = EDGE_COLOR[e.rel];
  const dash = e.inferred ? ` stroke-dasharray="4 3"` : "";
  return `<path d="${d}" fill="none" stroke="${color}" stroke-width="1.5"${dash} marker-end="url(#arrow-${e.rel})"/>`;
}

/** One arrowhead marker per relationship colour. */
function defs(): string {
  const markers = (Object.keys(EDGE_COLOR) as EdgeRel[])
    .map(
      (rel) =>
        `<marker id="arrow-${rel}" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="6" markerHeight="6" orient="auto-start-reverse">` +
        `<path d="M0 0 L8 4 L0 8 z" fill="${EDGE_COLOR[rel]}"/></marker>`,
    )
    .join("");
  return `<defs>${markers}</defs>`;
}

function titleBlock(meta: SvgMeta, width: number): string {
  const scope = meta.scopeLabel ? ` · ${esc(meta.scopeLabel)}` : "";
  const sub = `${esc(meta.ref)} · ${esc(meta.sha.slice(0, 8))} · ${esc(meta.date)}${scope}`;
  return [
    `<text x="${PAD}" y="26" font-family="${FONT_SANS}" font-size="16" font-weight="700" fill="${COLOR.ink}">${esc(clip(meta.repoName, 60))}</text>`,
    `<text x="${PAD}" y="46" font-family="${FONT_MONO}" font-size="11" fill="${COLOR.muted}">${sub}</text>`,
    `<text x="${round(width - PAD)}" y="26" text-anchor="end" font-family="${FONT_SANS}" font-size="12" font-weight="600" fill="${COLOR.edge}">groundplan</text>`,
    `<line x1="${PAD}" y1="${TITLE_H - 8}" x2="${round(width - PAD)}" y2="${TITLE_H - 8}" stroke="${COLOR.border}" stroke-width="1"/>`,
  ].join("");
}

function legendBlock(y: number): string {
  let x = PAD;
  const items = LEGEND.map(({ label, color }) => {
    const swatch = `<rect x="${round(x)}" y="${round(y - 9)}" width="10" height="10" rx="2" fill="${color}"/>`;
    const text = `<text x="${round(x + 16)}" y="${round(y)}" font-family="${FONT_SANS}" font-size="11" fill="${COLOR.muted}">${label}</text>`;
    x += 16 + label.length * 7 + 20;
    return swatch + text;
  }).join("");
  return items;
}

/**
 * Render a laid-out graph to a complete SVG document string. The diagram is
 * offset below the title band; the legend sits in the bottom gutter.
 */
export function renderSvg(laidOut: LaidOutGraph, meta: SvgMeta): string {
  const graphW = Math.max(laidOut.width, 320);
  const graphH = Math.max(laidOut.height, 80);
  const width = graphW + PAD * 2;
  const height = TITLE_H + graphH + LEGEND_H + PAD;

  // Shift the whole diagram into place below the title block.
  const body = [
    `<g transform="translate(${PAD} ${TITLE_H})">`,
    ...laidOut.edges.map(renderEdge),
    // Modules first so resource nodes paint on top of their container.
    ...laidOut.nodes.filter((n) => n.isModule).map(renderNode),
    ...laidOut.nodes.filter((n) => !n.isModule).map(renderNode),
    `</g>`,
  ].join("");

  return [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${round(width)}" height="${round(height)}" viewBox="0 0 ${round(width)} ${round(height)}" font-family="${FONT_SANS}">`,
    defs(),
    `<rect width="${round(width)}" height="${round(height)}" fill="${COLOR.canvas}"/>`,
    titleBlock(meta, width),
    body,
    legendBlock(height - PAD / 2),
    `</svg>`,
  ].join("");
}
