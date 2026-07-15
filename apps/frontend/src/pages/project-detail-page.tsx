import { useCallback, useEffect, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { Ellipsis, Plug, Plus, Trash2, TriangleAlert } from "lucide-react";

import {
  ApiError,
  getProject,
  listRepositories,
  listRepositoryActivity,
  updateProject,
} from "@/api/client";
import type {
  CreatedRepository,
  Project,
  Repository,
  RepositoryActivity,
} from "@/api/types";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { ContextSection } from "@/components/context-section";
import { PageHeader } from "@/components/page-header";
import { AttachRepositoryDialog } from "@/components/attach-repository-dialog";
import { DeleteProjectDialog } from "@/components/delete-project-dialog";
import { RepositoryCard } from "@/components/repository-card";

type LoadState =
  | { status: "loading" }
  | { status: "error"; message: string }
  | { status: "ready"; project: Project; repos: Repository[] };

export function ProjectDetailPage() {
  const { id } = useParams<{ id: string }>();
  const [state, setState] = useState<LoadState>({ status: "loading" });
  const [activity, setActivity] = useState<Map<string, RepositoryActivity>>(
    new Map(),
  );
  const [deleteOpen, setDeleteOpen] = useState(false);

  const navigate = useNavigate();

  const handleProjectDeleted = useCallback(() => {
    navigate("/projects");
  }, [navigate]);

  const load = useCallback(() => {
    if (!id) return;
    setState({ status: "loading" });
    Promise.all([getProject(id), listRepositories(id)])
      .then(([project, repos]) => setState({ status: "ready", project, repos }))
      .catch((err) =>
        setState({
          status: "error",
          message:
            err instanceof ApiError ? err.message : "Could not load the project.",
        }),
      );

    // Freshness signal is decoration, not the page: if it fails, the repositories
    // still list — the cards just drop their activity strip.
    listRepositoryActivity(id)
      .then((rows) => setActivity(new Map(rows.map((r) => [r.repositoryId, r]))))
      .catch(() => setActivity(new Map()));
  }, [id]);

  useEffect(() => {
    load();
  }, [load]);

  const handleAttached = useCallback((repo: CreatedRepository) => {
    setState((prev) =>
      prev.status === "ready"
        ? { ...prev, repos: [repo, ...prev.repos] }
        : prev,
    );
  }, []);

  const handleChanged = useCallback((updated: Repository) => {
    setState((prev) =>
      prev.status === "ready"
        ? {
            ...prev,
            repos: prev.repos.map((r) => (r.id === updated.id ? updated : r)),
          }
        : prev,
    );
  }, []);

  const handleDeleted = useCallback((repoId: string) => {
    setState((prev) =>
      prev.status === "ready"
        ? { ...prev, repos: prev.repos.filter((r) => r.id !== repoId) }
        : prev,
    );
  }, []);

  // GP-60: save the project's long-form context (optimistic).
  const handleSaveContext = useCallback(
    (contextMd: string) => {
      if (!id) return;
      setState((prev) =>
        prev.status === "ready"
          ? { ...prev, project: { ...prev.project, contextMd } }
          : prev,
      );
      updateProject(id, { contextMd })
        .then((project) =>
          setState((prev) =>
            prev.status === "ready" ? { ...prev, project } : prev,
          ),
        )
        .catch(() => {});
    },
    [id],
  );

  const hasRepos = state.status === "ready" && state.repos.length > 0;

  return (
    <div>
      <PageHeader
        eyebrow="Project"
        title={state.status === "ready" ? state.project.name : "Project"}
        description="Repositories connected to this project."
        backTo="/projects"
        backLabel="All projects"
        actions={
          state.status === "ready" ? (
            <>
              {/* Deleting a project is not a page action — it is the last resort
                  in a menu, nowhere near the primary CTA it used to sit beside. */}
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button variant="ghost" size="icon" aria-label="Project actions">
                    <Ellipsis className="size-4" />
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end" className="w-48">
                  <DropdownMenuItem
                    variant="destructive"
                    onSelect={() => setDeleteOpen(true)}
                  >
                    <Trash2 className="size-3.5" />
                    Delete project
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
              <DeleteProjectDialog
                project={state.project}
                open={deleteOpen}
                onOpenChange={setDeleteOpen}
                onDeleted={handleProjectDeleted}
              />
            </>
          ) : undefined
        }
      />

      <div className="p-8">
        {state.status === "loading" && (
          <p className="text-muted-foreground text-sm" aria-busy="true">
            Loading project…
          </p>
        )}

        {state.status === "error" && (
          <ErrorState message={state.message} onRetry={load} />
        )}

        {state.status === "ready" && (
          <div className="mb-8 max-w-3xl">
            <ContextSection
              markdown={state.project.contextMd}
              hint="Grounds the AI change summaries and documentation for every repository here — write what a new reviewer would need to know."
              onSave={handleSaveContext}
            />
          </div>
        )}

        {state.status === "ready" && state.repos.length === 0 && (
          <EmptyState projectId={state.project.id} onAttached={handleAttached} />
        )}

        {hasRepos && state.status === "ready" && (
          <section className="space-y-3">
            {/* The action lives with the list it acts on. */}
            <div className="flex items-center justify-between gap-4">
              <h2 className="font-display text-sm font-semibold">
                Repositories{" "}
                <span className="text-muted-foreground font-mono font-normal">
                  ({state.repos.length})
                </span>
              </h2>
              <AttachRepositoryDialog
                projectId={state.project.id}
                onAttached={handleAttached}
                trigger={
                  <Button size="sm">
                    <Plus className="size-4" />
                    Attach repository
                  </Button>
                }
              />
            </div>

            <ul className="space-y-3">
              {state.repos.map((repo) => (
                <li key={repo.id}>
                  <RepositoryCard
                    repo={repo}
                    activity={activity.get(repo.id)}
                    onChanged={handleChanged}
                    onDeleted={handleDeleted}
                  />
                </li>
              ))}
            </ul>
          </section>
        )}

      </div>
    </div>
  );
}

function EmptyState({
  projectId,
  onAttached,
}: Readonly<{
  projectId: string;
  onAttached: (repo: CreatedRepository) => void;
}>) {
  return (
    <div className="bg-card/40 mx-auto flex max-w-md flex-col items-center gap-4 rounded-md border border-dashed border-border px-8 py-16 text-center">
      <div className="bg-accent text-primary grid size-12 place-items-center rounded-sm">
        <Plug className="size-6" />
      </div>
      <div className="space-y-1">
        <h2 className="font-display text-lg font-semibold">No repositories yet</h2>
        <p className="text-muted-foreground text-sm">
          Attach a repository to start mapping its Terraform.
        </p>
      </div>
      <AttachRepositoryDialog
        projectId={projectId}
        onAttached={onAttached}
        trigger={
          <Button>
            <Plus className="size-4" />
            Attach your first repository
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
      <p className="text-muted-foreground text-sm">{message}</p>
      <Button variant="outline" onClick={onRetry}>
        Try again
      </Button>
    </div>
  );
}
