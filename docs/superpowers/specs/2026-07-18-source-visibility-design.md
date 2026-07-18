# Terraform source visibility — design

Date: 2026-07-18
Status: approved (user-selected options), extends GP-120/GP-121

## Problem

The docs detail panel shows a node's verbatim HCL (GP-121) inside a fixed
320px (`w-80`) side panel. Horizontal scroll instead of wrapping is the
right call (wrapped HCL stops looking like the file), but at that width
nearly every line scrolls — the code is read through a letterbox.

## Decisions (user-validated)

Three measures, together:

1. **Expand into an overlay.** An expand button on the Source row opens a
   wide dialog showing the same verbatim highlighted block.
2. **Widen the details panel** to 416px (`w-[26rem]`).
3. **Resizable panel, opt-in via Settings.** A drag handle on the panel's
   left edge — but only when the "Details panel" appearance preference is
   set to *Resizable* (default *Fixed*).

Whole-file context (GP-4 file API) was offered and not selected — out of
scope here.

## 1. Source overlay (`node-details-panel.tsx`)

- The tokenized `<pre>` rendering is extracted into a local `HclBlock`
  component (used by both the inline snippet and the dialog — the
  highlighting stays one implementation).
- `SourceSection` gains an icon button (`Maximize2`, label "Expand
  source") beside the copy button on the summary row. It opens a `Dialog`
  whose content overrides the default width
  (`sm:max-w-[min(92vw,60rem)]`): title is the file path (mono),
  description the line span, body the `HclBlock` at `text-xs` in a
  `max-h-[70vh]` scroll area, plus its own copy button.
- The summary's buttons live in a wrapper that calls `preventDefault()`
  on click, so neither copy nor expand toggles the `<details>` — this also
  fixes the existing quirk where copying collapsed the section.

## 2. Wider panel (`node-details-panel.tsx`)

`SidePanel` already takes `className`; the details panel passes
`w-[26rem]`. Other `SidePanel` users are unaffected.

## 3. Opt-in resizable width

- **`src/panel/panel-prefs.tsx`** — provider + hook, the tour-style
  pattern exactly: `usePanelPrefs()` → `{ mode, setMode, width,
  setWidth }`. `mode` is `"fixed" | "resizable"` (key
  `groundplan-panel-mode`, default `fixed`); `width` a number in px (key
  `groundplan-panel-width`, default 416, clamped to [320, 720] on read
  and write). Registered in `main.tsx` beside `TourStyleProvider`.
  Unlike theme/tour, the hook returns the defaults when no provider is
  mounted (the off-state) so the many existing panel tests don't all
  need wrapping; the app always mounts the provider.
- **`components/panel-mode-switcher.tsx`** — segmented Fixed | Resizable
  fieldset, same shape as `TourStyleSwitcher`. Rendered as a third row of
  the Settings → Appearance card with a blurb per mode. Settings is its
  only home.
- **`node-details-panel.tsx`** — in resizable mode the panel gets
  `style={{ width }}` and a left-edge drag handle:
  `role="separator"`, `aria-orientation="vertical"`, `aria-label="Resize
  panel"`, `aria-valuenow/min/max`, `tabIndex=0`. Pointer capture drags
  live via local state; `setWidth` (persisting) fires on pointer up.
  Arrow keys adjust by 16px (persisting immediately). In fixed mode:
  no handle, no inline width — exactly today's behaviour plus the widen.

## Edge cases

- Width clamps at both ends; a garbage stored value falls back to 416.
- The dialog copies `source.code` raw, as the panel does — highlighting
  is a lens, never the payload.
- jsdom: pointer capture guarded (`setPointerCapture` may be absent).

## Testing

TDD; vitest + Testing Library + vitest-axe.

- `panel-prefs.test.tsx`: defaults, persistence, clamping, no-provider
  fallback.
- `node-details-panel.test.tsx`: expand opens the dialog (code + file +
  span visible, copy present); summary buttons don't collapse the
  section; handle absent in fixed mode, present in resizable; drag and
  arrow keys change the width; axe clean.
- `settings-page.test.tsx`: the Appearance card shows the Details panel
  switcher; switching persists.

## Out of scope

- Whole-file fetch/scroll-to-block (GP-4) — a later story.
- Resizing any other `SidePanel` user.
- Mobile drag affordances (the panel is a desktop reviewer surface).
