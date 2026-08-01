# VS Code panel UI/UX refactor — Lot 0 reconnaissance

What the plan assumes, what the code actually is, and what has to change in the
plan before any of it is implemented. Read with the plan (the "Lot" numbering
below is the plan's).

Verified against the tree at `8bc37cb` (2026-08-01).

## 1. The real file map

### Extension host — `apps/vscode/src/`

| File | Lines | What it owns |
| --- | --- | --- |
| `extension.ts` | 660 | `activate()` registers the single command `groundplan.openPreview`; the `LivePreview` class is the whole host — the webview **panel**, the debounced re-parse (500 ms), the cursor→node lane (200 ms), the diff computation, the `workspaceState` preferences, Problems publishing, and the three settings listeners |
| `messages.ts` | 90 | The entire host↔webview protocol, already discriminated unions |
| `git-baseline.ts` | 369 | `BaselineProvider` (mode→sha, sha→files+snapshot, two-level cache), `Baseline { sha, ref, files, snapshot }`, `watchGitChanges` |
| `live-core.ts` | 166 | `createDebouncer`, `createSignatureTracker` (post suppression), `toFileDiagnostics`, `postWhileCurrent` (generation-guarded posting) |
| `locate.ts` | 36 | `nodeAtPosition` (cursor→node) and `sourceOf` (node→code) |
| `root-dir.ts`, `tf-files.ts`, `paths.ts`, `workspace-files.ts` | 390 | Entrypoint resolution, the warm `.tf` cache, path helpers |
| `webview-html.ts` | 64 | The strict-CSP HTML shell (nonce, `<base>`, baked-in theme) |

Tests sit beside their subject and run through
`node --import tsx --test "src/**/*.test.ts"`. `bundle.test.ts` guards the built
webview bundle (no Markdown renderer).

### Webview — `apps/vscode/webview/`

`main.tsx` (366 lines) is the **entire** UI: one `App` component, a local `Pill`
and an `EmptyState`. State is eight `useState` hooks in `App` — no store, no
context, no reducer. Everything the plan calls "the toolbar" is one absolutely
positioned, horizontally centred `div` at `top-3`:

- the three view pills (`infra` / `network` / `iam`), `main.tsx:234-241`
- the Diff toggle button, `main.tsx:249-263`
- the baseline `<select>` (`vs HEAD` / `vs main`), `main.tsx:266-276`
- the "Changed only" checkbox, `main.tsx:277-292`

The permanent floating elements the plan wants gone:

- "No changes vs {ref}" pill — `main.tsx:304-308`
- "Code diff vs {ref} — not a plan…" note — `main.tsx:347-355`
- (also floating, not in the plan: the multi-root warning `223-227` and the
  out-of-sync chip `228-232`)

There is **no test runner for the webview**. Nothing under `webview/` is tested.

### Shared canvas — `packages/canvas/src/components/graph-canvas.tsx` (1725 lines)

Consumed by both the web frontend and this webview. It renders, unconditionally:

| Chrome | Location |
| --- | --- |
| Zoom in / out / fit toolbar (top-right) | `graph-canvas.tsx:1153-1172` |
| Zoom % + "scroll to zoom · drag to pan" (bottom-right) | `1174-1182` |
| Left rail: search box + results, then the Filters panel (top-left) | `1196-1348` |
| `EdgeLegend` (bottom-left) | `260-308`, mounted at `1352` |
| "Laying out diagram…" overlay | `1184-1194` |
| Node details panel | `1354`, opt-out via the `detailsPanel` prop |

Its filter and search state is **internal and unexposed**: `activeFilters`,
`activeCategories`, `activeModules`, `showHubEdges`, `query`, `zoom`,
`filtersOpen` (`478-532`). The React Flow instance lives in a private `rfRef`.
`/` already focuses the search box (`631-638`).

### Differ — `packages/graph-differ`

Exports `diff`, `isAllNoop`, `changedOnly`, `propagateImpact`, the attribute
diff and canonicalisation. There is **no summary/count function**. Counts are
derivable from the annotated graph (`node.change`, impact flags);
`packages/canvas/src/lib/graph-layout.ts:189` defines
`FilterKey = "create" | "update" | "delete" | "noop" | "impacted"` and
`changeCounts()` already folds them for the canvas.

## 2. Deviations that change the plan

**D1 — Search, filters, legend and zoom are not in the VS Code toolbar.**
They are inside the shared `GraphCanvas`, always on, with private state. Lots 2
(search/filter icons), 5 (filter chips), 6 (legend popover) and 7 (zoom overlay)
therefore all require changing `packages/canvas` and lifting its state out —
not one lot as the plan assumes, but four. The plan's own constraint ("any
canvas change must be opt-in, never a default behaviour change") applies to all
of them.

**D2 — There is no overlay/slot API on the canvas, and no exposed React Flow
instance.** Lot 7 says "via `packages/canvas`'s overlay API if it exists" — it
does not. Zoom buttons need `rfRef`, which is private, so an `overlay?:
ReactNode` prop alone cannot move them: repositioning the zoom cluster is a
canvas-internal change, gated by a prop.

**D3 — Lot 8 (follow cursor) already ships.** GP-149 wired
`onDidChangeTextEditorSelection` → `nodeAtPosition` → `select` →
`selectedAddress`, debounced at **200 ms** (the plan says ~150). What is missing
is only: the toggle, its persistence, and "recentre only when the node is off
screen" — the canvas currently calls `flyTo` unconditionally
(`graph-canvas.tsx:1029-1036`), so that last part is another canvas change.

**D4 — Persistence partly exists.** `workspaceState` already holds
`groundplan.diff.enabled` / `.mode` / `.changedOnly` and
`groundplan.rootDir.picked` (`extension.ts:60-65`). Lens is not persisted;
filters cannot be (see D1). Introducing a versioned `groundplan.panelState.v1`
means migrating four live keys, not starting from nothing.

**D5 — There are two diff bases, not three.** `BaselineMode = "head" |
"merge-base"`; `merge-base` *is* "vs main". The Lot 3 radio group has two
options.

**D6 — The wire has the ref name but not the sha.** `DiffState.ref` is a
string like `origin/main`; `Baseline.sha` exists host-side but is never posted.
Lot 4's "base + short SHA" needs one new field on `DiffState`.

**D7 — There is no sync state on the wire, and adding one is not free.**
`outOfSync` means "the last parse failed", not "rendering". The host
deliberately stays silent when nothing it renders moved
(`signatureTracker.shouldPost`, `extension.ts:524`), so a `rendering` state
posted on every keystroke would never be cleared on a no-op edit and the status
bar would spin forever. Either the webview drives `rendering` off its own
debounce and clears it on receipt, or the host posts the terminal state on
*every* path including the suppressed one.

**D8 — No webview test runner.** `apps/vscode` tests are `node --test` over
`src/**/*.test.ts`. Every UI test the plan asks for (toolbar rendering,
popovers, chips, responsive snapshots, shortcut dispatch) needs vitest + jsdom +
Testing Library added to `apps/vscode` — mirroring `packages/canvas`
(`vite.config.ts` `test:` block + `src/test-setup.ts`) — and the test script
widened to cover `webview/`. Dev dependencies only; nothing enters the `.vsix`.

**D9 — No i18n mechanism.** The plan's fallback applies: English strings
centralised in a `strings.ts`.

**D10 — A keyboard shortcut already exists inside the canvas.** `/` focuses the
canvas search. Lot 11's `Ctrl+F`, `Escape`, `D`, `F` and `1/2/3` must not fight
it, and must not fire while that input has focus.

**D11 — CI gates to keep green.** `.github/workflows/vscode-extension.yml`
builds, runs the bundle guard (`micromark` must stay out of the bundle) and
fails if the `.vsix` exceeds 5 MB. Any new import that reaches the
`@groundplan/canvas` barrel risks the first gate.

**D12 — The panel is a `WebviewPanel`, not a sidebar `WebviewView`.** It opens
in `ViewColumn.Beside`, so it is typically ~half the editor width but can be
much wider than the plan's 350–900 px envelope. Container queries remain the
right tool; the "Large" tier just needs to hold up past 900 px.

**D13 — tooling note.** `packages/canvas/src/lib/graph-layout.ts` is not valid
UTF-8 (`file` reports `data`), so plain `grep` silently skips it. Use `grep -a`.

## 3. Lot → files

| Lot | Files |
| --- | --- |
| 1 — state & protocol | `apps/vscode/src/messages.ts`, `webview/main.tsx`, new `packages/graph-differ/src/summary.ts` |
| 2 — compact toolbar | `webview/main.tsx` (split into `webview/components/*`) |
| 3 — diff popover | `webview/main.tsx` (removes `304-308`, `347-355`) |
| 4 — status bar | `webview/*`, `src/messages.ts`, `src/extension.ts` (sha + sync state) |
| 5 — filter chips | **`packages/canvas/src/components/graph-canvas.tsx`** + webview |
| 6 — legend popover | **`packages/canvas/…/graph-canvas.tsx`** (`EdgeLegend`) + webview |
| 7 — zoom overlay / fit-to-changes | **`packages/canvas/…/graph-canvas.tsx`**, `src/lib/camera.ts` |
| 8 — follow cursor | `src/extension.ts` (toggle plumbing), `webview/*`, canvas for off-screen-only recentre |
| 9 — persistence & first run | `src/extension.ts` (`workspaceState`, `globalState`) |
| 10 — responsive | `webview/*` |
| 11 — shortcuts | `webview/*`, canvas (`/` interaction) |

## 4. Decisions taken

Settled 2026-08-01. The design that follows from them:
`docs/superpowers/specs/2026-08-01-vscode-panel-ui-refactor-design.md`.

1. **Canvas chrome ownership — full opt-in API.** `GraphCanvas` gains
   `chrome`, controlled `filters` / `onFiltersChange`, a `cameraRef` handle and
   `revealSelection`. Every prop omitted reproduces today's behaviour, so the
   web app is untouched and its existing tests are the non-regression proof.
   Lots 5, 6 and 7 proceed as written, on top of that API.
2. **Follow cursor — toggle plus off-screen-only reveal.** The toggle and its
   persistence are new; the canvas stops recentring on a node already in view.
   The 200 ms debounce stays as GP-149 shipped it.
3. **Lens key stays `infra`** ("Global" is the label) — it is the web app's
   `?view=infra` and what the panel already persists.
4. **No GP numbers.** Conventional commits (`feat(vscode): …`,
   `feat(canvas,vscode): …`); this refactor has no Jira epic.

## 5. One assumption that got cheaper

Lot 1's `summarizeDiff` does not need to be written.
`computeGraphStats(graph)` in `@groundplan/graph-parser`
(`packages/graph-parser/src/graph.ts:274`) already returns
`changes: { create, update, delete, noop, unchanged }` and `impactedCount`, and
is what the backend stores beside every snapshot and what the PR comment counts
with. Run over the differ-annotated graph it *is* the plan's `DiffSummary` — so
the panel's counters and the PR comment's counters are the same fold and cannot
drift. Only a presentational adapter is new.

`presentEdgeKinds` moves out of the summary and into the legend model: the
differ has no opinion about how an edge is drawn.
