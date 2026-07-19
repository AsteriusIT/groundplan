# VS Code Extension Epic (GP-145..GP-150) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship "Groundplan for VS Code — live architecture preview" (epic GP-144): extract the HCL parser and the diagram canvas into shared workspace packages, then build a VS Code extension that renders a live, navigable architecture diagram of the workspace's Terraform, and wire up packaging/CI for the Marketplace.

**Architecture:** Two extractions first — `packages/graph-parser` (pure `parse(files) → {snapshot, diagnostics}`, the existing Producer B closure moved verbatim so goldens stay byte-identical) and `packages/canvas` (the existing `GraphCanvas` cluster moved verbatim, with old app paths kept as one-line re-export shims so the app is behavior-identical). Then `apps/vscode`: extension host bundled with esbuild (uses graph-parser), webview bundled with Vite (uses canvas + Tailwind v4 + `import.meta.glob` icons — which is why the webview must be Vite, not esbuild), `<base href>` trick + CSP for offline assets. Live loop and navigation live in the extension host; canvas gains `onNodeSelect`/`selectedAddress` controlled-selection props (GP-146 AC, consumed by GP-149).

**Tech Stack:** pnpm workspace, TypeScript strict, Node 24. graph-parser: tsc→dist (NodeNext, zero runtime deps), consumed at runtime by backend (tsx/node) and bundled by esbuild. canvas: source-only package (exports → `./src/index.ts`), consumed by Vite (app, sandbox, webview); vitest+jsdom tests in-package. Extension: `@types/vscode` ^1.90, esbuild (host, CJS), Vite (webview), `@vscode/vsce` + `ovsx` (packaging).

## Global Constraints

- One commit per GP story: `feat(scope): … (GP-xx)`; work happens on `dev`.
- TDD: tests beside their subject; backend/parser tests via `node --test`+tsx, frontend/canvas via vitest.
- Byte-identical parser output before/after extraction (existing goldens `hcl-repo.graph.json`, `hcl-expressions.graph.json` must pass unmodified).
- Web app renders identically after canvas extraction (all existing frontend tests pass unmodified except path/mocking updates; design-tokens guard updated to govern package sources).
- Never hardcode a colour in canvas code; tokens only (design-tokens guard).
- Extension: fully offline, strict CSP, no telemetry, never sends code anywhere.
- Backend ESM/NodeNext: relative imports use `.js` extensions. Frontend/canvas: Bundler resolution, extensionless.
- `packages/graph-parser` has no server deps (no fs at parse time, no drizzle/fastify/env). `packages/canvas` has no imports from app code.

---

### Task 1 (GP-145): Extract `packages/graph-parser`

**Files:**
- Create: `packages/graph-parser/package.json`, `tsconfig.json`, `tsconfig.build.json`, `README.md`
- Create: `packages/graph-parser/src/graph-types.ts` (types moved out of backend `graph.ts` + `AttributeDiffRow` moved out of `attribute-diff.ts`)
- Create: `packages/graph-parser/src/parse.ts` + `parse.test.ts` (the epic's public `parse()` + `Diagnostic`)
- Create: `packages/graph-parser/src/index.ts` (barrel)
- Move (git mv, content unchanged except import extensions stay `.js` and `./graph.js` → `./graph-types.js` type imports): from `apps/backend/src/graph/`: `hcl-parser.ts`, `dependency-edges.ts`, `azurerm-joins.ts`, `containment.ts`, `iam.ts`, `nsg.ts` + their 6 `*.test.ts` files → `packages/graph-parser/src/`
- Move fixtures used by those tests: `apps/backend/src/graph/__fixtures__/{hcl-repo,hcl-expressions,hcl-iam,hcl-joins,hcl-nsg,hcl-stacking}/` and `__fixtures__/graphs/{hcl-repo,hcl-expressions}.graph.json` → `packages/graph-parser/src/__fixtures__/…` (same relative layout). First grep backend for other users of these fixtures; if any backend test uses them, copy instead of move for that fixture.
- Modify: `apps/backend/src/graph/graph.ts` — delete local type declarations, re-export all types from `@groundplan/graph-parser`, keep `validateGraph`/`assertValidGraph`/`InvalidGraphError`/`computeGraphStats` + Ajv/schema loading.
- Modify: `apps/backend/src/graph/attribute-diff.ts` — remove `AttributeDiffRow` declaration; `import type { AttributeDiffRow } from "@groundplan/graph-parser"` and re-export it.
- Modify: `apps/backend/src/graph/plan-parser.ts` — import `attribute-diff` bits locally as today; import `azurerm-joins`/`containment`/`dependency-edges`/`iam`/`nsg` symbols + graph types from `@groundplan/graph-parser`.
- Modify: `apps/backend/src/services/repo-docs.ts`, `apps/backend/src/routes/playground.ts` — `parseHclRepo`/`HclFile` from `@groundplan/graph-parser`.
- Modify: `apps/backend/package.json` — add `"@groundplan/graph-parser": "workspace:*"` to dependencies.
- Check/modify: `apps/backend/Dockerfile` — must build the package before the backend (workspace build is topological via `pnpm -r`).
- Modify: `CLAUDE.md` — packages section: graph-parser is the home of the HCL producer + graph types.

**Interfaces (produced, relied on by Tasks 3–5):**
```ts
// @groundplan/graph-parser
export interface HclFile { path: string; content: string }
export interface DiagnosticRange { start_line: number; end_line: number }
export interface Diagnostic { severity: "error" | "warning"; message: string; file?: string; range?: DiagnosticRange }
export interface ParseResult { snapshot: Graph; diagnostics: Diagnostic[] }
export function parse(files: HclFile[], options?: HclParseOptions): ParseResult
// plus everything parseHclRepo already exports, and all graph types (Graph, GraphNode, GraphEdge, NodeSource, …)
```
`parse()` wraps `parseHclRepo` (unchanged): `skipped <path>: <reason>` warnings → `{severity:"error", file, message}`; other warnings → `{severity:"warning", message}`; each `UnresolvedReference` → `{severity:"warning", message, file+range from the from-node's source when present}`.

**Package config:**
```json
{
  "name": "@groundplan/graph-parser",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "exports": { ".": { "types": "./src/index.ts", "default": "./dist/index.js" } },
  "scripts": {
    "build": "tsc -p tsconfig.build.json",
    "prepare": "tsc -p tsconfig.build.json",
    "dev": "tsc -p tsconfig.build.json --watch --preserveWatchOutput",
    "test": "node --import tsx --test \"src/**/*.test.ts\"",
    "typecheck": "tsc --noEmit",
    "clean": "rm -rf dist *.tsbuildinfo"
  },
  "devDependencies": { "@types/node": "^22.13.1", "tsx": "^4.19.2", "typescript": "^5.7.3" }
}
```
tsconfig: extends base, `module`/`moduleResolution` NodeNext, `rootDir: src`, `outDir: dist`, `declaration: true`; build config excludes `*.test.ts` and `__fixtures__`. Types condition points at source so backend typecheck/editor need no prior build; runtime (`tsx`, `node`) uses `dist` (built by `prepare` on install, `dev` watch, and topological `pnpm build`).

- [ ] Steps: move files; write failing `parse.test.ts` (broken fixture → error diagnostic with file; hcl-repo fixture → snapshot equals golden + unresolved-ref warnings carry file/range); implement `graph-types.ts`/`parse.ts`/`index.ts`; update backend imports; `pnpm install`; run package tests + full backend suite (`pnpm --filter @groundplan/backend test`) + `pnpm typecheck`; commit `feat(graph-parser): extract Producer B core as a pure shared package (GP-145)`.

### Task 2 (GP-146): Extract `packages/canvas`

**Files:**
- Create: `packages/canvas/{package.json,tsconfig.json,vite.config.ts,index.html,README.md}`
- Create: `packages/canvas/src/types.ts` — graph/annotation/tour types copied from `apps/frontend/src/api/types.ts` (Graph, GraphNode, GraphEdge, ChangeKind, EdgeKind, NodeSource, NsgRule, RoleAssignment, Identity, AttributeDiffRow, Annotation + Create/UpdateAnnotationInput, AnnotationType/Status/Provenance, TourStep as needed by moved files). App `api/types.ts` re-exports these names from the package (single definition).
- Create: `packages/canvas/src/styles.css` — `@import "tailwindcss"; @source "./";` + fontsource imports + the full token blocks (`:root`, `.dark`, `.dark[data-theme="carbon"]`, `@theme inline`, `.blueprint-grid`) copied from app `index.css`.
- Create: `packages/canvas/src/test-setup.ts` — jsdom polyfills (ResizeObserver, matchMedia, pointer capture, scrollIntoView) trimmed from app `test-setup.ts` (no org/api bits).
- Create: `packages/canvas/src/sandbox/main.tsx` + fixture snapshot JSON (copy of `hcl-repo.graph.json`) — dev-only Vite sandbox proving one-import webview readiness.
- Move (git mv → `packages/canvas/src/`, rewriting `@/` imports to relative):
  - components: `graph-canvas.tsx`, `graph-node.tsx`, `graph-edge.tsx`, `network-container-node.tsx`, `group-container-node.tsx`, `attachment-chip.tsx`, `node-details-panel.tsx`, `note-editor.tsx`, `change-summary.tsx`, `tour-spotlight.tsx`, `tour-chrome.ts` (type), `resource-icon.tsx`, `copy-button.tsx`, `ai-response.tsx`
  - ui: `chip.tsx`, `status-badge.tsx`, `side-panel.tsx`, `button.tsx`, `dialog.tsx`, `ai-badge.tsx`
  - lib: `graph-layout.ts`, `edge-path.ts`, `hub.ts`, `hub-config.ts`, `graph-search.ts`, `resource-category.ts`, `status.ts`, `node-details.ts`, `hcl-highlight.ts`, `annotations.ts`, `annotate-tool.ts`, `utils.ts` (cn)
  - `panel/panel-prefs.tsx`, `tour/tour-style.tsx` (check: if `tour-style` drags app deps, move only the `TourStyle` type into `types.ts` instead)
  - `icons/` — whole directory (registries + maps + SVG assets)
  - plus each file's `*.test.ts(x)` beside it
- Replace every moved file's old app path with a one-line shim re-exporting the same names from `@groundplan/canvas` (keeps every remaining app import and `vi.mock` path working; grep-verify each old path's importers).
- Modify: `apps/frontend/src/index.css` — add `@source "../../../packages/canvas/src";`
- Modify: `apps/frontend/src/design-tokens.test.ts` — govern the moved sources at `../../packages/canvas/src/…`, and assert the package `styles.css` declares the key tokens too.
- Modify: `apps/frontend/package.json` — add `"@groundplan/canvas": "workspace:*"`.
- New canvas props (TDD in `graph-canvas.test.tsx`): `onNodeSelect?: (node: GraphNode | null) => void` (fires on node click/pane clear) and `selectedAddress?: string | null` (controlled external selection; no camera animation; fly only if off-viewport).
- Modify: `CLAUDE.md` — canvas package section.

**Package config:** name `@groundplan/canvas`, `exports: { ".": "./src/index.ts", "./styles.css": "./src/styles.css" }`; peerDeps `react`/`react-dom` ^19; deps `@xyflow/react`, `elkjs`, `lucide-react`, `clsx`, `tailwind-merge`, `class-variance-authority`, `radix-ui`, `@radix-ui/react-slot`, `react-markdown`, `remark-gfm`, `@fontsource-variable/inter`, `@fontsource-variable/space-grotesk`, `@fontsource/ibm-plex-mono`; devDeps vite/vitest/jsdom/testing-library/tailwind/@tailwindcss/vite/@vitejs/plugin-react/typescript/@types/react(-dom); scripts `dev` (vite sandbox), `test` (vitest run), `typecheck`, no build.

- [ ] Steps: scaffold package; move+rewrite files; shims; types re-export; styles.css; move tests + setup; add `onNodeSelect`/`selectedAddress` with failing tests first; run package tests, full frontend suite, typecheck; run sandbox build (`vite build`) as webview-readiness proof; commit `feat(canvas): extract reusable Groundplan canvas package (GP-146)`.

### Task 3 (GP-147): VS Code extension scaffold

**Files:** `apps/vscode/package.json` (manifest: name `groundplan-vscode`, displayName "Groundplan — Terraform Architecture Preview", `engines.vscode ^1.90.0`, `main: dist/extension.cjs`, command `groundplan.openPreview` "Groundplan: Open Preview", activationEvents `onLanguage:terraform`), `tsconfig.json`, `esbuild.mjs` (host → `dist/extension.cjs`, external `vscode`), `webview/` Vite root (`index.html` optional — HTML is generated by the host; Vite builds `webview/main.tsx` → `dist/webview/` with stable entry names), `src/extension.ts` (activate/register command/panel `ViewColumn.Beside`, `retainContextWhenHidden: true`, multi-root banner), `src/workspace-files.ts` (`gatherTfFiles`: findFiles `**/*.tf` excluding `**/{.terraform,node_modules}/**`, posix-relative paths) + test for the pure path/exclude helpers, `src/webview-html.ts` (CSP + `<base href>` builder, nonce) + test.

**Message protocol (produced, used by Tasks 4–5):** host→webview `{type:"snapshot", snapshot: Graph}`, `{type:"multiRoot", folders: string[]}`; webview→host `{type:"ready"}`.

- [ ] Steps: scaffold; TDD the pure helpers (node:test via tsx); wire host parse (`parse()` from graph-parser) + postMessage; webview React app rendering `<GraphCanvas graph variant="docs" />` with package styles; build both bundles; verify with `code --extensionDevelopmentPath` manually documented (can't run GUI here — assert bundles build, webview HTML passes CSP checks in tests); commit `feat(vscode): extension scaffold — preview command + webview canvas (GP-147)`.

### Task 4 (GP-148): Live update loop

**Files:** `apps/vscode/src/live-preview.ts` — debounced (500ms) `onDidChangeTextDocument` + `FileSystemWatcher` for create/delete/rename; gather with open-dirty-docs overlay; full re-parse; last-good contract (error diagnostics ⇒ keep last graph, `{type:"outOfSync", value:true}`); `DiagnosticCollection("groundplan")` mapping `Diagnostic.range` (1-based lines) → VS Code `Range` (0-based, full lines), cleared on success. Pure mapping + debounce + overlay logic in `src/live-core.ts` with node:test coverage. Webview: out-of-sync indicator chip in `webview/main.tsx`.

- [ ] Steps: TDD `live-core.ts` (overlay precedence, error→last-good decision, diagnostic mapping); wire into extension; commit `feat(vscode): live preview — watch, debounce, last-good, Problems panel (GP-148)`.

### Task 5 (GP-149): Node ↔ code navigation

**Files:** `apps/vscode/src/locate.ts` (pure: `nodeAtPosition(snapshot, relPath, line)` → innermost node whose `source` spans the line; `sourceOf(snapshot, address)`) + tests; extension: webview `onNodeSelect` → post `{type:"nodeSelected", address}`; host resolves via `sourceOf`, `window.showTextDocument` with selection + ~1s decoration fade; `onDidChangeTextEditorSelection` (debounced 200ms) → `nodeAtPosition` → post `{type:"select", address}` → webview sets `selectedAddress` on GraphCanvas. Guard loops by skipping when the address is already selected.

- [ ] Steps: TDD `locate.ts`; wire both directions; commit `feat(vscode): node↔code navigation (GP-149)`.

### Task 6 (GP-150): Packaging & Marketplace wiring

**Files:** `apps/vscode/media/icon.png` (rendered from an SVG via backend's `@resvg/resvg-js` in a scratch script), `apps/vscode/.vscodeignore` (ship only `dist/`, `media/`, `README.md`, `LICENSE`), `apps/vscode/LICENSE` (MIT, mirroring `packages/cli`), `apps/vscode/README.md` (listing copy: offline/no-credentials guarantee prominent, GIF placeholder path documented, link to web product, categories/keywords in manifest), `package.json` additions (publisher, categories `["Visualization","Other"]`, keywords, repository, `icon`, scripts `package`: build all + `vsce package --no-dependencies`), `docs/vscode-publishing.md` (one-time publisher setup, PAT secrets, smoke-test checklist), `.github/workflows/vscode-extension.yml` (build+package on `vscode-v*` tags & dispatch; artifact upload; Marketplace publish gated on `VSCE_PAT`, Open VSX on `OVSX_PAT`).

- [ ] Steps: icon; ignore file; README/docs; workflow; run `vsce package --no-dependencies` locally, assert `.vsix` < 5 MB and contents lean; commit `feat(vscode): packaging & marketplace release wiring (GP-150)`.

### Post-tasks

- [ ] Run full `pnpm test` + `pnpm typecheck` + `pnpm build` at root.
- [ ] Transition GP-145..150 to Done (transition id 41); comment on GP-150 listing the human-only steps (publisher account, VSCE_PAT/OVSX_PAT secrets, GIF recording, actual first publish).

## Self-Review notes

- GP-145 AC "byte-identical goldens": covered by moving `hcl-parser.test.ts` + goldens untouched; backend repo flow covered by existing `repo-docs` tests running against the package.
- GP-146 AC "standalone sandbox with one CSS import": Task 2 sandbox; "selection events + selectedAddress": explicit TDD step.
- GP-147 AC "offline/CSP": webview-html tests assert CSP forbids remote origins; all assets via base-href-relative bundled files.
- GP-148 AC "syntax error keeps graph + Problems entry": last-good decision is exactly "any error-severity diagnostic"; skipped-file diagnostics carry the file path from GP-145's `parse()`.
- GP-149 AC "no loops": same-address guard both directions.
- GP-150 AC items requiring human accounts are documented, not faked.
