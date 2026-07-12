# Docs viewer header redesign

Date: 2026-07-12
Surface: `apps/frontend/src/pages/docs-page.tsx` (documentation viewer)

## Problem

The documentation-viewer header has three UI issues:

1. **View switcher is misplaced.** The `Plan impact` / `Network` segmented control
   lives in the title row next to the action buttons. It selects *which view* of the
   diagram to show and belongs on its own toolbar, presented as tabs.
2. **History eats a full-width band.** The snapshot history is a full-width
   horizontal strip of cards (`Timeline`) below the header — a lot of vertical space
   for a picker.
3. **The "not the latest" warning is hidden.** The amber "Viewing snapshot … — not
   the latest" banner (and the compare-mode banner) are `absolute top-0` overlays
   *inside* the graph container, so the canvas's floating search box and category
   panel render on top and occlude them.

## Goal

Reshape the header into three horizontal regions:

```
+--------------------------------------------------------------------------------+
| < Back to project                                                              |
| DOCUMENTATION · MAIN                                                            |
| tintin92350/groundplan-example       [Compare] [Share] [Export] [Regenerate]   |  title row (unchanged)
+--------------------------------------------------------------------------------+
|  Plan impact   Network                          History [ 6a627b13·MANUAL·12Jul v ] |  sub-toolbar (new)
|  -----------                                                                    |
+--------------------------------------------------------------------------------+
| ! Viewing snapshot 6a627b13 — not the latest.                 [Back to latest]  |  status bar (in flow, conditional)
+--------------------------------------------------------------------------------+
|                            [ graph canvas ]                                     |
+--------------------------------------------------------------------------------+
```

## Design

### 1. Title row — unchanged

The `<header>` keeps its structure: back link, `Documentation · <branch>` eyebrow,
repo-name `<h1>` on the left; the action cluster on the right. The action buttons
stay exactly where they are:

- **Compare** (toggles compare mode — label flips to "Exit compare")
- **Share** (`ShareDialog`)
- **Export** (`ExportMenu`)
- **Regenerate**

Removed from this cluster: the `ViewSwitcher` (moves to the sub-toolbar) and the
"N resources not in network view" chip (moves next to the tabs). The `genError`
alert stays under the title row.

### 2. Sub-toolbar — new (replaces the `Timeline` band)

A new bar with the same surface treatment as the old timeline band
(`bg-card border-b border-border px-8`, thinner vertical padding, e.g. `py-2.5`),
laid out as `flex items-center justify-between`. Rendered only when
`snapshots.length > 0`, same guard as the old timeline.

**Left — view tabs.** The current `ViewSwitcher` segmented pill is restyled into
underlined tabs:

- Two tabs, `Plan impact` (`infra`) and `Network` (`network`), still driven by
  `useGraphView()` / the `?view` query param — no behaviour change, only styling
  and placement.
- Active tab: `text-ink` with a bottom underline in `bg-primary` (or an active
  token); inactive: `text-muted-foreground hover:text-ink`. `role="tablist"` /
  `role="tab"` with `aria-selected`.
- The "N resources not in network view" chip renders immediately after the tabs,
  in the `network` view only (unchanged text/logic, just relocated).

The tabs only render when there is a `current` snapshot loaded and not in compare
mode — same condition as today's `{current && !compareMode && <ViewSwitcher />}`.

**Right — history select.** A new `SnapshotSelect` custom dropdown replaces the
`Timeline` + `SnapshotCard` strip:

- **Trigger:** a button styled like the outline buttons, showing the current
  snapshot as `shortSha · TRIGGER · date` (mono), with a chevron. Preceded by a
  small `History` label so its purpose is clear.
- **Panel:** a native `<details>` dropdown (the same lightweight pattern the
  existing `ExportMenu` uses — no new dependency) containing a scrollable list,
  with an outside-click / Escape close handler. Each row reuses the old card
  content: `shortSha` (mono,
  medium), the `MANUAL`/`AUTO` trigger badge (same styling as `SnapshotCard`), and
  the formatted date. The currently-selected row is marked (`aria-current`, accent
  background + check).
- **Pagination:** the existing `visible` / `PAGE` "Show more" logic is preserved as
  a "Show more" row at the bottom of the list when `snapshots.length > visible`.
- **Single-select mode (default):** clicking a row calls `setSelectedId(id)` and
  closes the popover.
- **Compare mode (2-pick):** when `compareMode` is on, rows render a checkbox and
  clicking toggles selection via the existing `toggleCompareSel`; the popover stays
  open (Radix `onSelect` preventDefault). The trigger summarises state: "Pick 2" →
  "Pick 1 more" → shows the chosen pair. Selection cap and "keep two most recent"
  behaviour are unchanged (reuse `toggleCompareSel`). When two are picked the diff
  activates exactly as today (`compareActive` / `comparePair`).

`SnapshotSelect` receives the same inputs the `Timeline` did (`snapshots`,
`selectedIds`, `visible`, `onSelect`, `onShowMore`) plus a `compareMode` flag and
the current snapshot's summary for the trigger label. `Timeline` and `SnapshotCard`
are removed from `docs-page.tsx` (their content is absorbed into `SnapshotSelect`).

### 3. Status bar — the warning-visibility fix

The two banners currently pinned as `absolute inset-x-0 top-0 z-10` inside the graph
container move **into the normal document flow**, as a full-width bar rendered
between the sub-toolbar and the graph container:

- **Viewing-old banner** (when `viewingOld && !compareMode`): keeps its amber
  treatment and "Back to latest" action.
- **Compare-mode banner** (when `compareMode`): keeps its `bg-accent` treatment and
  "Cancel" action, and its "pick N more" copy.

Because the bar is in flow, the graph canvas starts below it and can no longer
occlude it. The graph container drops these two absolute blocks. The separate
`WarningsNotice` ("N files skipped") corner popover is unrelated and stays as-is.

At most one status banner shows at a time (compare and viewing-old are mutually
exclusive by their existing conditions).

## Components touched

- `pages/docs-page.tsx` — new sub-toolbar markup; move banners into an inline status
  bar; remove `Timeline`/`SnapshotCard`; render `SnapshotSelect`.
- `components/view-switcher.tsx` — restyle `ViewSwitcher` from segmented pill to
  underlined tabs (hook and `?view` logic unchanged).
- `components/snapshot-select.tsx` — **new.** The history dropdown (single-select +
  compare 2-pick), absorbing the old `SnapshotCard` row content.
- `components/ui/popover.tsx` — **new** shadcn primitive (see Dependencies).

## Dependencies

- **None.** The history dropdown reuses the codebase's existing native-`<details>`
  dropdown pattern (as in `components/export-menu.tsx`) rather than adding a new
  UI primitive. `<details>` keeps its panel open while the compare 2-pick toggles
  multiple checkboxes (only clicking the `<summary>` toggles it), so it covers the
  compare flow without a dependency. (An earlier draft called for adding a shadcn
  Popover / `@radix-ui/react-popover`; that was dropped to stay consistent with the
  established pattern and keep the dependency set lean.)

## Non-goals / out of scope

- The action buttons stay in place (explicitly requested). Not moving Compare next
  to the history picker even though it drives it.
- No new `--warning` design token. The viewing-old banner reuses the existing amber
  treatment already in the file; introducing a semantic warning token is a separate
  cleanup.
- No change to compare semantics, `?view` / `?compare` deep-linking, export/share,
  or the graph canvas itself.

## Testing

Frontend tests use vitest + Testing Library (jsdom), asserting accessibility with
vitest-axe.

- `ViewSwitcher` (tabs): active tab reflects `?view`; clicking a tab updates the
  param; `role="tab"` / `aria-selected` present; axe clean.
- `SnapshotSelect`: trigger shows the current snapshot; opening lists rows with sha
  + trigger badge + date; selecting a row calls `onSelect` and closes; "Show more"
  appears past `visible` and calls `onShowMore`; in compare mode rows are
  checkboxes, toggling calls the pick handler and the panel stays open; axe clean.
- `DocsPage` (or an integration-ish test): the viewing-old status banner renders in
  flow when an older snapshot is selected and offers "Back to latest"; the
  compare-mode banner renders in compare mode. (Reuse existing docs-page test
  patterns if present.)
