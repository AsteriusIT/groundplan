/**
 * Snapshot → SVG/PNG export with an on-disk cache (GP-37). Render is
 * deterministic (server-side ELK + hand-written SVG + resvg raster), so the
 * first request renders and every later request for the same snapshot + scope +
 * style version is served from disk. Reused by the PR comment (GP-38) and the
 * public share routes (GP-39).
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";

import { Resvg } from "@resvg/resvg-js";

import type { GraphSnapshotRow } from "../db/schema.js";
import { renderDrawio } from "../graph/drawio.js";
import { layoutGraph } from "../graph/layout.js";
import { renderSvg, STYLE_VERSION, type SvgMeta } from "../graph/svg.js";
import { changesSubgraph } from "../graph/subgraph.js";

export type ExportFormat = "svg" | "png" | "drawio";
export type ExportScope = "full" | "changes";

/** Default raster width, per GP-37. */
const PNG_WIDTH = 1200;

const CONTENT_TYPE: Record<ExportFormat, string> = {
  svg: "image/svg+xml; charset=utf-8",
  png: "image/png",
  drawio: "application/vnd.jgraph.mxfile",
};

export interface ExportRequest {
  snapshot: GraphSnapshotRow;
  /** Repository URL, for the title block (`owner/repo`). */
  repoUrl: string;
  format: ExportFormat;
  scope: ExportScope;
}

/** `owner/repo` from a git URL, for the title block. */
export function repoLabel(url: string): string {
  const cleaned = url.replace(/\.git$/, "").replace(/(?<!\/)\/+$/, "");
  const parts = cleaned.split("/").filter(Boolean);
  return parts.slice(-2).join("/") || cleaned;
}

function exportMeta(req: ExportRequest): SvgMeta {
  return {
    repoName: repoLabel(req.repoUrl),
    ref: req.snapshot.ref,
    sha: req.snapshot.commitSha,
    date: req.snapshot.createdAt.toISOString().slice(0, 10),
    scopeLabel: req.scope === "changes" ? "changes only" : undefined,
  };
}

/** Render the SVG for a snapshot at a given scope (no caching). */
export async function renderSnapshotSvg(req: ExportRequest): Promise<string> {
  const graph = req.scope === "changes" ? changesSubgraph(req.snapshot.graph) : req.snapshot.graph;
  const laidOut = await layoutGraph(graph);
  return renderSvg(laidOut, exportMeta(req));
}

/** Rasterize an SVG string to a PNG buffer at the default export width. */
export function svgToPng(svg: string): Buffer {
  const resvg = new Resvg(svg, {
    fitTo: { mode: "width", value: PNG_WIDTH },
    font: { loadSystemFonts: true, defaultFontFamily: "sans-serif" },
  });
  return Buffer.from(resvg.render().asPng());
}

/** Render a snapshot export (SVG, PNG or draw.io) without touching the cache. */
export async function renderSnapshotExport(
  req: ExportRequest,
): Promise<{ body: Buffer; contentType: string }> {
  if (req.format === "drawio") {
    // draw.io exports are always the full snapshot (GP-177): deterministic and
    // cache-friendly, never the current filter state.
    const graph = req.snapshot.graph;
    const xml = renderDrawio(graph, await layoutGraph(graph), exportMeta(req));
    return { body: Buffer.from(xml, "utf8"), contentType: CONTENT_TYPE.drawio };
  }
  const svg = await renderSnapshotSvg(req);
  const body = req.format === "png" ? svgToPng(svg) : Buffer.from(svg, "utf8");
  return { body, contentType: CONTENT_TYPE[req.format] };
}

/** The cache filename for a request: `{id}-{scope}-v{style}.{format}`. */
export function cacheKey(req: ExportRequest): string {
  return `${req.snapshot.id}-${req.scope}-v${STYLE_VERSION}.${req.format}`;
}

/**
 * Return a snapshot export from disk, rendering + caching it on the first
 * request. A style-version bump changes the key, transparently invalidating
 * stale images.
 */
export async function cachedSnapshotExport(
  cacheDir: string,
  req: ExportRequest,
): Promise<{ body: Buffer; contentType: string; cached: boolean }> {
  const file = join(cacheDir, cacheKey(req));
  if (existsSync(file)) {
    return { body: await readFile(file), contentType: CONTENT_TYPE[req.format], cached: true };
  }
  const { body, contentType } = await renderSnapshotExport(req);
  await mkdir(cacheDir, { recursive: true });
  await writeFile(file, body);
  return { body, contentType, cached: false };
}
