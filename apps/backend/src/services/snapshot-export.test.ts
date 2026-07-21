/**
 * GP-182: a PNG export can be rastered at `pngScale`× the default width for a
 * crisp image the viewer downscales (Confluence). The scale widens the raster
 * and is part of the cache key — but only when it is not 1, so every existing
 * image and every other export keep a byte-identical key.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import type { GraphSnapshotRow } from "../db/schema.js";
import type { Graph } from "../graph/graph.js";
import { cacheKey, renderSnapshotExport, type ExportRequest } from "./snapshot-export.js";

const GRAPH: Graph = {
  version: 1,
  nodes: [
    {
      id: "aws_s3_bucket.a",
      name: "a",
      type: "aws_s3_bucket",
      provider: "aws",
      module_path: [],
      change: null,
    },
  ],
  edges: [],
};

function snapshot(): GraphSnapshotRow {
  return {
    id: "00000000-0000-0000-0000-000000000001",
    ref: "main",
    commitSha: "abcdef1234567890",
    createdAt: new Date("2026-07-21T10:00:00Z"),
    graph: GRAPH,
  } as unknown as GraphSnapshotRow;
}

function req(overrides: Partial<ExportRequest> = {}): ExportRequest {
  return {
    snapshot: snapshot(),
    repoUrl: "https://github.com/acme/infra",
    format: "png",
    scope: "full",
    ...overrides,
  };
}

/** The raster width of a PNG, from its IHDR chunk (bytes 16..20, big-endian). */
function pngWidth(buffer: Buffer): number {
  return buffer.readUInt32BE(16);
}

test("pngScale widens the raster; the default (1) is the 1200px baseline", async () => {
  const base = await renderSnapshotExport(req());
  const scaled = await renderSnapshotExport(req({ pngScale: 2 }));
  assert.equal(pngWidth(base.body), 1200);
  assert.equal(pngWidth(scaled.body), 2400);
});

test("pngScale is clamped to [1, 3]; a scale of 1 changes nothing", async () => {
  const huge = await renderSnapshotExport(req({ pngScale: 9 }));
  assert.equal(pngWidth(huge.body), 3600); // 3× cap, not 9×
  const one = await renderSnapshotExport(req({ pngScale: 1 }));
  assert.equal(pngWidth(one.body), 1200);
});

test("the scale is in the cache key only when it is not 1 — old keys stay identical", () => {
  const baseline = cacheKey(req());
  assert.equal(cacheKey(req({ pngScale: 1 })), baseline);
  assert.match(cacheKey(req({ pngScale: 2 })), /-2x-v/);
  assert.notEqual(cacheKey(req({ pngScale: 2 })), baseline);
  // A scale on a non-PNG format never enters the key.
  assert.equal(
    cacheKey(req({ format: "svg", pngScale: 2 })),
    cacheKey(req({ format: "svg" })),
  );
});
