import { useCallback, useEffect, useMemo, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { ChevronLeft, GitPullRequest, TriangleAlert } from "lucide-react";

import {
  ApiError,
  getPull,
  getRepository,
  getSnapshot,
  listSnapshots,
} from "@/api/client";
import type {
  GraphNode,
  PullDetail,
  Repository,
  Snapshot,
  SnapshotSummary,
} from "@/api/types";
import { formatDate, repoName } from "@/lib/format";
import { cn } from "@/lib/utils";
import { ChangeSummarySidebar } from "@/components/change-summary";
import { ExportMenu } from "@/components/export-menu";
import { FocusToggle, useFocusMode } from "@/components/focus-mode";
import { GraphCanvas } from "@/components/graph-canvas";
import { IamTable } from "@/components/iam-table";
import { SnapshotSelect } from "@/components/snapshot-select";
import { ViewSwitcher, useGraphView } from "@/components/view-switcher";
import { networkProjection } from "@/lib/graph-layout";

type PageState =
  | { status: "loading" }
  | { status: "error"; message: string }
  | {
      status: "ready";
      repo: Repository;
      pull: PullDetail;
      snapshots: SnapshotSummary[];
    };

type GraphState =
  | { status: "idle" }
  | { status: "loading" }
  | { status: "error"; message: string }
  | { status: "ready"; snapshot: Snapshot };

const shortSha = (sha: string) => sha.slice(0, 8);

export function PullDetailPage() {
  const { id, repoId, number } = useParams<{
    id: string;
    repoId: string;
    number: string;
  }>();
  const prNumber = Number(number);

  const [state, setState] = useState<PageState>({ status: "loading" });
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [graph, setGraph] = useState<GraphState>({ status: "idle" });
  // GP-49: a node to select on the canvas, set when jumping from the IAM view.
  const [focusNodeId, setFocusNodeId] = useState<string | null>(null);
  const { focus } = useFocusMode();

  // Network view (GP-44): project the ready snapshot when ?view=network.
  const { view, setView } = useGraphView();
  const network = useMemo(
    () =>
      graph.status === "ready" && view === "network"
        ? networkProjection(graph.snapshot.graph)
        : null,
    [graph, view],
  );

  // GP-49: leave the IAM table for the plan-impact canvas with the node selected.
  const viewInPlanImpact = useCallback(
    (node: GraphNode) => {
      setFocusNodeId(node.id);
      setView("infra");
    },
    [setView],
  );

  const load = useCallback(() => {
    if (!repoId) return;
    setState({ status: "loading" });
    Promise.all([
      getRepository(repoId),
      getPull(repoId, prNumber),
      listSnapshots(repoId, { prNumber }),
    ])
      .then(([repo, pull, snapshots]) => {
        setState({ status: "ready", repo, pull, snapshots });
        setSelectedId(pull.latestSnapshot?.id ?? snapshots[0]?.id ?? null);
      })
      .catch((err) =>
        setState({
          status: "error",
          message:
            err instanceof ApiError ? err.message : "Could not load the pull request.",
        }),
      );
  }, [repoId, prNumber]);

  useEffect(() => {
    load();
  }, [load]);

  useEffect(() => {
    if (!selectedId) {
      setGraph({ status: "idle" });
      return;
    }
    let cancelled = false;
    setGraph({ status: "loading" });
    getSnapshot(selectedId)
      .then((snapshot) => {
        if (!cancelled) setGraph({ status: "ready", snapshot });
      })
      .catch((err) => {
        if (!cancelled)
          setGraph({
            status: "error",
            message:
              err instanceof ApiError ? err.message : "Could not load the diagram.",
          });
      });
    return () => {
      cancelled = true;
    };
  }, [selectedId]);

  if (state.status === "loading") {
    return <CenteredNote>Loading pull request…</CenteredNote>;
  }
  if (state.status === "error") {
    return (
      <CenteredNote>
        <ErrorBlock message={state.message} onRetry={load} />
      </CenteredNote>
    );
  }

  const { repo, pull, snapshots } = state;

  return (
    <div className="blueprint-grid flex h-full flex-col">
      {!focus && (
        <header className="bg-card border-b border-border px-8 py-3.5">
          <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
            <div className="min-w-0">
              <p className="text-muted-foreground flex items-center gap-2 font-mono text-[11px] tracking-[0.14em] uppercase">
                <Link
                  to={`/projects/${id}/repos/${repoId}/pulls`}
                  className="hover:text-foreground inline-flex items-center gap-0.5"
                >
                  <ChevronLeft className="size-3.5" />
                  All pull requests
                </Link>
              </p>
              <div className="mt-0.5 flex items-center gap-2">
                <GitPullRequest
                  className={cn(
                    "size-4 shrink-0",
                    pull.state === "open"
                      ? "text-emerald-600"
                      : "text-muted-foreground",
                  )}
                />
                <h1 className="font-display truncate text-xl font-semibold">
                  {pull.title ?? `Pull request #${pull.number}`}
                </h1>
                <span className="text-muted-foreground truncate font-mono text-xs">
                  #{pull.number} · {pull.sourceRef} → {repo.defaultBranch} ·{" "}
                  {shortSha(pull.latestCommitSha)}
                  {graph.status === "ready" &&
                    ` · ${formatDate(graph.snapshot.createdAt)}`}
                </span>
              </div>
            </div>
            <div className="flex items-center gap-2">
              {graph.status === "ready" && (
                <ExportMenu
                  snapshotId={graph.snapshot.id}
                  filenameBase={`${repoName(repo.url).replaceAll("/", "-")}-${shortSha(graph.snapshot.commitSha)}`}
                  includeChangesScope
                />
              )}
            </div>
          </div>
        </header>
      )}

      {(graph.status === "ready" || snapshots.length > 1) && (
        <div className="bg-card border-border flex items-center justify-between gap-4 border-b px-8 py-2.5">
          <div className="flex items-center gap-3">
            {graph.status === "ready" && <ViewSwitcher variant="plan" />}
          </div>
          <div className="flex items-center gap-4">
            {snapshots.length > 1 && (
              <SnapshotSelect
                snapshots={snapshots}
                selectedIds={selectedId ? [selectedId] : []}
                visible={snapshots.length}
                compareMode={false}
                onSelect={(sid) => setSelectedId(sid)}
                onShowMore={() => {}}
              />
            )}
            <FocusToggle />
          </div>
        </div>
      )}

      <div className="flex min-h-0 flex-1">
        <div className="relative min-h-0 flex-1">
          {!pull.latestSnapshot && graph.status !== "ready" ? (
            <NoSnapshot parseError={pull.parseError} />
          ) : graph.status === "error" ? (
            <CenteredNote>
              <ErrorBlock message={graph.message} onRetry={load} />
            </CenteredNote>
          ) : graph.status === "ready" ? (
            view === "iam" ? (
              <IamTable
                graph={graph.snapshot.graph}
                variant="plan"
                onViewInPlanImpact={viewInPlanImpact}
              />
            ) : (
              <GraphCanvas
                graph={network ? network.graph : graph.snapshot.graph}
                variant="plan"
                containerIds={network?.containerIds}
                focusNodeId={focusNodeId}
              />
            )
          ) : (
            <CenteredNote>Loading diagram…</CenteredNote>
          )}
        </div>
        {/* GP-36: deterministic change summary, docked as a right rail. */}
        {graph.status === "ready" && !focus && (
          <ChangeSummarySidebar
            markdown={graph.snapshot.summaryMd}
            prNumber={pull.number}
          />
        )}
      </div>
    </div>
  );
}

function NoSnapshot({ parseError }: { parseError: string | null }) {
  return (
    <div className="grid h-full place-items-center p-8">
      <div className="max-w-md text-center">
        <div className="bg-accent text-primary mx-auto mb-4 grid size-12 place-items-center rounded-sm">
          <GitPullRequest className="size-6" />
        </div>
        <h2 className="font-display text-lg font-semibold">No diagram yet</h2>
        {parseError ? (
          <div
            role="alert"
            className="border-destructive/30 bg-destructive/5 mt-3 rounded-md border px-4 py-3 text-left"
          >
            <p className="text-destructive text-sm font-medium">
              The latest plan could not be parsed.
            </p>
            <p className="text-muted-foreground mt-1 font-mono text-xs break-all">
              {parseError}
            </p>
          </div>
        ) : (
          <p className="text-muted-foreground mt-2 text-sm">
            Waiting for your CI to post a Terraform plan for this pull request.
          </p>
        )}
      </div>
    </div>
  );
}

function CenteredNote({ children }: { children: React.ReactNode }) {
  return (
    <div className="text-muted-foreground grid h-full place-items-center p-8 text-sm">
      {children}
    </div>
  );
}

function ErrorBlock({
  message,
  onRetry,
}: {
  message: string;
  onRetry: () => void;
}) {
  return (
    <div
      role="alert"
      className="border-destructive/30 bg-destructive/5 flex max-w-md flex-col items-center gap-4 rounded-md border px-8 py-12 text-center"
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
