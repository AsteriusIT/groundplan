# Delete a project — design

_Date: 2026-07-11_

## Problem

Users can create projects but have no way to delete one. The backend and API
client already support deletion; only the frontend UI is missing.

- Backend: `DELETE /api/v1/projects/:id` exists. Deletion **cascades** — removing a
  project removes all its repositories and their downstream data (snapshots,
  ingestion events, share links).
- API client: `deleteProject(id)` is already wired in
  `apps/frontend/src/api/client.ts`.
- Gap: no UI triggers it. Neither the projects list cards nor the project detail
  page expose a delete affordance. (Repository-level delete already exists on the
  detail page via a plain `window.confirm`.)

## Decisions

- **Placement:** both the projects list cards **and** the project detail page
  header.
- **Confirmation:** a type-to-confirm dialog (the user must type the project name
  to enable the destructive action), chosen over a plain `window.confirm` because
  the delete cascades and is irreversible.

## Design

### 1. Shared `DeleteProjectDialog` component

New file: `apps/frontend/src/components/delete-project-dialog.tsx`, modeled on the
existing `CreateProjectDialog` (controlled Radix `Dialog`, `trigger` prop, result
callback).

Props:

```ts
{
  project: Pick<Project, "id" | "name">;
  trigger: ReactNode;
  onDeleted: (id: string) => void;
}
```

Behavior:

- Renders warning copy naming the cascade, e.g.: _"This permanently deletes
  **{name}** and every repository connected to it, along with their snapshots and
  share links. This cannot be undone."_
- A labeled text input for the confirmation. The **Delete** button uses
  `variant="destructive"` and stays `disabled` until
  `confirmText.trim() === project.name` (and while submitting).
- On confirm: call `deleteProject(project.id)`, then `onDeleted(project.id)`, then
  close. Shows a "Deleting…" pending state.
- On failure: surface `ApiError.message` inline (mirroring `CreateProjectDialog`);
  do **not** fire `onDeleted`.
- Reset all local state when the dialog closes (matching `handleOpenChange` in
  `CreateProjectDialog`).
- Accessibility: `DialogTitle` + `DialogDescription`; the input has an associated
  `Label` (`htmlFor`).

The dialog does not fetch or display a repository count — the list page does not
have that data and fetching it solely for the dialog is not worth it. The generic
"every repository" wording covers the cascade.

### 2. Projects list page (`apps/frontend/src/pages/projects-page.tsx`)

- Add `handleDeleted(id)` that removes the project from `state.projects` in place
  (no refetch), mirroring the existing `handleCreated`.
- **Card restructure:** `ProjectCard` currently renders a `<Link>` wrapping the
  entire card. A `<button>` cannot be nested inside an `<a>`, so the card becomes a
  `relative` wrapper with:
  - the `<Link>` as the primary click target, and
  - the `DeleteProjectDialog` trigger as an **absolutely-positioned sibling** (top
    right) — a trash icon-button with `aria-label="Delete project {name}"`,
    revealed on hover and always visible on keyboard focus.

  Because the trigger is a sibling (not a descendant of the anchor), clicking it
  opens the dialog without navigating.

### 3. Project detail page (`apps/frontend/src/pages/project-detail-page.tsx`)

- Add a **"Delete project"** button to the `PageHeader` `actions`, beside "Attach
  repository". It renders whenever the project is loaded (`status === "ready"`),
  including when the project has zero repositories — unlike the Attach button,
  which is gated on `hasRepos` because the empty state renders its own attach CTA.
- Pass an `onDeleted` that calls `useNavigate()("/projects")`.

## Testing

Vitest + Testing Library in jsdom; mock `@/api/client`; assert accessibility with
`vitest-axe`. Tests live beside their subject.

- New `delete-project-dialog.test.tsx`:
  - Delete button disabled until the typed text exactly matches the project name;
    enabled on match.
  - On success: calls `deleteProject(id)`, fires `onDeleted(id)`, closes the
    dialog.
  - On `ApiError`: shows the server message and does **not** fire `onDeleted`.
  - No accessibility violations (axe).
- Extend `projects-page.test.tsx`: deleting a card removes that project from the
  list without a refetch (`listProjects` still called once).
- Extend `project-detail-page.test.tsx`: deleting navigates to `/projects`.

## Out of scope (YAGNI)

- Bulk delete / multi-select.
- Undo / soft-delete.
- Treating a `404` on delete as success (already-deleted). Surface the error for
  now; keep it simple.
- A shared, reusable confirm-dialog abstraction — a single dialog pattern is
  enough for one call site shape.
