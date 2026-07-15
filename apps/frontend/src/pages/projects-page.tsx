import { useCallback, useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { Boxes, Plus, Trash2, TriangleAlert } from "lucide-react";

import { ApiError, listProjects } from "@/api/client";
import type { Project } from "@/api/types";
import { formatDate } from "@/lib/format";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { CreateProjectDialog } from "@/components/create-project-dialog";
import { DeleteProjectDialog } from "@/components/delete-project-dialog";
import { PageHeader } from "@/components/page-header";

type LoadState =
  | { status: "loading" }
  | { status: "error"; message: string }
  | { status: "ready"; projects: Project[] };

export function ProjectsPage() {
  const [state, setState] = useState<LoadState>({ status: "loading" });

  const load = useCallback(() => {
    setState({ status: "loading" });
    listProjects()
      .then((projects) => setState({ status: "ready", projects }))
      .catch((err) =>
        setState({
          status: "error",
          message:
            err instanceof ApiError ? err.message : "Could not load projects.",
        }),
      );
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  // Add the new project to the list in place — no refetch, no reload.
  const handleCreated = useCallback((project: Project) => {
    setState((prev) =>
      prev.status === "ready"
        ? { status: "ready", projects: [project, ...prev.projects] }
        : prev,
    );
  }, []);

  // Drop the deleted project from the list in place — no refetch.
  const handleDeleted = useCallback((id: string) => {
    setState((prev) =>
      prev.status === "ready"
        ? { status: "ready", projects: prev.projects.filter((p) => p.id !== id) }
        : prev,
    );
  }, []);

  const hasProjects = state.status === "ready" && state.projects.length > 0;

  return (
    <div>
      <PageHeader
        eyebrow="Workspace"
        title="Projects"
        description="The infrastructure estates you're mapping."
        actions={
          hasProjects ? (
            <CreateProjectDialog
              onCreated={handleCreated}
              trigger={
                <Button>
                  <Plus className="size-4" />
                  New project
                </Button>
              }
            />
          ) : undefined
        }
      />

      <div className="p-8">
        {state.status === "loading" && <ProjectsSkeleton />}

        {state.status === "error" && (
          <ErrorState message={state.message} onRetry={load} />
        )}

        {state.status === "ready" && state.projects.length === 0 && (
          <EmptyState onCreated={handleCreated} />
        )}

        {hasProjects && state.status === "ready" && (
          <ul className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {state.projects.map((project) => (
              <li key={project.id}>
                <ProjectCard project={project} onDeleted={handleDeleted} />
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

function ProjectCard({
  project,
  onDeleted,
}: Readonly<{
  project: Project;
  onDeleted: (id: string) => void;
}>) {
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

const SKELETON_KEYS = [
  "skeleton-1",
  "skeleton-2",
  "skeleton-3",
  "skeleton-4",
  "skeleton-5",
  "skeleton-6",
];

function ProjectsSkeleton() {
  return (
    <div
      className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3"
      aria-busy="true"
      aria-live="polite"
    >
      <span className="sr-only">Loading projects…</span>
      {SKELETON_KEYS.map((key) => (
        <div
          key={key}
          aria-hidden="true"
          className="bg-card rounded-md border border-border p-6"
        >
          <div className="bg-muted h-4 w-2/3 animate-pulse rounded-sm" />
          <div className="bg-muted mt-3 h-3 w-1/3 animate-pulse rounded-sm" />
          <div className="bg-muted mt-6 h-3 w-1/2 animate-pulse rounded-sm" />
        </div>
      ))}
    </div>
  );
}

function EmptyState({
  onCreated,
}: Readonly<{ onCreated: (project: Project) => void }>) {
  return (
    <div className="bg-card/40 mx-auto flex max-w-md flex-col items-center gap-4 rounded-md border border-dashed border-border px-8 py-16 text-center">
      <div className="bg-accent text-primary grid size-12 place-items-center rounded-sm">
        <Boxes className="size-6" />
      </div>
      <div className="space-y-1">
        <h2 className="font-display text-lg font-semibold">No projects yet</h2>
        <p className="text-muted-foreground text-sm">
          Create your first project to start mapping infrastructure.
        </p>
      </div>
      <CreateProjectDialog
        onCreated={onCreated}
        trigger={
          <Button>
            <Plus className="size-4" />
            Create your first project
          </Button>
        }
      />
    </div>
  );
}

function ErrorState({
  message,
  onRetry,
}: Readonly<{
  message: string;
  onRetry: () => void;
}>) {
  return (
    <div
      role="alert"
      className="border-destructive/30 bg-destructive/5 mx-auto flex max-w-md flex-col items-center gap-4 rounded-md border px-8 py-12 text-center"
    >
      <div className="bg-destructive/10 text-destructive grid size-12 place-items-center rounded-sm">
        <TriangleAlert className="size-6" />
      </div>
      <div className="space-y-1">
        <h2 className="font-display text-lg font-semibold">
          Couldn't load projects
        </h2>
        <p className="text-muted-foreground text-sm">{message}</p>
      </div>
      <Button variant="outline" onClick={onRetry}>
        Try again
      </Button>
    </div>
  );
}
