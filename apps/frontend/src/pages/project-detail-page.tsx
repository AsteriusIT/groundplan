import { useCallback, useEffect, useState } from "react";
import { Link, useParams } from "react-router-dom";
import {
  ChevronLeft,
  GitBranch,
  GitPullRequest,
  KeyRound,
  Plug,
  Plus,
  RefreshCw,
  Trash2,
  TriangleAlert,
} from "lucide-react";

import {
  ApiError,
  deleteRepository,
  getProject,
  listRepositories,
  verifyRepository,
  webhookUrl,
} from "@/api/client";
import type { CreatedRepository, Project, Repository } from "@/api/types";
import { repoName } from "@/lib/format";
import { Button } from "@/components/ui/button";
import { PageHeader } from "@/components/page-header";
import { AttachRepositoryDialog } from "@/components/attach-repository-dialog";
import { CiSetupBlock } from "@/components/ci-setup-block";
import {
  ConnectionStatusBadge,
  connectionErrorMessage,
} from "@/components/connection-status";
import { EditPatDialog } from "@/components/edit-pat-dialog";

type LoadState =
  | { status: "loading" }
  | { status: "error"; message: string }
  | { status: "ready"; project: Project; repos: Repository[] };

export function ProjectDetailPage() {
  const { id } = useParams<{ id: string }>();
  const [state, setState] = useState<LoadState>({ status: "loading" });

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

  const hasRepos = state.status === "ready" && state.repos.length > 0;

  return (
    <div>
      <PageHeader
        eyebrow="Project"
        title={state.status === "ready" ? state.project.name : "Project"}
        description="Repositories connected to this project."
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
      />

      <div className="p-8">
        <Link
          to="/projects"
          className="text-muted-foreground hover:text-foreground mb-6 inline-flex items-center gap-1 text-sm"
        >
          <ChevronLeft className="size-4" />
          All projects
        </Link>

        {state.status === "loading" && (
          <p className="text-muted-foreground text-sm" aria-busy="true">
            Loading project…
          </p>
        )}

        {state.status === "error" && (
          <ErrorState message={state.message} onRetry={load} />
        )}

        {state.status === "ready" && state.repos.length === 0 && (
          <EmptyState projectId={state.project.id} onAttached={handleAttached} />
        )}

        {hasRepos && state.status === "ready" && (
          <ul className="space-y-3">
            {state.repos.map((repo) => (
              <li key={repo.id}>
                <RepositoryRow
                  repo={repo}
                  onChanged={handleChanged}
                  onDeleted={handleDeleted}
                />
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

function RepositoryRow({
  repo,
  onChanged,
  onDeleted,
}: {
  repo: Repository;
  onChanged: (repo: Repository) => void;
  onDeleted: (id: string) => void;
}) {
  const [showCi, setShowCi] = useState(false);
  const [verifying, setVerifying] = useState(false);
  const [verifyMessage, setVerifyMessage] = useState<string | null>(null);

  async function handleVerify() {
    setVerifying(true);
    setVerifyMessage(null);
    try {
      const result = await verifyRepository(repo.id);
      onChanged({
        ...repo,
        connectionStatus: result.ok ? "ok" : "failed",
        verifiedAt: new Date().toISOString(),
      });
      if (!result.ok) setVerifyMessage(connectionErrorMessage(result.error));
    } catch {
      setVerifyMessage("Could not verify the connection.");
    } finally {
      setVerifying(false);
    }
  }

  async function handleDelete() {
    if (!window.confirm(`Remove ${repoName(repo.url)} from this project?`)) return;
    try {
      await deleteRepository(repo.id);
      onDeleted(repo.id);
    } catch {
      setVerifyMessage("Could not remove the repository.");
    }
  }

  return (
    <div className="bg-card rounded-md border border-border">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2 px-4 py-3">
        <div className="min-w-0 flex-1">
          <p className="font-mono text-sm font-medium">{repoName(repo.url)}</p>
          <p className="text-muted-foreground mt-0.5 flex items-center gap-2 font-mono text-xs">
            <span className="capitalize">{repo.provider}</span>
            <span className="inline-flex items-center gap-1">
              <GitBranch className="size-3" />
              {repo.defaultBranch}
            </span>
          </p>
        </div>

        <ConnectionStatusBadge status={repo.connectionStatus} />

        <div className="flex flex-wrap items-center gap-1.5">
          <Button variant="outline" size="sm" asChild>
            <Link to={`/projects/${repo.projectId}/repos/${repo.id}/pulls`}>
              <GitPullRequest className="size-3.5" />
              Pull requests
            </Link>
          </Button>
          <Button
            variant="outline"
            size="sm"
            onClick={handleVerify}
            disabled={verifying}
          >
            <RefreshCw className={verifying ? "size-3.5 animate-spin" : "size-3.5"} />
            {verifying ? "Verifying…" : "Verify"}
          </Button>
          <EditPatDialog
            repository={repo}
            onUpdated={onChanged}
            trigger={
              <Button variant="outline" size="sm">
                <KeyRound className="size-3.5" />
                {repo.accessToken ? "Edit token" : "Add token"}
              </Button>
            }
          />
          <Button
            variant="outline"
            size="sm"
            aria-expanded={showCi}
            onClick={() => setShowCi((v) => !v)}
          >
            <Plug className="size-3.5" />
            CI setup
          </Button>
          <Button
            variant="ghost"
            size="icon"
            aria-label="Remove repository"
            onClick={handleDelete}
          >
            <Trash2 className="size-4" />
          </Button>
        </div>
      </div>

      {verifyMessage && (
        <p
          className="text-destructive border-t border-border px-4 py-2 text-sm"
          role="alert"
        >
          {verifyMessage}
        </p>
      )}

      {showCi && (
        <div className="border-t border-border p-4">
          <CiSetupBlock webhookUrl={webhookUrl(repo.id)} />
        </div>
      )}
    </div>
  );
}

function EmptyState({
  projectId,
  onAttached,
}: {
  projectId: string;
  onAttached: (repo: CreatedRepository) => void;
}) {
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
}: {
  message: string;
  onRetry: () => void;
}) {
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
