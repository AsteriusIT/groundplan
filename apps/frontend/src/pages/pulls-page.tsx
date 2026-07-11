import { useCallback, useEffect, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { ChevronLeft, GitPullRequest, TriangleAlert } from "lucide-react";

import { ApiError, getRepository, listPulls } from "@/api/client";
import type { PullSummary, Repository } from "@/api/types";
import { formatDate, repoName } from "@/lib/format";
import { cn } from "@/lib/utils";
import { PageHeader } from "@/components/page-header";
import { ChangeChips } from "@/components/change-chips";

type LoadState =
  | { status: "loading" }
  | { status: "error"; message: string }
  | { status: "ready"; repo: Repository; pulls: PullSummary[] };

export function PullsPage() {
  const { id, repoId } = useParams<{ id: string; repoId: string }>();
  const [state, setState] = useState<LoadState>({ status: "loading" });

  const load = useCallback(() => {
    if (!repoId) return;
    setState({ status: "loading" });
    Promise.all([getRepository(repoId), listPulls(repoId)])
      .then(([repo, pulls]) => setState({ status: "ready", repo, pulls }))
      .catch((err) =>
        setState({
          status: "error",
          message:
            err instanceof ApiError ? err.message : "Could not load pull requests.",
        }),
      );
  }, [repoId]);

  useEffect(() => {
    load();
  }, [load]);

  return (
    <div>
      <PageHeader
        eyebrow="Pull requests"
        title={state.status === "ready" ? repoName(state.repo.url) : "Pull requests"}
        description="Plan-impact diagrams from your CI, one per pull request."
      />
      <div className="p-8">
        <Link
          to={`/projects/${id}`}
          className="text-muted-foreground hover:text-foreground mb-6 inline-flex items-center gap-1 text-sm"
        >
          <ChevronLeft className="size-4" />
          Back to project
        </Link>

        {state.status === "loading" && (
          <p className="text-muted-foreground text-sm" aria-busy="true">
            Loading pull requests…
          </p>
        )}

        {state.status === "error" && (
          <ErrorState message={state.message} onRetry={load} />
        )}

        {state.status === "ready" && state.pulls.length === 0 && <EmptyState />}

        {state.status === "ready" && state.pulls.length > 0 && (
          <ul className="space-y-2">
            {state.pulls.map((pull) => (
              <li key={pull.id}>
                <PullRow projectId={id!} repoId={repoId!} pull={pull} />
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

function PullRow({
  projectId,
  repoId,
  pull,
}: {
  projectId: string;
  repoId: string;
  pull: PullSummary;
}) {
  return (
    <Link
      to={`/projects/${projectId}/repos/${repoId}/pulls/${pull.number}`}
      className="bg-card hover:border-primary flex items-center gap-4 rounded-md border border-border px-4 py-3 transition-colors"
    >
      <GitPullRequest
        className={cn(
          "size-4 shrink-0",
          pull.state === "open" ? "text-emerald-600" : "text-muted-foreground",
        )}
      />
      <div className="min-w-0 flex-1">
        <p
          className={cn(
            "truncate text-sm font-medium",
            pull.state === "closed" && "text-muted-foreground line-through",
          )}
        >
          {pull.title ?? `Pull request #${pull.number}`}
        </p>
        <p className="text-muted-foreground mt-0.5 font-mono text-xs">
          #{pull.number} · updated {formatDate(pull.updatedAt)}
        </p>
      </div>
      {pull.latestSnapshot ? (
        <ChangeChips changes={pull.latestSnapshot.stats.changes} />
      ) : (
        <span className="text-muted-foreground font-mono text-xs">no diagram</span>
      )}
    </Link>
  );
}

function EmptyState() {
  return (
    <div className="bg-card/40 mx-auto flex max-w-md flex-col items-center gap-4 rounded-md border border-dashed border-border px-8 py-16 text-center">
      <div className="bg-accent text-primary grid size-12 place-items-center rounded-sm">
        <GitPullRequest className="size-6" />
      </div>
      <div className="space-y-1">
        <h2 className="font-display text-lg font-semibold">No pull requests yet</h2>
        <p className="text-muted-foreground text-sm">
          Once your CI posts a plan for a pull request, it appears here.
        </p>
      </div>
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
      <TriangleAlert className="text-destructive size-8" />
      <p className="text-muted-foreground text-sm">{message}</p>
      <button
        type="button"
        onClick={onRetry}
        className="text-primary text-sm underline-offset-4 hover:underline"
      >
        Try again
      </button>
    </div>
  );
}
