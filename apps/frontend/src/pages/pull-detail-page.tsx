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
import { isKubernetesSource } from "@/api/types";
import { formatDate, repoName } from "@/lib/format";
import { cn } from "@/lib/utils";
import { AiPanel } from "@/components/ai-panel";
import { ChangeSummarySidebar } from "@/components/change-summary";
import { ExportMenu } from "@/components/export-menu";
import { FocusToggle, useFocusMode } from "@/components/focus-mode";
import { GraphCanvas } from "@/components/graph-canvas";
import { IamTable } from "@/components/iam-table";
import { SnapshotSelect } from "@/components/snapshot-select";
import { TourLauncher } from "@/components/tour-launcher";
import { TourRail } from "@/components/tour-rail";
import { ViewSwitcher, useGraphView, viewsFor } from "@/components/view-switcher";
import { WarningsNotice } from "@/components/warnings-notice";
import { networkProjection } from "@/lib/graph-layout";
import { useTourStyle } from "@/tour/tour-style";
import { useTourPlayer } from "@/tour/use-tour";

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

  // What this pull request is a review *of* decides which lenses it can be seen
  // through, and whether the AI layer has anything grounded to say about it
  // (GP-105): a Kubernetes snapshot gets the diagram, and only the diagram.
  const kubernetes =
    graph.status === "ready" && isKubernetesSource(graph.snapshot.source);

  // Network view (GP-44): project the ready snapshot when ?view=network.
  const { view, setView } = useGraphView(viewsFor("plan", kubernetes));
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

  // GP-79: the guided tour of this change. The player owns which stop we are on;
  // the preference owns what a stop looks like.
  const snapshotId = graph.status === "ready" ? graph.snapshot.id : "";
  const player = useTourPlayer(snapshotId, { view, setView });
  const { style: tourStyle } = useTourStyle();
  const tourChrome =
    player.step === null
      ? null
      : {
          step: player.step,
          index: player.index,
          total: player.total,
          model: player.model,
          chrome: tourStyle,
          onNext: player.next,
          onPrev: player.prev,
          onExit: player.exit,
        };

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

  // The canvas render decision, lifted out of the JSX so it reads as one
  // if/else chain instead of a stack of nested ternaries.
  let canvasContent: React.ReactNode;
  if (!pull.latestSnapshot && graph.status !== "ready") {
    canvasContent = <NoSnapshot parseError={pull.parseError} />;
  } else if (graph.status === "error") {
    canvasContent = (
      <CenteredNote>
        <ErrorBlock message={graph.message} onRetry={load} />
      </CenteredNote>
    );
  } else if (graph.status === "ready") {
    canvasContent =
      view === "iam" ? (
        <IamTable
          graph={graph.snapshot.graph}
          variant="plan"
          onViewInPlanImpact={viewInPlanImpact}
        />
      ) : (
        <GraphCanvas
          // Each view keeps its own camera (GP-156): a fresh instance per
          // lens fits itself once, then refreshes preserve the viewport.
          key={view}
          graph={network ? network.graph : graph.snapshot.graph}
          variant="plan"
          // The PR view is the DIFF ref: the change set dominates, the
          // unchanged estate recedes (GP-155).
          diffEmphasis
          containerIds={network?.containerIds}
          stacks={network?.stacks}
          chips={network?.chips}
          focusNodeId={focusNodeId}
          tour={tourChrome}
        />
      );
  } else {
    canvasContent = <CenteredNote>Loading diagram…</CenteredNote>;
  }

  // The gridded paper is the diagram's surface — the IAM view is a table, and a
  // table on drafting paper is just a table that is harder to read.
  return (
    <div className={cn("flex h-full flex-col", view !== "iam" && "blueprint-grid")}>
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
              {/* GP-79. Leads the header, as it does on the docs page: on a change
                  you have not read yet, this is the thing to press. */}
              {graph.status === "ready" && !kubernetes && (
                <TourLauncher player={player} />
              )}
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
            {/* A tour is written against one lens and plays on it. Switching views
                mid-tour would strand the camera on a diagram the narration is not
                about, so the switcher steps aside while one runs. */}
            {graph.status === "ready" && player.status !== "playing" && (
              <ViewSwitcher variant="plan" kubernetes={kubernetes} />
            )}
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

      {graph.status === "ready" && (
        <WarningsNotice
          warnings={graph.snapshot.stats.warnings ?? []}
          unresolvedReferences={graph.snapshot.stats.unresolvedReferences ?? []}
        />
      )}

      <div className="flex min-h-0 flex-1">
        <div className="relative min-h-0 flex-1">
          {canvasContent}
        </div>

        {/* While a tour runs in guide style, it *is* the rail. The AI summary and
            the change summary are not lost — they are what the rail goes back to
            the moment the tour ends. Two stacked narrations of the same change,
            competing for the same column, would be one too many. */}
        {player.tour && player.status === "playing" && tourStyle === "guide" && !focus ? (
          <TourRail
            tour={player.tour}
            index={player.index}
            model={player.model}
            onGoTo={player.goTo}
            onNext={player.next}
            onPrev={player.prev}
            onExit={player.exit}
          />
        ) : (
          /* GP-36 deterministic change summary, docked as a right rail — with the
             GP-64 AI summary above it (and nothing there when AI is off). */
          graph.status === "ready" &&
          !focus && (
            <ChangeSummarySidebar
              markdown={graph.snapshot.summaryMd}
              prNumber={pull.number}
              above={
                // The AI layer is grounded in Terraform snapshots and their
                // repository context (GP-62..GP-65); it has nothing to say about a
                // Kubernetes one yet, and the deterministic summary below stands on
                // its own — as it is meant to.
                kubernetes ? undefined : (
                  <AiPanel
                    snapshotId={graph.snapshot.id}
                    kind="pr_summary"
                    title="AI summary"
                    cta="Generate AI summary"
                  />
                )
              }
            />
          )
        )}
      </div>
    </div>
  );
}

function NoSnapshot({ parseError }: Readonly<{ parseError: string | null }>) {
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

function CenteredNote({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <div className="text-muted-foreground grid h-full place-items-center p-8 text-sm">
      {children}
    </div>
  );
}

function ErrorBlock({
  message,
  onRetry,
}: Readonly<{
  message: string;
  onRetry: () => void;
}>) {
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
