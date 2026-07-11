# Delete a Project Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let users delete a project from the frontend, from both the projects list and the project detail page, guarded by a type-to-confirm dialog.

**Architecture:** The backend `DELETE /api/v1/projects/:id` and the client `deleteProject(id)` already exist (deletion cascades to all repositories and their data). This plan adds only frontend UI: one shared `DeleteProjectDialog` (Radix `Dialog`, type-to-confirm), reused by a hover-revealed trash button on each list card and a "Delete project" button in the detail-page header.

**Tech Stack:** React 19, TypeScript (strict), Vite, Tailwind v4, shadcn/ui (Radix Dialog), react-router-dom, lucide-react icons. Tests: vitest + Testing Library (jsdom) + vitest-axe.

## Global Constraints

- TypeScript `strict`, `noUncheckedIndexedAccess`, `noUnusedLocals/Parameters` — do not loosen; fix the code.
- Frontend imports use the `@/` alias (maps to `src/`). No `.js` extensions on frontend imports (that rule is backend-only).
- All HTTP goes through `src/api/client.ts` — never call `fetch` for the API from a component. `deleteProject(id: string): Promise<void>` already exists there.
- Never hardcode a colour — use semantic Tailwind utilities generated from the design tokens (e.g. `variant="destructive"`, `text-destructive`, `text-muted-foreground`). No `#hex`, no raw `bg-*-500`.
- Tests live beside their subject as `*.test.tsx`; mock `@/api/client`; assert accessibility with `vitest-axe`.
- Run all frontend tests: `pnpm --filter @groundplan/frontend test`
- Run one test file: `pnpm --filter @groundplan/frontend test <path>`
- Typecheck: `pnpm --filter @groundplan/frontend typecheck`

---

## File Structure

- **Create** `apps/frontend/src/components/delete-project-dialog.tsx` — the shared type-to-confirm dialog. One responsibility: confirm + call `deleteProject`, report result via `onDeleted`.
- **Create** `apps/frontend/src/components/delete-project-dialog.test.tsx` — unit tests for the dialog in isolation.
- **Modify** `apps/frontend/src/pages/projects-page.tsx` — add `handleDeleted` and a per-card delete trigger (restructure `ProjectCard`).
- **Modify** `apps/frontend/src/pages/projects-page.test.tsx` — add the mock + a "delete removes the card" test.
- **Modify** `apps/frontend/src/pages/project-detail-page.tsx` — add a header "Delete project" trigger that navigates to `/projects` on success.
- **Modify** `apps/frontend/src/pages/project-detail-page.test.tsx` — add the mock + a "delete navigates" test.

---

## Task 1: `DeleteProjectDialog` component

**Files:**
- Create: `apps/frontend/src/components/delete-project-dialog.tsx`
- Test: `apps/frontend/src/components/delete-project-dialog.test.tsx`

**Interfaces:**
- Consumes: `deleteProject(id: string): Promise<void>` and `ApiError` from `@/api/client`; `Project` from `@/api/types`; `Dialog*` from `@/components/ui/dialog`; `Button`, `Input`, `Label`.
- Produces:
  ```ts
  function DeleteProjectDialog(props: {
    project: Pick<Project, "id" | "name">;
    trigger: ReactNode;
    onDeleted: (id: string) => void;
  }): JSX.Element
  ```
  The confirmation input is reachable by the accessible label text `Type the project name to confirm`. The submit button's accessible name is exactly `Delete project`. On success it calls `onDeleted(project.id)` then closes.

- [ ] **Step 1: Write the failing test**

Create `apps/frontend/src/components/delete-project-dialog.test.tsx`:

```tsx
import { beforeEach, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { axe } from "vitest-axe";

vi.mock("@/api/client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/api/client")>();
  return { ...actual, deleteProject: vi.fn() };
});

import { ApiError, deleteProject } from "@/api/client";
import { Button } from "@/components/ui/button";
import { DeleteProjectDialog } from "./delete-project-dialog";

const deleteProjectMock = vi.mocked(deleteProject);
const project = { id: "p1", name: "Prod Platform" };

/** Render the dialog and open it via its trigger. */
function open(onDeleted = vi.fn()) {
  render(
    <DeleteProjectDialog
      project={project}
      onDeleted={onDeleted}
      trigger={<Button>Open delete</Button>}
    />,
  );
  fireEvent.click(screen.getByRole("button", { name: "Open delete" }));
  return { onDeleted };
}

const confirmInput = () => screen.getByLabelText(/type the project name/i);
const submitButton = () => screen.getByRole("button", { name: "Delete project" });

beforeEach(() => {
  deleteProjectMock.mockReset();
});

it("keeps the delete button disabled until the name is typed exactly", () => {
  open();
  expect(submitButton()).toBeDisabled();

  fireEvent.change(confirmInput(), { target: { value: "Prod" } });
  expect(submitButton()).toBeDisabled();

  fireEvent.change(confirmInput(), { target: { value: "Prod Platform" } });
  expect(submitButton()).toBeEnabled();
});

it("deletes the project, fires onDeleted, and closes on success", async () => {
  deleteProjectMock.mockResolvedValue(undefined);
  const { onDeleted } = open();

  fireEvent.change(confirmInput(), { target: { value: "Prod Platform" } });
  fireEvent.click(submitButton());

  await waitFor(() => expect(onDeleted).toHaveBeenCalledWith("p1"));
  expect(deleteProjectMock).toHaveBeenCalledWith("p1");
  await waitFor(() =>
    expect(screen.queryByRole("button", { name: "Delete project" })).not.toBeInTheDocument(),
  );
});

it("shows the server message and does not fire onDeleted on failure", async () => {
  deleteProjectMock.mockRejectedValue(new ApiError(500, "Server exploded"));
  const { onDeleted } = open();

  fireEvent.change(confirmInput(), { target: { value: "Prod Platform" } });
  fireEvent.click(submitButton());

  expect(await screen.findByText("Server exploded")).toBeInTheDocument();
  expect(onDeleted).not.toHaveBeenCalled();
});

it("has no accessibility violations when open", async () => {
  const { baseElement } = render(
    <DeleteProjectDialog
      project={project}
      onDeleted={vi.fn()}
      trigger={<Button>Open delete</Button>}
    />,
  );
  fireEvent.click(screen.getByRole("button", { name: "Open delete" }));
  const results = await axe(baseElement);
  expect(results.violations).toEqual([]);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm --filter @groundplan/frontend test src/components/delete-project-dialog.test.tsx`
Expected: FAIL — cannot resolve `./delete-project-dialog` / `DeleteProjectDialog is not defined`.

- [ ] **Step 3: Write the minimal implementation**

Create `apps/frontend/src/components/delete-project-dialog.tsx`:

```tsx
import { type FormEvent, type ReactNode, useState } from "react";

import { ApiError, deleteProject } from "@/api/client";
import type { Project } from "@/api/types";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

export function DeleteProjectDialog({
  project,
  trigger,
  onDeleted,
}: {
  project: Pick<Project, "id" | "name">;
  trigger: ReactNode;
  onDeleted: (id: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [confirmText, setConfirmText] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const confirmed = confirmText.trim() === project.name;

  function handleOpenChange(next: boolean) {
    setOpen(next);
    if (!next) {
      setConfirmText("");
      setError(null);
      setSubmitting(false);
    }
  }

  async function handleSubmit(event: FormEvent) {
    event.preventDefault();
    if (!confirmed) return;
    setSubmitting(true);
    setError(null);
    try {
      await deleteProject(project.id);
      onDeleted(project.id);
      handleOpenChange(false);
    } catch (err) {
      setError(
        err instanceof ApiError ? err.message : "Could not delete the project.",
      );
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogTrigger asChild>{trigger}</DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle className="font-display">Delete project</DialogTitle>
          <DialogDescription>
            This permanently deletes{" "}
            <span className="text-foreground font-medium">{project.name}</span>{" "}
            and every repository connected to it, along with their snapshots and
            share links. This cannot be undone.
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={handleSubmit} className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="confirm-project-name">
              Type the project name to confirm
            </Label>
            <Input
              id="confirm-project-name"
              value={confirmText}
              onChange={(e) => setConfirmText(e.target.value)}
              placeholder={project.name}
              autoComplete="off"
              autoFocus
            />
          </div>
          {error && (
            <p className="text-destructive text-sm" role="alert">
              {error}
            </p>
          )}
          <DialogFooter>
            <Button
              type="submit"
              variant="destructive"
              disabled={submitting || !confirmed}
            >
              {submitting ? "Deleting…" : "Delete project"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm --filter @groundplan/frontend test src/components/delete-project-dialog.test.tsx`
Expected: PASS (4 tests).

- [ ] **Step 5: Typecheck**

Run: `pnpm --filter @groundplan/frontend typecheck`
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add apps/frontend/src/components/delete-project-dialog.tsx apps/frontend/src/components/delete-project-dialog.test.tsx
git commit -m "feat(frontend): DeleteProjectDialog with type-to-confirm"
```

---

## Task 2: Delete from the projects list

**Files:**
- Modify: `apps/frontend/src/pages/projects-page.tsx`
- Test: `apps/frontend/src/pages/projects-page.test.tsx`

**Interfaces:**
- Consumes: `DeleteProjectDialog` from `@/components/delete-project-dialog` (Task 1); `deleteProject` from `@/api/client`; `Trash2` from `lucide-react`; `Button` from `@/components/ui/button`.
- Produces: no new exports. The per-card delete trigger has accessible name `Delete project {name}` (e.g. `Delete project Alpha`); deleting removes the project from the list in place (no refetch).

- [ ] **Step 1: Write the failing test**

Add the `deleteProject` mock and a test to `apps/frontend/src/pages/projects-page.test.tsx`.

First, change the `vi.mock` factory (top of file) to include `deleteProject`:

```tsx
vi.mock("@/api/client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/api/client")>();
  return {
    ...actual,
    listProjects: vi.fn(),
    createProject: vi.fn(),
    deleteProject: vi.fn(),
  };
});
```

Update the imports and mocked handles near the top:

```tsx
import { ApiError, createProject, deleteProject, listProjects } from "@/api/client";
```
```tsx
const deleteProjectMock = vi.mocked(deleteProject);
```

Add `waitFor` to the Testing Library import:

```tsx
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
```

Reset the mock in `beforeEach` (add one line):

```tsx
  deleteProjectMock.mockReset();
```

Then append this test:

```tsx
it("removes a project from the list when deleted, without refetching", async () => {
  listProjectsMock.mockResolvedValue([
    project({ id: "1", name: "Alpha", slug: "alpha" }),
    project({ id: "2", name: "Beta", slug: "beta" }),
  ]);
  deleteProjectMock.mockResolvedValue(undefined);
  renderPage();

  await screen.findByText("Alpha");
  fireEvent.click(screen.getByRole("button", { name: "Delete project Alpha" }));
  fireEvent.change(screen.getByLabelText(/type the project name/i), {
    target: { value: "Alpha" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Delete project" }));

  await waitFor(() =>
    expect(screen.queryByText("Alpha")).not.toBeInTheDocument(),
  );
  expect(screen.getByText("Beta")).toBeInTheDocument();
  expect(deleteProjectMock).toHaveBeenCalledWith("1");
  expect(listProjectsMock).toHaveBeenCalledTimes(1); // no refetch
});
```

Note: the card triggers are `Delete project Alpha` / `Delete project Beta`; the dialog submit is exactly `Delete project`. Exact-string `name` matching keeps them distinct.

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm --filter @groundplan/frontend test src/pages/projects-page.test.tsx`
Expected: FAIL — no button named `Delete project Alpha` (the card has no delete trigger yet).

- [ ] **Step 3: Add the delete handler and card trigger**

In `apps/frontend/src/pages/projects-page.tsx`:

3a. Add imports. This page calls `deleteProject` only indirectly (through the dialog), so leave the `@/api/client` import line unchanged. Make exactly two import changes:

Change the lucide import to include `Trash2`:

```tsx
import { Boxes, Plus, Trash2, TriangleAlert } from "lucide-react";
```

Add the dialog import (alongside the existing `@/components/*` imports):

```tsx
import { DeleteProjectDialog } from "@/components/delete-project-dialog";
```

(Leave `import { ApiError, listProjects } from "@/api/client";` as-is — the dialog imports `deleteProject` itself.)

3b. Add a `handleDeleted` callback inside `ProjectsPage`, right after `handleCreated`:

```tsx
  // Drop the deleted project from the list in place — no refetch.
  const handleDeleted = useCallback((id: string) => {
    setState((prev) =>
      prev.status === "ready"
        ? { status: "ready", projects: prev.projects.filter((p) => p.id !== id) }
        : prev,
    );
  }, []);
```

3c. Pass `onDeleted` down where the list renders `ProjectCard`:

```tsx
            {state.projects.map((project) => (
              <li key={project.id}>
                <ProjectCard project={project} onDeleted={handleDeleted} />
              </li>
            ))}
```

3d. Replace the `ProjectCard` function with the version below (wraps the `Link` in a `relative group` container and adds the delete trigger as a sibling of the link so a `<button>` is never nested inside the `<a>`):

```tsx
function ProjectCard({
  project,
  onDeleted,
}: {
  project: Project;
  onDeleted: (id: string) => void;
}) {
  return (
    <div className="group relative">
      <Link to={`/projects/${project.id}`} className="block">
        <Card className="hover:border-primary relative gap-0 overflow-hidden transition-colors">
          <span
            aria-hidden="true"
            className="border-grid-line group-hover:border-primary/60 pointer-events-none absolute top-2 right-2 size-2.5 border-t border-r transition-colors"
          />
          <CardHeader>
            <CardTitle className="font-display text-base">
              {project.name}
            </CardTitle>
            <CardDescription className="font-mono text-xs">
              {project.slug}
            </CardDescription>
          </CardHeader>
          <div className="text-muted-foreground mt-4 border-t border-border px-6 pt-3 font-mono text-xs">
            Created {formatDate(project.createdAt)}
          </div>
        </Card>
      </Link>
      <DeleteProjectDialog
        project={project}
        onDeleted={onDeleted}
        trigger={
          <Button
            variant="ghost"
            size="icon"
            aria-label={`Delete project ${project.name}`}
            className="text-muted-foreground hover:text-destructive absolute top-1.5 right-1.5 size-7 opacity-0 transition-opacity focus-visible:opacity-100 group-hover:opacity-100"
          >
            <Trash2 className="size-4" />
          </Button>
        }
      />
    </div>
  );
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm --filter @groundplan/frontend test src/pages/projects-page.test.tsx`
Expected: PASS (all tests, including the new one and the existing axe test).

- [ ] **Step 5: Typecheck**

Run: `pnpm --filter @groundplan/frontend typecheck`
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add apps/frontend/src/pages/projects-page.tsx apps/frontend/src/pages/projects-page.test.tsx
git commit -m "feat(frontend): delete a project from the projects list"
```

---

## Task 3: Delete from the project detail page

**Files:**
- Modify: `apps/frontend/src/pages/project-detail-page.tsx`
- Test: `apps/frontend/src/pages/project-detail-page.test.tsx`

**Interfaces:**
- Consumes: `DeleteProjectDialog` from `@/components/delete-project-dialog` (Task 1); `useNavigate` from `react-router-dom`; `Trash2`, `Button` (already imported in this file).
- Produces: no new exports. The header exposes a `Delete project` trigger (always present once the project has loaded, even with zero repos); deleting navigates to `/projects`.

- [ ] **Step 1: Write the failing test**

In `apps/frontend/src/pages/project-detail-page.test.tsx`:

1a. Add `deleteProject` to the `vi.mock` factory:

```tsx
vi.mock("@/api/client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/api/client")>();
  return {
    ...actual,
    getProject: vi.fn(),
    listRepositories: vi.fn(),
    createRepository: vi.fn(),
    verifyRepository: vi.fn(),
    updateRepository: vi.fn(),
    deleteProject: vi.fn(),
  };
});
```

1b. Import it and make a handle:

```tsx
import {
  ApiError,
  createRepository,
  deleteProject,
  getProject,
  listRepositories,
  updateRepository,
  verifyRepository,
} from "@/api/client";
```
```tsx
const deleteProjectMock = vi.mocked(deleteProject);
```

1c. Reset it in `beforeEach` (add one line):

```tsx
  deleteProjectMock.mockReset();
```

1d. Append this test. It adds a `/projects` route so navigation is observable, and scopes the confirm/submit queries to the open dialog (the header trigger and the dialog submit share the accessible name `Delete project`):

```tsx
it("deletes the project and navigates to the projects list", async () => {
  listRepositoriesMock.mockResolvedValue([]);
  deleteProjectMock.mockResolvedValue(undefined);
  render(
    <MemoryRouter initialEntries={["/projects/p1"]}>
      <Routes>
        <Route path="/projects/:id" element={<ProjectDetailPage />} />
        <Route path="/projects" element={<div>Projects list page</div>} />
      </Routes>
    </MemoryRouter>,
  );

  // Only the header trigger exists before the dialog opens.
  fireEvent.click(await screen.findByRole("button", { name: "Delete project" }));

  const dialog = await screen.findByRole("dialog");
  fireEvent.change(within(dialog).getByLabelText(/type the project name/i), {
    target: { value: "Prod Platform" },
  });
  fireEvent.click(within(dialog).getByRole("button", { name: "Delete project" }));

  expect(await screen.findByText("Projects list page")).toBeInTheDocument();
  expect(deleteProjectMock).toHaveBeenCalledWith("p1");
});
```

(`MemoryRouter`, `Routes`, `Route`, `within` are already imported in this test file.)

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm --filter @groundplan/frontend test src/pages/project-detail-page.test.tsx`
Expected: FAIL — no button named `Delete project` in the header yet.

- [ ] **Step 3: Add the header delete trigger and navigation**

In `apps/frontend/src/pages/project-detail-page.tsx`:

3a. Add `useNavigate` to the router import:

```tsx
import { Link, useNavigate, useParams } from "react-router-dom";
```

3b. Import the dialog (alongside the other `@/components/*` imports):

```tsx
import { DeleteProjectDialog } from "@/components/delete-project-dialog";
```

(`Trash2` and `Button` are already imported in this file — no change needed there.)

3c. Inside `ProjectDetailPage`, add the navigate hook and a delete handler. Put these right after `const [state, setState] = useState(...)`:

```tsx
  const navigate = useNavigate();

  const handleProjectDeleted = useCallback(() => {
    navigate("/projects");
  }, [navigate]);
```

3d. Replace the `PageHeader` `actions` prop. Currently:

```tsx
        actions={
          hasRepos && state.status === "ready" ? (
            <AttachRepositoryDialog
              projectId={state.project.id}
              onAttached={handleAttached}
              trigger={
                <Button>
                  <Plus className="size-4" />
                  Attach repository
                </Button>
              }
            />
          ) : undefined
        }
```

Replace with (Attach stays gated on `hasRepos`; Delete shows whenever the project is loaded):

```tsx
        actions={
          state.status === "ready" ? (
            <div className="flex items-center gap-2">
              {hasRepos && (
                <AttachRepositoryDialog
                  projectId={state.project.id}
                  onAttached={handleAttached}
                  trigger={
                    <Button>
                      <Plus className="size-4" />
                      Attach repository
                    </Button>
                  }
                />
              )}
              <DeleteProjectDialog
                project={state.project}
                onDeleted={handleProjectDeleted}
                trigger={
                  <Button variant="outline">
                    <Trash2 className="size-4" />
                    Delete project
                  </Button>
                }
              />
            </div>
          ) : undefined
        }
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm --filter @groundplan/frontend test src/pages/project-detail-page.test.tsx`
Expected: PASS (all tests, including the new one).

- [ ] **Step 5: Typecheck**

Run: `pnpm --filter @groundplan/frontend typecheck`
Expected: no errors.

- [ ] **Step 6: Run the full frontend test suite**

Run: `pnpm --filter @groundplan/frontend test`
Expected: PASS — the whole suite is green.

- [ ] **Step 7: Commit**

```bash
git add apps/frontend/src/pages/project-detail-page.tsx apps/frontend/src/pages/project-detail-page.test.tsx
git commit -m "feat(frontend): delete a project from the detail page"
```

---

## Notes for the implementer

- The delete cascade (repositories, snapshots, ingestion events, share links) is enforced server-side; the frontend only calls `deleteProject(id)`. Do not add client-side cleanup.
- Do not sweep the pre-existing unrelated working-tree changes (runtime-config work) into these commits — `git add` only the exact files listed per task.
- If `axe` flags the open Radix dialog, prefer fixing the markup (label association, dialog title/description) over relaxing the assertion.
