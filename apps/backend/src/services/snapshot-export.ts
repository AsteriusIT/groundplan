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
import { drawioNodeWidth, renderDrawioFile, type DrawioPage } from "../graph/drawio.js";
import { iamViewGraph } from "../graph/iam-view.js";
import { layoutGraph } from "../graph/layout.js";
import { networkViewGraph } from "../graph/network-view.js";
import { renderSvg, STYLE_VERSION, type SvgMeta } from "../graph/svg.js";
import { changesSubgraph } from "../graph/subgraph.js";

export type ExportFormat = "svg" | "png" | "drawio";
export type ExportScope = "full" | "changes";
/** A lens a draw.io export can render (mirrors the app's view switcher). */
export type ExportView = "infra" | "network" | "iam";

const VIEW_ORDER: ExportView[] = ["infra", "network", "iam"];
const PAGE_NAME: Record<ExportView, string> = {
  infra: "Infrastructure",
  network: "Network",
  iam: "IAM",
};

/** Dedupe + fix the page order, so `iam,infra` and `infra,iam` are one export. */
export function canonicalViews(views: ExportView[] | undefined): ExportView[] {
  const requested = new Set(views ?? []);
  const ordered = VIEW_ORDER.filter((v) => requested.has(v));
  return ordered.length > 0 ? ordered : ["infra"];
}

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
  /** draw.io only: one page per view. SVG/PNG always render the infra view. */
  views?: ExportView[];
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

function projectView(graph: GraphSnapshotRow["graph"], view: ExportView) {
  if (view === "network") return networkViewGraph(graph);
  if (view === "iam") return iamViewGraph(graph);
  return graph;
}

/** Render a snapshot export (SVG, PNG or draw.io) without touching the cache. */
export async function renderSnapshotExport(
  req: ExportRequest,
): Promise<{ body: Buffer; contentType: string }> {
  if (req.format === "drawio") {
    // draw.io exports are always the full snapshot (GP-177): deterministic and
    // cache-friendly, never the current filter state. Each requested view
    // becomes one page of the file.
    const pages: DrawioPage[] = [];
    for (const view of canonicalViews(req.views)) {
      const graph = projectView(req.snapshot.graph, view);
      const laidOut = await layoutGraph(graph, {
        nodeWidth: drawioNodeWidth,
        nestAllContains: view === "network",
      });
      pages.push({ id: view, name: PAGE_NAME[view], graph, laidOut });
    }
    const xml = renderDrawioFile(pages);
    return { body: Buffer.from(xml, "utf8"), contentType: CONTENT_TYPE.drawio };
  }
  const svg = await renderSnapshotSvg(req);
  const body = req.format === "png" ? svgToPng(svg) : Buffer.from(svg, "utf8");
  return { body, contentType: CONTENT_TYPE[req.format] };
}

/** The cache filename: `{id}-{scope}[-{views…}]-v{style}.{format}`. */
export function cacheKey(req: ExportRequest): string {
  const views = canonicalViews(req.views);
  const viewPart = views.length === 1 && views[0] === "infra" ? "" : `-${views.join("-")}`;
  return `${req.snapshot.id}-${req.scope}${viewPart}-v${STYLE_VERSION}.${req.format}`;
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
