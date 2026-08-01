# VS Code preview panel — UI/UX refactor

Design for the panel chrome refactor: three zones (toolbar, clear canvas, status
bar), contextual information instead of permanent floating elements, and the
shared canvas opened up just enough for the panel to own its own chrome.

Reconnaissance and the real file map: `docs/vscode-ui-refactor-notes.md`.
Scope: `apps/vscode` (host + webview) and `packages/canvas`. Not in scope:
colours and themes, the backend, and the web frontend beyond non-regression.

## 1. The problem

The panel today puts everything on one plane. A flat toolbar of eight
same-weight controls floats over the canvas and truncates in a narrow panel; two
permanent floating elements sit on the diagram (the "No changes vs …" pill and
the "Code diff … not a plan" note); the canvas draws its own left rail, its own
eight-entry legend and its own zoom cluster underneath all of that; and "Changed
only" is reachable when there is no diff for it to fold.

The result is that the panel has two competing chromes and no hierarchy: nothing
recedes, so nothing stands out.

## 2. Shape

Three zones replace one floating plane:

```text
┌──────────────────────────────────────────────────────────────┐
│ [Global|Network|IAM]  [⎇ Diff vs main  +3 ~1 −2 |⌄]  🔍 ⚙ ⋯ │  toolbar ~36px
├──────────────────────────────────────────────────────────────┤
│ ⊗ module.network ×   ⊗ Storage ×                             │  chips (only when active)
├──────────────────────────────────────────────────────────────┤
│                                                              │
│                         diagram                          [+] │  canvas — nothing
│                                                          [−] │  permanent floats
│                                                          [⛶] │  over it
│                                                              │
├──────────────────────────────────────────────────────────────┤
│ merge-base origin/main · a1b2c3   ● synced          ?   ⓘ   │  status bar ~24px
└──────────────────────────────────────────────────────────────┘
```

The toolbar and the status bar are real bars in a flex column, not overlays.
That is what clears the canvas: the toolbar stops covering the diagram, and the
diagram stops needing chrome that hovers over itself. The zoom cluster is the
one deliberate overlay, bottom-right, where it does not collide with a legend
that no longer lives on the canvas.

Everything that floats today moves into a zone:

| Today | Tomorrow |
| --- | --- |
| "No changes vs {ref}" pill | `✓` in the Diff button, counts in the status bar |
| "Code diff … not a plan" note | ⓘ popover + a first-run toast, once |
| Out-of-sync chip (top-right) | status bar notice slot |
| Multi-root warning (top banner) | status bar notice slot |
| Canvas legend (bottom-left) | `?` popover, filtered to what is present |
| Canvas left rail (search + filters) | toolbar 🔍 and ⚙, chips row for active filters |
| Canvas zoom cluster (top-right) | overlay bottom-right, fit becomes fit-to-changes |

## 3. Counters: one counting rule, not a new one

`computeGraphStats(graph)` already exists in `@groundplan/graph-parser`
(`graph.ts:274`) and returns `{ nodes, edges, inferredEdges, impactedCount,
changes: { create, update, delete, noop, unchanged } }`. The backend stores it
beside every snapshot; it is what the PR comment counts with.

Feeding it the differ-annotated graph is the whole of the plan's `DiffSummary`.
No new counting function is written, so the panel's `+3 ~1 −2` and the PR
comment's counts cannot drift — they are the same fold. The webview adds only a
presentational adapter:

```ts
// webview/state/diff-summary.ts
export type DiffCounts = {
  created: number; updated: number; deleted: number; impacted: number;
  /** created + updated + deleted — the "is there anything to see" number. */
  total: number;
};
export function diffCounts(graph: Graph): DiffCounts;   // wraps computeGraphStats
```

The plan's `presentEdgeKinds` is not a differ concern — the differ knows nothing
about how an edge is drawn. It belongs to the legend model (§5).

## 4. Panel state and protocol

### 4.1 `PanelState`

One typed object in the webview, the source of truth for every control:

```ts
// webview/state/panel-state.ts
export type Lens = "infra" | "network" | "iam";      // `infra` is labelled "Global"
export type PanelState = {
  lens: Lens;
  diff: { enabled: boolean; mode: BaselineMode; changedOnly: boolean };
  filters: CanvasFilters;      // see §6.2
  followCursor: boolean;
};
```

`infra` keeps its key: it is the web app's `?view=infra` and what the panel
already persists. "Global" is the label, not the identifier.

State moves from eight scattered `useState` hooks to one reducer with named
actions (`setLens`, `toggleDiff`, `setBase`, `toggleChangedOnly`,
`setFilters`, `clearFilters`, `toggleFollowCursor`). The reducer is pure and
unit-tested; the components read it and dispatch.

### 4.2 Protocol additions

`src/messages.ts` gains three things, all discriminated:

```ts
// Host → webview
| { type: "sync"; value: "rendering" | "synced" | "error"; message?: string }
| { type: "openDiffInfo" }        // the first-run toast's "Learn more"

// DiffState gains one field — Baseline already carries it
sha: string | null;

// Webview → host
| { type: "setPanelPrefs"; prefs: PersistedPanelState }   // supersedes setDiffPrefs
```

`setDiffPrefs` stays in place until persistence lands (step 10 of §12), where
`setPanelPrefs` replaces it in one move. Steps 1–9 do not need a wider message
than the one that already exists.

**Sync state is posted outside the signature suppression.** The host
deliberately stays silent when nothing it renders moved
(`signatureTracker.shouldPost`, `extension.ts:524`); a `rendering` posted on
every keystroke and cleared only by a payload post would spin forever on a
no-op edit. So `refresh()` gains a generation-guarded `finally` that settles the
state on *every* exit path — hidden panel, parse error, superseded run included:

```ts
finally {
  if (generation === this.generation) {
    void this.post({ type: "sync", value: failed ? "error" : "synced", ... });
  }
}
```

The webview additionally sets `rendering` optimistically the moment it dispatches
a preference that forces a recompute, so the status bar reacts before the host
does. No optimistic *rendering* of the graph itself: a base change shows
`rendering` until the host answers, never a half-applied diagram.

## 5. Canvas opt-in API

`packages/canvas` is shared with the web app, so every addition is optional and
every default reproduces today's behaviour byte-for-byte. Four new props:

```ts
/**
 * Which built-in chrome the canvas draws. Omitted fields default to true.
 * `zoom` covers both the +/−/fit cluster and the zoom-% / interaction-hint
 * chip — they are one idea for the reader even though the code draws them as
 * two absolutely-positioned blocks.
 */
chrome?: { search?: boolean; filters?: boolean; legend?: boolean; zoom?: boolean };

/** Controlled filter state. Absent = the canvas owns it, exactly as today. */
filters?: CanvasFilters;
onFiltersChange?: (next: CanvasFilters) => void;

/** Imperative camera for a consumer that hides `chrome.zoom`. */
cameraRef?: RefObject<CanvasCamera | null>;

/** Whether an external `selectedAddress` always recentres. Default "always". */
revealSelection?: "always" | "offscreen";
```

```ts
export type CanvasFilters = {
  change: ReadonlySet<FilterKey>;
  categories: ReadonlySet<Category>;
  modules: ReadonlySet<string>;
  hubEdges: boolean;
};
export type CanvasCamera = {
  zoomIn(): void;
  zoomOut(): void;
  /** Frame these nodes; no ids (or none present) frames the whole graph. */
  fit(nodeIds?: readonly string[]): void;
  reveal(nodeId: string): void;
};
```

Internally the four filter hooks (`activeFilters`, `activeCategories`,
`activeModules`, `showHubEdges`) collapse into one `useCanvasFilters(props)`
hook returning `[filters, update]`, where `update` calls `onFiltersChange` when
controlled and `setState` when not. This is the one structural change inside
`graph-canvas.tsx`; it also shortens a 1725-line file by removing four
duplicated reset paths.

`FILTER_LABELS` and `FILTER_SWATCH` move out of `graph-canvas.tsx` into a new
`lib/legend.ts`, which also gains the pure legend model:

```ts
export type LegendModel = {
  changes: { key: FilterKey; label: string; swatch: string; count: number }[];
  notes: { key: "data-source" | "exposed"; label: string }[];
  edges: { key: "depends_on" | "inferred"; label: string; dashed: boolean }[];
};
export function buildLegendModel(
  graph: Graph,
  opts: { variant: "plan" | "docs"; presentOnly: boolean },
): LegendModel;
```

`EdgeLegend` imports the constants and keeps rendering what it renders today
(`presentOnly: false` reproduces its current list exactly). Only the panel passes
`presentOnly: true`. The web app's legend does not change.

The panel needs no search props: `searchNodes` is already exported from the
barrel, so the panel owns its input and its result list and calls
`camera.reveal(id)` on a pick.

**One interaction to fix:** the canvas binds `/` to focus its own search box
(`graph-canvas.tsx:631`). When `chrome.search === false` that handler must not
bind, or `/` would focus an input that is not rendered. The panel binds `/` to
its own field instead.

## 6. The zones

### 6.1 Toolbar

**Lens segmented control** — `Global | Network | IAM`, one active, arrow-key
navigation, `role="radiogroup"`. Replaces the three pills.

**Diff split-button** — a main region and a chevron region:

| State | Main region reads |
| --- | --- |
| off | `Diff` |
| on, no baseline | `Diff vs main ⚠` (the reason lives in the popover and the status bar) |
| on, clean | `Diff vs main ✓` |
| on, changes | `Diff vs main` + `+3 ~1 −2` in the semantic change colours |

Zero counts are never printed — a clean diff says `✓`, not `+0 ~0 −0`. The
impacted count is not in the button (it would crowd the one number people scan
for); it lives in the popover header, the legend and the status bar. The chevron
opens the popover in every state, so a base can be chosen before enabling.

**Icons, right** — 🔍 search (expands to a field, collapses on `Escape` or empty
blur), ⚙ filters (badge with the active-filter count), `⋯` overflow.

The overflow holds the shortcut list, the follow-cursor toggle, and — in the
narrow tier only — search and filters. It does **not** hold export or a theme
picker: the panel has no export, and the theme is a contributed VS Code setting
that is deliberately not in-panel chrome. Adding either would be inventing a
feature, not refactoring one.

"Changed only" and the zoom controls leave the toolbar (to §6.2 and §6.4).

### 6.2 Diff popover

Anchored to the chevron, in order:

1. **Base** — a two-option radio group. There are exactly two baselines in the
   code (`BaselineMode = "head" | "merge-base"`), and `merge-base` *is* "vs
   main"; the plan's third option does not exist and is not invented.
2. **Changed only** — the toggle's only home. It is unreachable when diff is
   off, because the popover's body is disabled in that state.
3. **About static diff** — "This compares your working tree against {ref} — it
   is not a Terraform plan. It reads no state and does not expand `count` or
   `for_each`." One string, shared verbatim with the ⓘ popover and the first-run
   toast (`strings.ts`), so the three cannot disagree.

Changing the base or "Changed only" dispatches, shows `rendering`, and applies
only when the host answers.

### 6.3 Filter chips

A row under the toolbar, one removable chip per active filter, rendered only
when at least one filter is active (no empty row). The ⚙ badge count equals the
chip count. In the narrow tier the row collapses to a single `n filters ×` chip
whose `×` clears everything. Chips read from `PanelState.filters` — the same
object the canvas renders from — so a chip cannot claim a filter the graph is
not actually under.

### 6.4 Canvas overlay

`+ / − / fit` as a discreet vertical cluster, bottom-right, driven by
`cameraRef`. **Fit becomes fit-to-changes in diff mode**: the panel passes
`changedFocusIds(graph)` (already exported from `lib/camera.ts`, already tested)
to `camera.fit()`; outside diff mode, or when nothing changed, `fit()` frames
the whole graph. The bounding box is React Flow's own `fitView({ nodes })` — no
new geometry code.

### 6.5 Status bar

~24px, `font-mono`, small:

- **Left** — `merge-base origin/main · a1b2c3`, then the sync indicator
  (`rendering` with a discreet spinner, `synced`, `error` with a short message
  that opens details on click). Truncation drops the sha first, then the ref.
- **Notice slot** — the single highest-priority notice: diff-unavailable >
  out-of-sync > multi-root. This is where the two banners that used to float
  over the canvas go.
- **Right** — `?` (legend popover) and `ⓘ` (the same static-diff explanation as
  the popover).

### 6.6 Legend popover

Anchored to `?`, built by `buildLegendModel(graph, { variant, presentOnly: true })`:
in diff mode only the change states actually present, each with its count
(`Created (3)`), plus `Impacted (2)` when any; outside diff mode only the node
and edge kinds the current view actually contains (`inferred reference` only
when an edge carries `inferred: true`, `data source` only when one is on
screen). Edge kinds live here and nowhere else.

## 7. Follow cursor

GP-149 already ships cursor → node (`onDidChangeTextEditorSelection` →
`nodeAtPosition` → `select`, 200 ms debounce). What this adds:

- a **toggle** in the overflow menu, default on, persisted, and the host skips
  posting `select` entirely when it is off;
- **`revealSelection: "offscreen"`** in the panel, so the diagram recentres only
  when the node is outside the viewport. Today it flies on every cursor move,
  which fights manual panning. The web app keeps `"always"`.

The 200 ms debounce stays as shipped — it is tuned and tested, and the plan's
150 ms is not a measured improvement.

## 8. Persistence and first run

`workspaceState` under `groundplan.panelState.v1`, holding lens, diff prefs,
filters and `followCursor`. On first read, seeded from the four live keys
(`groundplan.diff.enabled` / `.mode` / `.changedOnly`), which are then left in
place — a downgrade keeps working. `groundplan.rootDir.picked` stays separate:
it is an entrypoint, not panel chrome.

**Filters persist as exclusions, not selections** — `hiddenChange`,
`hiddenCategories`, `hiddenModules`, `hubEdges`. A module that no longer exists
simply stops being hidden, so a stale state cannot hide a diagram that a
checkbox can no longer bring back. An unreadable or version-mismatched state is
ignored silently and the defaults apply.

**First run**: `globalState` flag `groundplan.diffExplainerShown`. On the first
activation of diff mode only, a native `showInformationMessage` carries the
static-diff sentence and a "Learn more" button that posts `openDiffInfo` to
open the ⓘ popover. Native, so it costs no bundle and reads as VS Code.

## 9. Responsive tiers

Three tiers, measured on the **panel**, not the window:

| Tier | Width | Behaviour |
| --- | --- | --- |
| wide | ≥ 640px | segments with labels, split-button with counters, labelled icons on hover |
| medium | 480–639px | segments kept, search icon-only, chips collapsed to a count |
| narrow | < 480px | lens becomes a dropdown, split-button reduces to `Diff ✓/counters` + chevron, search and filters move into `⋯` |

A label is never truncated mid-word: a control is complete or it is replaced by
its compact form.

**Measured in JS, not CSS.** The tier changes *structure* — a control moves into
a menu, a segmented control becomes a dropdown — which a container query cannot
express without rendering every control twice and hiding one copy. So a
`ResizeObserver` on the panel root feeds a pure `tierFor(width): Tier`, which is
unit-tested and passed down; CSS container queries are left for cosmetics. This
keeps the plan's intent (the breakpoint follows the panel, not the window) and
makes the three-width tests real assertions rather than CSS snapshots that jsdom
cannot evaluate anyway.

## 10. Shortcuts

Only while the webview has focus, and never while a text field does (except
`Escape`):

| Key | Action |
| --- | --- |
| `Ctrl/Cmd+F`, `/` | focus the panel search |
| `D` | toggle diff mode |
| `1` `2` `3` | Global / Network / IAM |
| `F` | fit (fit-to-changes in diff mode) |
| `Escape` | close the open popover, else collapse the search, else clear the selection |

The list is shown in the `⋯` menu. The canvas's own `/` binding is suppressed
when `chrome.search === false`, so exactly one handler is live.

## 11. Files and tests

```text
apps/vscode/webview/
  main.tsx                    # root: message wiring, layout, nothing else
  strings.ts                  # every user-facing string, one place
  state/panel-state.ts        # PanelState, reducer, defaults
  state/diff-summary.ts       # diffCounts() over computeGraphStats
  state/tier.ts               # tierFor(width), useContainerTier()
  components/toolbar.tsx      # lens segments + split-button + icon cluster
  components/diff-popover.tsx
  components/filter-chips.tsx
  components/status-bar.tsx
  components/legend-popover.tsx
  components/zoom-overlay.tsx
  components/search-field.tsx
  components/overflow-menu.tsx
```

`apps/vscode` has no webview test runner today — nothing under `webview/` is
tested. Add vitest + jsdom + Testing Library as dev dependencies (mirroring
`packages/canvas`: a `test:` block in `vite.config.ts` and a setup file), and
widen the script to `node --import tsx --test "src/**/*.test.ts" && vitest run`.
Nothing new enters the `.vsix`.

What each part must prove:

- `diffCounts` — empty diff, creates only, mixed, impacted-without-changes.
- reducer — every action, and that "changed only" cannot be set while diff is off.
- toolbar — counters render only when non-zero, the active/inactive/unavailable
  states, `aria-label` on every icon-only control, arrow-key navigation.
- popover — opens and closes on click / `Escape` / outside click, base change
  dispatches, and **the removed banner and pill are absent from the DOM**.
- status bar — the three sync transitions, notice precedence, sha drops before
  the ref under truncation.
- legend — `buildLegendModel` over: clean diff, diff without deletes, network vs
  global, a snapshot with no data source. Never an absent state.
- chips — add, remove, count, narrow-tier collapse, and agreement with the
  filters the canvas actually renders under.
- canvas API — every new prop omitted leaves the existing canvas tests passing
  unchanged; controlled filters round-trip; `fit()` with no changed nodes falls
  back to a full fit; `revealSelection: "offscreen"` does not move a camera
  already showing the node.
- follow cursor — no message posted when the toggle is off.
- persistence — round-trip, absent state, corrupt state, a hidden module that no
  longer exists, and the toast firing exactly once.
- tiers — `tierFor` boundaries, and the presence/absence of each control per tier.

## 12. Sequencing

Each step is one PR and one conventional commit; no GP numbers (this refactor
has no Jira epic). Screenshots before/after in each description, and a
non-regression note whenever `packages/canvas` is touched.

```text
1. state + protocol + test runner   refactor(vscode): typed panel state and diff counts
2. compact toolbar                  feat(vscode): compact toolbar with lens segments and diff split-button
3. diff popover + removals          feat(vscode): diff options popover, remove permanent banner and pill
4. status bar                       feat(vscode): slim status bar with sync state and diff base
5. canvas opt-in API                feat(canvas): opt-in chrome, controlled filters and camera handle
6. legend popover                   feat(vscode): contextual legend popover
7. zoom overlay + fit-to-changes    feat(canvas,vscode): overlay zoom controls and fit-to-changes
8. filter chips                     feat(vscode): active filters as removable chips
9. follow cursor                    feat(vscode): follow-cursor toggle and off-screen-only reveal
10. persistence + first run         feat(vscode): persist panel state per workspace, first-run explainer
11. responsive tiers                feat(vscode): responsive toolbar tiers
12. shortcuts                       feat(vscode): panel keyboard shortcuts
```

Step 5 lands with no consumer change, so the canvas API and its blast radius are
reviewable on their own before anything depends on it.

## 13. Acceptance criteria

1. No permanent floating element on the canvas — the pill, the disclaimer, the
   out-of-sync chip and the multi-root banner are all gone from the diagram
   surface. The zoom cluster is the only overlay.
2. The Diff button's counters equal `computeGraphStats` over the differ output
   for every test snapshot.
3. "Changed only" is unreachable while diff mode is off.
4. The legend never lists a state absent from the current diff or view.
5. At 360px wide, no label is truncated and every function is reachable.
6. Reopening VS Code restores lens, base, changed-only, filters and
   follow-cursor for that workspace.
7. The static-diff explanation appears once as a toast and on demand via ⓘ —
   never permanently.
8. The web frontend renders identical diagrams: `packages/canvas` tests pass
   unmodified, and every new prop is omitted there.
9. No network call and no telemetry is added — verified by reading the diff.
10. `pnpm --filter groundplan-vscode test`, the bundle guard and the 5 MB `.vsix`
    gate all stay green.

## 14. Out of scope

Colours and theme tokens; the backend; the web frontend's own chrome (the canvas
keeps its left rail, legend and zoom cluster there); network-lens-specific
legend entries beyond node and edge kinds; i18n beyond centralising strings in
`strings.ts` for a future extraction; any change to the 200 ms cursor debounce
or the 500 ms re-parse debounce.

## 15. Decisions taken

| Decision | Why |
| --- | --- |
| Open the canvas up with opt-in props rather than forking its chrome | The panel and the web app should keep drawing the same diagram; only the chrome differs, and defaults keep the web app untouched |
| Reuse `computeGraphStats` instead of a new `summarizeDiff` | The panel and the PR comment must not be able to disagree about how many things changed |
| Keep `infra` as the lens key | It is the web app's `?view=infra` and what the panel already persists; "Global" is a label |
| Two diff bases, not three | `BaselineMode` has exactly two, and `merge-base` already means "vs main" |
| Sync state posted outside signature suppression | Otherwise a no-op edit leaves the status bar spinning forever |
| Filters persisted as exclusions | A stale selection cannot hide a diagram that no checkbox can restore |
| Tiers measured in JS | Structural changes cannot be expressed by a container query without double-rendering |
| No GP numbers | This refactor has no Jira epic; conventional commits carry the trace |
