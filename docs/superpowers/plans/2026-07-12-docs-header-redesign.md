# Docs Viewer Header Redesign Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Reshape the documentation-viewer header so the view switcher becomes tabs, the snapshot history collapses into a right-aligned custom dropdown, and the "not the latest" warning is always visible.

**Architecture:** Three stacked regions in `docs-page.tsx`: an unchanged title row (back link, title, action buttons), a new sub-toolbar (view tabs on the left, a `SnapshotSelect` history dropdown on the right), and an in-flow status bar (the amber "not the latest" and the compare-mode banners, moved out of the graph container so they can never be occluded). The history dropdown reuses the codebase's existing native-`<details>` dropdown pattern (as in `ExportMenu`) — no new dependency — and doubles as a two-pick control in compare mode.

**Tech Stack:** React 19, TypeScript, Vite, Tailwind CSS v4, lucide-react icons, vitest + Testing Library (jsdom) + vitest-axe.

## Global Constraints

- TypeScript `strict`, `noUncheckedIndexedAccess`, `noUnusedLocals`, `noUnusedParameters` — do not loosen; remove imports that become unused.
- Frontend imports use the `@/` alias (maps to `src/`).
- **Never hardcode a colour.** Use the semantic Tailwind utilities backed by tokens (`bg-card`, `text-ink`, `text-muted-foreground`, `bg-accent`, `border-border`, `bg-primary/10`, `text-primary`, …). The one exception is the pre-existing amber "not the latest" banner, which keeps its current `amber-*` utilities (relocating it, not restyling it).
- Run the full frontend test suite with: `pnpm --filter @groundplan/frontend test`
- Run a single test file with: `pnpm --filter @groundplan/frontend test <path>`
- Typecheck with: `pnpm --filter @groundplan/frontend typecheck`
- Commit messages: end with the Co-Authored-By trailer used in this repo.

---

### Task 1: Restyle `ViewSwitcher` as underlined tabs

Move the switcher from a segmented pill to an underlined-tab look. **Behaviour, the `useGraphView` hook, the `?view` param, and the `aria-pressed` semantics are all unchanged** — this is styling only, so the existing `view-switcher.test.tsx` is the regression guard (no new test).

**Files:**
- Modify: `apps/frontend/src/components/view-switcher.tsx:29-54`
- Test (existing, must stay green): `apps/frontend/src/components/view-switcher.test.tsx`

**Interfaces:**
- Consumes: nothing new.
- Produces: `ViewSwitcher` (unchanged export signature — no props); still renders two `<button>`s with `aria-pressed`.

- [ ] **Step 1: Confirm the existing test passes before changing anything**

Run: `pnpm --filter @groundplan/frontend test src/components/view-switcher.test.tsx`
Expected: PASS (2 tests).

- [ ] **Step 2: Replace the `ViewSwitcher` function body with the tab styling**

Replace lines 29-54 of `apps/frontend/src/components/view-switcher.tsx` (the `/** Segmented … */` comment through the end of the function) with:

```tsx
/** Plan-impact ⇄ Network view tabs (GP-44). Underlined-tab styling. */
export function ViewSwitcher() {
  const { view, setView } = useGraphView();
  return (
    <div className="flex items-center gap-4" role="group" aria-label="Graph view">
      {OPTIONS.map((o) => (
        <button
          key={o.key}
          type="button"
          aria-pressed={view === o.key}
          onClick={() => setView(o.key)}
          className={cn(
            "border-b-2 px-0.5 pb-1.5 font-mono text-xs transition-colors",
            view === o.key
              ? "border-primary text-ink"
              : "border-transparent text-muted-foreground hover:text-ink",
          )}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}
```

Leave lines 1-27 (imports, `GraphView` type, `useGraphView`, `OPTIONS`) untouched.

- [ ] **Step 3: Run the existing test to verify behaviour is preserved**

Run: `pnpm --filter @groundplan/frontend test src/components/view-switcher.test.tsx`
Expected: PASS (2 tests) — `aria-pressed` toggling still works.

- [ ] **Step 4: Typecheck**

Run: `pnpm --filter @groundplan/frontend typecheck`
Expected: no errors.

- [ ] **Step 5: Commit**

```bash
git add apps/frontend/src/components/view-switcher.tsx
git commit -m "feat(frontend): restyle view switcher as underlined tabs

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 2: Create the `SnapshotSelect` history dropdown

A native-`<details>` dropdown (same pattern as `ExportMenu`) that shows the current snapshot in its trigger and lists all snapshots as menu rows. In single-select mode a click selects and closes; in compare mode rows are `menuitemcheckbox`es and the panel stays open across the two picks. It absorbs the sha + trigger-badge + date content that used to live in `SnapshotCard`.

**Files:**
- Create: `apps/frontend/src/components/snapshot-select.tsx`
- Create (test): `apps/frontend/src/components/snapshot-select.test.tsx`

**Interfaces:**
- Consumes: `SnapshotSummary` from `@/api/types`; `formatDate` from `@/lib/format`; `buttonVariants` from `@/components/ui/button`; `cn` from `@/lib/utils`.
- Produces:
  ```ts
  export function SnapshotSelect(props: {
    snapshots: SnapshotSummary[];
    selectedIds: string[];      // single mode: [selectedId]; compare mode: the chosen pair
    visible: number;            // how many rows to show (pagination)
    compareMode: boolean;
    onSelect: (id: string) => void;
    onShowMore: () => void;
  }): JSX.Element
  ```
  Rows render `role="menuitem"` (single mode) or `role="menuitemcheckbox"` with `aria-checked` (compare mode).

- [ ] **Step 1: Write the failing test**

Create `apps/frontend/src/components/snapshot-select.test.tsx`:

```tsx
import { expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { axe } from "vitest-axe";

import type { SnapshotSummary } from "@/api/types";
import { SnapshotSelect } from "./snapshot-select";

function summary(
  id: string,
  commitSha: string,
  trigger: "manual" | "auto",
): SnapshotSummary {
  return {
    id,
    repositoryId: "r1",
    source: "hcl",
    ref: "main",
    commitSha,
    prNumber: null,
    createdAt: "2026-01-03T00:00:00.000Z",
    stats: {
      nodes: 1,
      edges: 0,
      changes: { create: 0, update: 0, delete: 0, noop: 0, unchanged: 1 },
      trigger,
    },
  };
}

const snaps = [
  summary("s3", "cccccccc3333", "auto"),
  summary("s2", "bbbbbbbb2222", "manual"),
  summary("s1", "aaaaaaaa1111", "manual"),
];

function noop() {}

it("shows the selected snapshot in the trigger and lists all snapshots as menu items", () => {
  render(
    <SnapshotSelect
      snapshots={snaps}
      selectedIds={["s3"]}
      visible={10}
      compareMode={false}
      onSelect={noop}
      onShowMore={noop}
    />,
  );

  // Trigger summarises the selected snapshot (sha · TRIGGER · date) in one node.
  expect(screen.getByText(/cccccccc.*AUTO/i)).toBeInTheDocument();

  // Every snapshot is a menu item (role query does not match the trigger summary).
  expect(screen.getByRole("menuitem", { name: /cccccccc/i })).toBeInTheDocument();
  expect(screen.getByRole("menuitem", { name: /bbbbbbbb/i })).toBeInTheDocument();
  expect(screen.getByRole("menuitem", { name: /aaaaaaaa/i })).toBeInTheDocument();
});

it("calls onSelect with the snapshot id when a row is clicked", () => {
  const onSelect = vi.fn();
  render(
    <SnapshotSelect
      snapshots={snaps}
      selectedIds={["s3"]}
      visible={10}
      compareMode={false}
      onSelect={onSelect}
      onShowMore={noop}
    />,
  );

  fireEvent.click(screen.getByRole("menuitem", { name: /aaaaaaaa/i }));
  expect(onSelect).toHaveBeenCalledWith("s1");
});

it("renders checkbox rows reflecting the picked pair in compare mode", () => {
  const onSelect = vi.fn();
  render(
    <SnapshotSelect
      snapshots={snaps}
      selectedIds={["s2"]}
      visible={10}
      compareMode={true}
      onSelect={onSelect}
      onShowMore={noop}
    />,
  );

  const picked = screen.getByRole("menuitemcheckbox", { name: /bbbbbbbb/i });
  expect(picked).toHaveAttribute("aria-checked", "true");
  expect(
    screen.getByRole("menuitemcheckbox", { name: /aaaaaaaa/i }),
  ).toHaveAttribute("aria-checked", "false");

  fireEvent.click(screen.getByRole("menuitemcheckbox", { name: /aaaaaaaa/i }));
  expect(onSelect).toHaveBeenCalledWith("s1");
});

it("paginates with a Show more control", () => {
  const onShowMore = vi.fn();
  render(
    <SnapshotSelect
      snapshots={snaps}
      selectedIds={["s3"]}
      visible={2}
      compareMode={false}
      onSelect={noop}
      onShowMore={onShowMore}
    />,
  );

  expect(screen.getAllByRole("menuitem")).toHaveLength(2);
  fireEvent.click(screen.getByRole("button", { name: /show more/i }));
  expect(onShowMore).toHaveBeenCalled();
});

it("has no accessibility violations", async () => {
  const { baseElement } = render(
    <SnapshotSelect
      snapshots={snaps}
      selectedIds={["s3"]}
      visible={10}
      compareMode={false}
      onSelect={noop}
      onShowMore={noop}
    />,
  );
  const results = await axe(baseElement);
  expect(results.violations).toEqual([]);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm --filter @groundplan/frontend test src/components/snapshot-select.test.tsx`
Expected: FAIL — cannot resolve `./snapshot-select` (module does not exist yet).

- [ ] **Step 3: Write the component**

Create `apps/frontend/src/components/snapshot-select.tsx`:

```tsx
/**
 * Snapshot history dropdown. A native-<details> menu (same pattern as
 * ExportMenu) showing the current snapshot in its trigger and every snapshot as
 * a row. Single-select mode picks and closes; compare mode turns rows into
 * checkboxes and keeps the panel open for the two-pick.
 */
import { useEffect, useRef, useState } from "react";
import { Check, ChevronDown, History } from "lucide-react";

import type { SnapshotSummary } from "@/api/types";
import { formatDate } from "@/lib/format";
import { cn } from "@/lib/utils";
import { buttonVariants } from "@/components/ui/button";

const shortSha = (sha: string) => sha.slice(0, 8);

export function SnapshotSelect({
  snapshots,
  selectedIds,
  visible,
  compareMode,
  onSelect,
  onShowMore,
}: {
  snapshots: SnapshotSummary[];
  selectedIds: string[];
  visible: number;
  compareMode: boolean;
  onSelect: (id: string) => void;
  onShowMore: () => void;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDetailsElement>(null);

  // Close on outside click / Escape (native <details> does not do this).
  useEffect(() => {
    if (!open) return;
    const onPointerDown = (e: PointerEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [open]);

  const handleSelect = (id: string) => {
    onSelect(id);
    if (!compareMode) setOpen(false); // keep open for the compare two-pick
  };

  const selected = snapshots.find((s) => selectedIds.includes(s.id)) ?? null;
  const triggerLabel = compareMode
    ? selectedIds.length === 0
      ? "Compare — pick 2"
      : selectedIds.length === 1
        ? "Pick 1 more"
        : selectedIds
            .map((id) => shortSha(snapshots.find((s) => s.id === id)?.commitSha ?? id))
            .join(" ⇄ ")
    : selected
      ? `${shortSha(selected.commitSha)} · ${(selected.stats.trigger ?? "manual").toUpperCase()} · ${formatDate(selected.createdAt)}`
      : "Select snapshot";

  return (
    <details ref={ref} open={open} className="relative">
      <summary
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={(e) => {
          e.preventDefault(); // React state is the single source of open-ness
          setOpen((o) => !o);
        }}
        className={cn(
          buttonVariants({ variant: "outline" }),
          "cursor-pointer list-none font-mono text-xs marker:hidden",
        )}
      >
        <History className="size-4" />
        <span className="text-muted-foreground">History</span>
        <span className="text-ink">{triggerLabel}</span>
        <ChevronDown className="size-4" />
      </summary>
      <div
        role="menu"
        aria-label="Snapshot history"
        className="bg-card border-border absolute right-0 z-20 mt-1 max-h-80 w-72 overflow-y-auto rounded-md border shadow-lg"
      >
        {snapshots.slice(0, visible).map((snap) => {
          const isSelected = selectedIds.includes(snap.id);
          const trigger = snap.stats.trigger ?? "manual";
          return (
            <button
              key={snap.id}
              type="button"
              role={compareMode ? "menuitemcheckbox" : "menuitem"}
              aria-checked={compareMode ? isSelected : undefined}
              aria-current={!compareMode && isSelected ? "true" : undefined}
              onClick={() => handleSelect(snap.id)}
              className={cn(
                "hover:bg-accent flex w-full items-center gap-2 px-3 py-2 text-left transition-colors",
                isSelected && "bg-accent",
              )}
            >
              <span className="flex size-4 shrink-0 items-center justify-center">
                {isSelected && <Check className="text-primary size-3.5" />}
              </span>
              <span className="font-mono text-xs font-medium">
                {shortSha(snap.commitSha)}
              </span>
              <span
                className={cn(
                  "rounded-xs px-1.5 py-0.5 font-mono text-[9px] uppercase",
                  trigger === "auto"
                    ? "bg-primary/10 text-primary"
                    : "bg-muted text-muted-foreground",
                )}
              >
                {trigger}
              </span>
              <span className="text-muted-foreground ml-auto font-mono text-[10px]">
                {formatDate(snap.createdAt)}
              </span>
            </button>
          );
        })}
        {snapshots.length > visible && (
          <button
            type="button"
            onClick={onShowMore}
            className="text-muted-foreground hover:text-ink w-full px-3 py-2 text-left text-xs"
          >
            Show more
          </button>
        )}
      </div>
    </details>
  );
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm --filter @groundplan/frontend test src/components/snapshot-select.test.tsx`
Expected: PASS (5 tests).

- [ ] **Step 5: Typecheck**

Run: `pnpm --filter @groundplan/frontend typecheck`
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add apps/frontend/src/components/snapshot-select.tsx apps/frontend/src/components/snapshot-select.test.tsx
git commit -m "feat(frontend): snapshot history dropdown (SnapshotSelect)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 3: Wire the sub-toolbar, relocate the status banners, retire the timeline

Rework `docs-page.tsx`: remove the view switcher + network chip from the header cluster; add the sub-toolbar (tabs left, `SnapshotSelect` right) in place of the `Timeline` strip; move the two status banners out of the graph container into an in-flow status bar; delete the `Timeline`/`SnapshotCard` components; update `docs-page.test.tsx` for the dropdown.

**Files:**
- Modify: `apps/frontend/src/pages/docs-page.tsx`
- Modify (test): `apps/frontend/src/pages/docs-page.test.tsx`

**Interfaces:**
- Consumes: `SnapshotSelect` (Task 2), `ViewSwitcher` (Task 1), existing `handleCardClick`, `timelineSelected`, `visible`, `setVisible`, `compareMode`, `viewingOld`, `selectedId`, `latestId`, `current`, `network`.
- Produces: no new exports.

- [ ] **Step 1: Update the failing tests first (dropdown-aware queries)**

In `apps/frontend/src/pages/docs-page.test.tsx`, replace the body of the test **"lists every docs snapshot with its trigger and renders the latest"** (currently lines 136-142) with role-based queries, because the selected snapshot now appears in both the trigger and its row:

```tsx
  // Every snapshot is a row in the history dropdown.
  expect(await screen.findByRole("menuitem", { name: /cccccccc/i })).toBeInTheDocument();
  expect(screen.getByRole("menuitem", { name: /bbbbbbbb/i })).toBeInTheDocument();
  expect(screen.getByRole("menuitem", { name: /aaaaaaaa/i })).toBeInTheDocument();
  expect(await screen.findByTestId("canvas")).toHaveTextContent("3 nodes");
  // The latest (auto) row carries the auto trigger badge.
  expect(screen.getByRole("menuitem", { name: /cccccccc.*auto/i })).toBeInTheDocument();
```

In the test **"clicking an older snapshot loads it and shows the not-latest banner"**, change the click target (currently line 153) from:

```tsx
  fireEvent.click(await screen.findByText("aaaaaaaa"));
```

to:

```tsx
  fireEvent.click(await screen.findByRole("menuitem", { name: /aaaaaaaa/i }));
```

In the test **"compares two docs snapshots (GP-40)"**, change the two picks (currently lines 211-212) from:

```tsx
  fireEvent.click(screen.getByText("bbbbbbbb"));
  fireEvent.click(screen.getByText("aaaaaaaa"));
```

to:

```tsx
  fireEvent.click(screen.getByRole("menuitemcheckbox", { name: /bbbbbbbb/i }));
  fireEvent.click(screen.getByRole("menuitemcheckbox", { name: /aaaaaaaa/i }));
```

- [ ] **Step 2: Run the docs-page tests to confirm they now fail against the current UI**

Run: `pnpm --filter @groundplan/frontend test src/pages/docs-page.test.tsx`
Expected: FAIL — no `menuitem`/`menuitemcheckbox` roles exist yet (still the old `Timeline` cards).

- [ ] **Step 3: Update imports in `docs-page.tsx`**

At the top of `apps/frontend/src/pages/docs-page.tsx`:

- Remove the now-unused imports `formatDate` and `cn`. Change line 20-21 from:

```tsx
import { formatDate, repoName } from "@/lib/format";
import { cn } from "@/lib/utils";
```

to:

```tsx
import { repoName } from "@/lib/format";
```

- Add the `SnapshotSelect` import next to the existing `ViewSwitcher` import (after line 27):

```tsx
import { SnapshotSelect } from "@/components/snapshot-select";
```

- [ ] **Step 4: Remove the view switcher and network chip from the header cluster**

In the header action cluster, delete these lines (currently 237-243):

```tsx
              {current && !compareMode && <ViewSwitcher />}
              {network && network.hiddenCount > 0 && (
                <span className="text-muted-foreground bg-muted rounded-full px-2 py-0.5 font-mono text-[11px]">
                  {network.hiddenCount} resource{network.hiddenCount === 1 ? "" : "s"} not in
                  network view
                </span>
              )}
```

The cluster now starts directly with the `{canCompare && (` Compare button. Compare / Share / Export / Regenerate stay exactly as they are.

- [ ] **Step 5: Replace the `Timeline` render with the sub-toolbar, and add the in-flow status bar**

Replace the whole `Timeline` block (currently lines 276-284):

```tsx
      {snapshots.length > 0 && (
        <Timeline
          snapshots={snapshots}
          selectedIds={timelineSelected}
          visible={visible}
          onSelect={handleCardClick}
          onShowMore={() => setVisible((v) => v + PAGE)}
        />
      )}
```

with the sub-toolbar plus the relocated status banners:

```tsx
      {snapshots.length > 0 && (
        <div className="bg-card border-border flex items-center justify-between gap-4 border-b px-8 py-2.5">
          <div className="flex items-center gap-3">
            {current && !compareMode && <ViewSwitcher />}
            {network && network.hiddenCount > 0 && (
              <span className="text-muted-foreground bg-muted rounded-full px-2 py-0.5 font-mono text-[11px]">
                {network.hiddenCount} resource{network.hiddenCount === 1 ? "" : "s"} not in
                network view
              </span>
            )}
          </div>
          <SnapshotSelect
            snapshots={snapshots}
            selectedIds={timelineSelected}
            visible={visible}
            compareMode={compareMode}
            onSelect={handleCardClick}
            onShowMore={() => setVisible((v) => v + PAGE)}
          />
        </div>
      )}

      {snapshots.length > 0 && !compareActive && compareMode && (
        <div
          role="status"
          className="bg-accent border-border flex items-center justify-center gap-3 border-b px-4 py-2 text-xs"
        >
          Compare mode — pick {2 - compareSel.length} more snapshot
          {2 - compareSel.length === 1 ? "" : "s"} from the history dropdown.
          <button
            type="button"
            onClick={exitCompare}
            className="font-medium underline underline-offset-2"
          >
            Cancel
          </button>
        </div>
      )}

      {snapshots.length > 0 && !compareActive && !compareMode && viewingOld && (
        <div
          role="status"
          className="bg-amber-50 flex items-center justify-center gap-3 border-b border-amber-300 px-4 py-2 text-xs text-amber-900"
        >
          Viewing snapshot {shortSha(selectedId ?? "")} — not the latest.
          <button
            type="button"
            onClick={() => setSelectedId(latestId)}
            className="font-medium underline underline-offset-2"
          >
            Back to latest
          </button>
        </div>
      )}
```

- [ ] **Step 6: Remove the old absolute banners from inside the graph container**

Inside the `<div className="relative min-h-0 flex-1">` block, delete the two absolute status blocks that used to live there — the compare-mode block (currently lines 309-324) and the viewing-old block (currently lines 325-339). After deletion, the `{snapshots.length > 0 && !compareActive && (` fragment goes straight from its opening `<>` to `{graph.status === "loading" && …}`:

```tsx
        {snapshots.length > 0 && !compareActive && (
          <>
            {graph.status === "loading" && <Centered>Loading diagram…</Centered>}
            {graph.status === "error" && (
              <Centered>
                <ErrorBlock message={graph.message} onRetry={() => loadList(false)} />
              </Centered>
            )}
            {current && (
              <>
                {current.stats.warnings && current.stats.warnings.length > 0 && (
                  <WarningsNotice warnings={current.stats.warnings} />
                )}
                <GraphCanvas
                  graph={network ? network.graph : current.graph}
                  variant="docs"
                  containerIds={network?.containerIds}
                />
              </>
            )}
          </>
        )}
```

- [ ] **Step 7: Delete the `Timeline` and `SnapshotCard` components**

Remove both functions from `docs-page.tsx` — `Timeline` (currently lines 365-399) and `SnapshotCard` (currently lines 401-443). Their content now lives in `SnapshotSelect`. Leave `WarningsNotice`, `EmptyState`, `Centered`, and `ErrorBlock` intact.

- [ ] **Step 8: Run the docs-page tests**

Run: `pnpm --filter @groundplan/frontend test src/pages/docs-page.test.tsx`
Expected: PASS (all tests, including the compare and not-latest-banner cases).

- [ ] **Step 9: Typecheck (catches any now-unused import or symbol)**

Run: `pnpm --filter @groundplan/frontend typecheck`
Expected: no errors. If `noUnusedLocals` flags `formatDate` or `cn`, confirm Step 3's import edits were applied.

- [ ] **Step 10: Run the whole frontend suite**

Run: `pnpm --filter @groundplan/frontend test`
Expected: PASS (all files).

- [ ] **Step 11: Commit**

```bash
git add apps/frontend/src/pages/docs-page.tsx apps/frontend/src/pages/docs-page.test.tsx
git commit -m "feat(frontend): sub-toolbar with view tabs + history dropdown, in-flow status bar

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 4: Manual verification in the running app

**Files:** none (verification only).

- [ ] **Step 1: Start the app and drive the docs viewer**

Run the frontend (and backend, per repo docs) and open a repository's documentation page with at least two snapshots. Confirm:
  - The title row still shows Compare / Share / Export / Regenerate in the same place.
  - The sub-toolbar shows `Plan impact` / `Network` tabs on the left (active tab underlined) and the `History [ sha · TRIGGER · date ▾ ]` dropdown on the right.
  - Opening the dropdown lists snapshots (sha + trigger badge + date); picking one selects it and closes the panel; "Show more" reveals older snapshots.
  - Selecting an older snapshot shows the amber "not the latest" bar **fully visible** in the flow (not hidden behind the canvas search box), and "Back to latest" works.
  - Compare mode: the dropdown rows become checkboxes, picking two opens the diff; the compare banner is visible; Cancel exits.
  - Switching to the Network view moves the "N resources not in network view" chip next to the tabs.

- [ ] **Step 2: Confirm no console errors** during the above.

---

## Self-Review

**Spec coverage:**
- View switcher → tabs on a new sub-toolbar: Task 1 (restyle) + Task 3 Step 5 (placement). ✓
- History → right-side custom dropdown with sha/trigger/date rows: Task 2 + Task 3 Step 5. ✓
- Compare 2-pick via the dropdown: Task 2 (compare-mode checkboxes) + Task 3 Step 5/Step 1 (test). ✓
- Warning made visible (moved into flow): Task 3 Steps 5-6. ✓
- Action buttons stay put: Task 3 Step 4 leaves them untouched. ✓
- "N resources not in network view" chip relocated next to tabs: Task 3 Steps 4-5. ✓
- No new dependency (uses `<details>` pattern, not Popover — a deliberate deviation from the spec's "Dependencies" section to match the existing `ExportMenu` convention and avoid adding `@radix-ui/react-popover`). ✓
- Tests + axe: Task 2 (new component) + Task 3 (docs-page updates). ✓

**Placeholder scan:** No TBD/TODO; every code step shows full code. ✓

**Type consistency:** `SnapshotSelect` prop names (`snapshots`, `selectedIds`, `visible`, `compareMode`, `onSelect`, `onShowMore`) are identical in the component (Task 2 Step 3), its test (Task 2 Step 1), and the call site (Task 3 Step 5). `shortSha`, `formatDate`, `buttonVariants`, `cn` all match existing signatures. ✓
