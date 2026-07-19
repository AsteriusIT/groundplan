/**
 * Renders the website hero image through the REAL export pipeline (GP-37):
 * plan-parser → impact propagation → ELK layout → renderSvg. The output is a
 * genuine Groundplan PR diagram of the groundplan-example change, not a mockup
 * (GP-159 acceptance criterion).
 *
 * Run from the repo root:
 *   pnpm --filter @groundplan/backend exec tsx ../website/assets-src/render-hero.ts
 */
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { parsePlanToGraph } from "../../backend/src/graph/plan-parser.js";
import { layoutGraph } from "../../backend/src/graph/layout.js";
import { renderSvg, type SvgMeta } from "../../backend/src/graph/svg.js";
import { changesSubgraph } from "../../backend/src/graph/subgraph.js";

const here = dirname(fileURLToPath(import.meta.url));
const outDir = join(here, "..", "public", "images");
mkdirSync(outDir, { recursive: true });

const plan: unknown = JSON.parse(
  readFileSync(join(here, "groundplan-example.plan.json"), "utf8"),
);

const graph = parsePlanToGraph(plan);
const changed = graph.nodes.filter((n) => n.change && n.change !== "noop").length;
const impacted = graph.nodes.filter((n) => n.impacted === true).length;
console.log(`graph: ${graph.nodes.length} nodes, ${graph.edges.length} edges`);
console.log(`  changed: ${changed}, impacted: ${impacted}`);

const meta: SvgMeta = {
  repoName: "asteriusit/groundplan-example",
  ref: "feat/redis-session-cache",
  sha: "9f3c2a7e41b8",
  date: "2026-07-19",
};

const full = renderSvg(await layoutGraph(graph), meta);
writeFileSync(join(outDir, "hero-pr-diagram.svg"), full);
console.log(`wrote hero-pr-diagram.svg (${(full.length / 1024).toFixed(1)} KB)`);

const changes = renderSvg(await layoutGraph(changesSubgraph(graph)), {
  ...meta,
  scopeLabel: "changes only",
});
writeFileSync(join(outDir, "hero-pr-diagram-changes.svg"), changes);
console.log(`wrote hero-pr-diagram-changes.svg (${(changes.length / 1024).toFixed(1)} KB)`);

// OG image (GP-164): the same hero export, rasterized — scrapers don't read
// SVG. Resolved from the backend package, which owns the resvg dependency.
const { createRequire } = await import("node:module");
const backendRequire = createRequire(join(here, "..", "..", "backend", "package.json"));
const { Resvg } = backendRequire("@resvg/resvg-js") as {
  Resvg: new (
    svg: string,
    opts?: { fitTo?: { mode: "width"; value: number } },
  ) => { render(): { asPng(): Uint8Array } };
};
const png = new Resvg(full, { fitTo: { mode: "width", value: 1200 } }).render().asPng();
writeFileSync(join(outDir, "og-image.png"), png);
console.log(`wrote og-image.png (${(png.length / 1024).toFixed(1)} KB)`);
