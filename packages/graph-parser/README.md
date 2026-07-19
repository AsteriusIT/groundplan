# @groundplan/graph-parser

Groundplan's **Producer B** — static HCL → GraphSnapshot — as a pure, shared
workspace package (GP-145). Consumed by the backend (docs snapshots of main,
the playground) and by the VS Code extension host (GP-147+). Workspace-internal;
not published to npm.

No server dependencies: no filesystem access at parse time, no database, no
Fastify, no environment reads. Files come in as data; a plain object comes out.
The only runtime dependency is `ajv` (the graph schema validator).

## Public API

```ts
import { parse, type HclFile, type ParseResult } from "@groundplan/graph-parser";

const result: ParseResult = parse(files, { rootDir: "" });
// result.snapshot     — the GraphSnapshot graph (schema v1..v8, additive)
// result.diagnostics  — what the parser wants to tell the author
```

- `parse(files: HclFile[], options?: { rootDir?: string }): ParseResult`
  - `HclFile` is `{ path: string; content: string }` — repository-relative,
    posix-style paths. Non-`.tf` entries are ignored, so a whole-repo file set
    is fine.
  - `rootDir` moves the parse **entrypoint** the way `terraform -chdir` does:
    every `.tf` is still available (so `../modules/shared` resolves), but
    stacks the entrypoint never reaches stay out of the graph. `""` (default)
    is the repository root.
- `Diagnostic` is `{ severity: "error" | "warning"; message: string; file?;
  range? }` where `range` is a 1-based inclusive line span. `error` means a
  file could not be parsed at all (its resources are missing from the
  snapshot); `warning` means the snapshot is complete but something deserves
  attention (an unresolved reference, a configured root with no `.tf`).

The package also exports the graph types (`Graph`, `GraphNode`, `GraphEdge`,
`NodeSource`, …), the JSON-Schema validator (`validateGraph`,
`assertValidGraph`, `computeGraphStats`) and the lower-level producer pieces
(`parseHclRepo`, `buildDependencyEdges`, the azurerm join catalog, containment,
IAM and NSG extractors) that the backend's plan producer shares.

## Guarantees

- **Snapshots are byte-identical to the pre-extraction backend parser** — the
  golden-file tests (`src/__fixtures__/graphs/*.graph.json`) moved here
  unchanged and must stay green.
- `parse` never throws on user input: an unparsable file becomes an `error`
  diagnostic and the rest of the repository still parses (last-good friendly).

## Commands

```sh
pnpm --filter @groundplan/graph-parser test        # node:test + tsx, offline
pnpm --filter @groundplan/graph-parser build       # tsc → dist/
pnpm --filter @groundplan/graph-parser typecheck
```

`exports` points types at `src/` (no build needed to typecheck or for editors)
and runtime at `dist/` (built by `prepare` on install, by `pnpm build`
topologically, and by the `dev` watch script under `pnpm dev`).
