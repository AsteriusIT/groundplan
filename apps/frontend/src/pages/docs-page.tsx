import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link, useParams, useSearchParams } from "react-router-dom";
import {
  Boxes,
  ChevronLeft,
  Ellipsis,
  FileText,
  GitCompareArrows,
  Loader2,
  PencilLine,
  RefreshCw,
  Sparkles,
  TriangleAlert,
  Wand2,
} from "lucide-react";

import {
  acceptAnnotation,
  ApiError,
  createAnnotation,
  deleteAnnotation,
  generateDocs,
  getAdaptedSnapshot,
  getRepository,
  getSnapshot,
  listAnnotations,
  listSnapshots,
  proposeAnnotations,
  updateAnnotation,
  updateRepository,
} from "@/api/client";
import type {
  Annotation,
  CreateAnnotationInput,
  Graph,
  GraphNode,
  Repository,
  Snapshot,
  SnapshotSummary,
  UpdateAnnotationInput,
} from "@/api/types";
import { repoName } from "@/lib/format";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { CompareView } from "@/components/compare-view";
import { ExportMenu } from "@/components/export-menu";
import { ShareDialog } from "@/components/share-dialog";
import { GraphCanvas } from "@/components/graph-canvas";
import { AnnotateToggle, useAnnotateMode } from "@/components/annotate-toolbar";
import { AiPanel } from "@/components/ai-panel";
import { ContextRail } from "@/components/context-section";
import { FocusToggle, useFocusMode } from "@/components/focus-mode";
import { OrphanReview } from "@/components/orphan-review";
import { ProposalInbox } from "@/components/proposal-inbox";
import { orphanedAnnotations } from "@/lib/annotations";
import { IamTable } from "@/components/iam-table";
import { ViewSwitcher, useGraphView } from "@/components/view-switcher";
import { WarningsNotice } from "@/components/warnings-notice";
import { SnapshotSelect } from "@/components/snapshot-select";
import { TourLauncher } from "@/components/tour-launcher";
import { TourRail } from "@/components/tour-rail";
import { useAiStatus } from "@/lib/use-ai-status";
import { networkProjection } from "@/lib/graph-layout";
import { useTourStyle } from "@/tour/tour-style";
import { useTourPlayer } from "@/tour/use-tour";

type ListState =
  | { status: "loading" }
  | { status: "empty" }
  | { status: "error"; message: string }
  | { status: "ready"; snapshots: SnapshotSummary[] };

type GraphState =
  | { status: "idle" }
  | { status: "loading" }
  | { status: "error"; message: string }
  | { status: "ready"; snapshot: Snapshot };

const PAGE = 10;
const shortSha = (sha: string) => sha.slice(0, 8);

export function DocsPage() {
  const { id, repoId } = useParams<{ id: string; repoId: string }>();
  const [repo, setRepo] = useState<Repository | null>(null);
  const [list, setList] = useState<ListState>({ status: "loading" });
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [graph, setGraph] = useState<GraphState>({ status: "idle" });
  const [visible, setVisible] = useState(PAGE);
  const [generating, setGenerating] = useState(false);
  const [genError, setGenError] = useState<string | null>(null);

  // Annotation layer (GP-58). Loaded per repo, applied optimistically.
  const [annotations, setAnnotations] = useState<Annotation[]>([]);
  const { annotate } = useAnnotateMode();
  // The snapshot on screen, read (not watched) when stamping a new annotation
  // with the commit it was made against — so the create callback stays stable.
  const graphRef = useRef<Snapshot | null>(null);

  // The repository context (GP-60) rides in a right rail, closed by default —
  // the diagram, not the prose, is what this page is for.
  const [contextOpen, setContextOpen] = useState(false);
  // GP-65: the "Explain this infrastructure" rail.
  const [explainOpen, setExplainOpen] = useState(false);
  const aiStatus = useAiStatus();
  const { focus } = useFocusMode();

  // Compare mode (GP-40): pick two snapshots to diff. Deep-linkable via ?compare.
  const [searchParams, setSearchParams] = useSearchParams();
  const [compareMode, setCompareMode] = useState(false);
  const [compareSel, setCompareSel] = useState<string[]>([]);
  const seededCompare = useRef(false);

  const loadList = useCallback(
    (selectNewest = true) => {
      if (!repoId) return;
      setList({ status: "loading" });
      getRepository(repoId)
        .then(setRepo)
        .catch(() => {});
      listSnapshots(repoId, { source: "hcl" })
        .then((snapshots) => {
          if (snapshots.length === 0) {
            setList({ status: "empty" });
            return;
          }
          setList({ status: "ready", snapshots });
          if (selectNewest) setSelectedId(snapshots[0]!.id);
        })
        .catch((err) =>
          setList({
            status: "error",
            message:
              err instanceof ApiError ? err.message : "Could not load documentation.",
          }),
        );
    },
    [repoId],
  );

  useEffect(() => {
    loadList();
  }, [loadList]);

  const reloadAnnotations = useCallback(() => {
    if (!repoId) return;
    listAnnotations(repoId).then(setAnnotations).catch(() => {});
  }, [repoId]);

  useEffect(() => {
    reloadAnnotations();
  }, [reloadAnnotations]);

  // Optimistic annotation edits (GP-58): apply locally, then reconcile with the
  // server response; on failure, refetch to snap back to the truth.
  //
  // Every annotation records the commit it was made against (GP-71) — so a human
  // meeting an orphan later can see it was drawn on a tree that no longer looks
  // like this, rather than guessing.
  const handleCreateAnnotation = useCallback(
    (input: CreateAnnotationInput) => {
      if (!repoId) return;
      const sha = graphRef.current?.commitSha;
      createAnnotation(repoId, { ...(sha ? { createdFromSha: sha } : {}), ...input })
        .then((created) => setAnnotations((prev) => [created, ...prev]))
        .catch(reloadAnnotations);
    },
    [repoId, reloadAnnotations],
  );

  const handleUpdateAnnotation = useCallback(
    (id: string, input: UpdateAnnotationInput) => {
      setAnnotations((prev) =>
        prev.map((a) => (a.id === id ? { ...a, ...input } : a)),
      );
      updateAnnotation(id, input)
        .then((updated) =>
          setAnnotations((prev) => prev.map((a) => (a.id === id ? updated : a))),
        )
        .catch(reloadAnnotations);
    },
    [reloadAnnotations],
  );

  const handleDeleteAnnotation = useCallback(
    (id: string) => {
      setAnnotations((prev) => prev.filter((a) => a.id !== id));
      deleteAnnotation(id).catch(reloadAnnotations);
    },
    [reloadAnnotations],
  );

  /**
   * The proposal inbox (GP-76). Suggestions arrive as `proposed` annotations and
   * live only here until a human answers them — accepting is what puts one on the
   * diagram, which is why the canvas never draws a proposal (see
   * `renderableAnnotations`).
   */
  const [proposalsOpen, setProposalsOpen] = useState(false);
  const [suggesting, setSuggesting] = useState(false);
  const [suggestError, setSuggestError] = useState<string | null>(null);
  const [emptyRun, setEmptyRun] = useState(false);
  const [previewIds, setPreviewIds] = useState<ReadonlySet<string> | null>(null);

  const proposals = useMemo(
    () => annotations.filter((a) => a.status === "proposed"),
    [annotations],
  );

  const suggest = useCallback(async () => {
    const snapshotId = graphRef.current?.id;
    if (!snapshotId) return;
    setSuggesting(true);
    setSuggestError(null);
    try {
      const run = await proposeAnnotations(snapshotId);
      setEmptyRun(run.proposals.length === 0);
      reloadAnnotations();
    } catch (err) {
      setSuggestError(
        err instanceof ApiError ? err.message : "Could not reach the model.",
      );
    } finally {
      setSuggesting(false);
    }
  }, [reloadAnnotations]);

  const handleAcceptProposal = useCallback(
    (id: string) => {
      // Optimistic: it leaves the inbox at once, and the adapted view refetches
      // because the annotation layer changed.
      setAnnotations((prev) =>
        prev.map((a) => (a.id === id ? { ...a, status: "resolved" as const } : a)),
      );
      acceptAnnotation(id)
        .then((updated) =>
          setAnnotations((prev) => prev.map((a) => (a.id === id ? updated : a))),
        )
        .catch(reloadAnnotations);
    },
    [reloadAnnotations],
  );

  /** Fixing the name and keeping it is one decision, so it is one call path. */
  const handleEditProposal = useCallback(
    (id: string, label: string) => {
      setAnnotations((prev) =>
        prev.map((a) =>
          a.id === id ? { ...a, label, status: "resolved" as const } : a,
        ),
      );
      updateAnnotation(id, { label, status: "resolved" })
        .then((updated) =>
          setAnnotations((prev) => prev.map((a) => (a.id === id ? updated : a))),
        )
        .catch(reloadAnnotations);
    },
    [reloadAnnotations],
  );

  // GP-60: save the repository's long-form context (optimistic).
  const handleSaveContext = useCallback(
    (contextMd: string) => {
      if (!repoId) return;
      setRepo((prev) => (prev ? { ...prev, contextMd } : prev));
      updateRepository(repoId, { contextMd }).then(setRepo).catch(() => {});
    },
    [repoId],
  );

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

  const generate = useCallback(async () => {
    if (!repoId) return;
    setGenerating(true);
    setGenError(null);
    try {
      const { id: newId } = await generateDocs(repoId);
      setSelectedId(newId); // a new latest — jump to it
      loadList(false);
    } catch (err) {
      if (err instanceof ApiError && err.status === 409) {
        setGenError(
          "A documentation run is already in progress — try again in a moment.",
        );
      } else {
        setGenError(
          err instanceof ApiError ? err.message : "Could not generate documentation.",
        );
      }
    } finally {
      setGenerating(false);
    }
  }, [repoId, loadList]);

  const snapshots = list.status === "ready" ? list.snapshots : [];
  const latestId = snapshots[0]?.id ?? null;
  const viewingOld = Boolean(selectedId && latestId && selectedId !== latestId);
  const current = graph.status === "ready" ? graph.snapshot : null;
  graphRef.current = current;

  // Orphaned annotations relative to the displayed snapshot (GP-59): an anchor
  // whose address is no longer a node. Computed client-side so a re-anchor clears
  // it immediately.
  const orphans = useMemo(
    () =>
      current
        ? orphanedAnnotations(
            annotations,
            new Set(current.graph.nodes.map((n) => n.id)),
          )
        : [],
    [annotations, current],
  );

  const { view, setView } = useGraphView();

  // GP-79: the guided tour of this estate. It plays on the lens it was written
  // against — `adapted` when the repo has groups, so the tour can stop at "the
  // storefront" instead of at seven addresses — and the server decides which.
  const player = useTourPlayer(current?.id ?? "", { view, setView });
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
  const touring = player.status === "playing";

  // Network view (GP-44): project the current snapshot when ?view=network.
  const network = useMemo(
    () => (current && view === "network" ? networkProjection(current.graph) : null),
    [current, view],
  );

  /**
   * Adapted / C4 (GP-74/GP-77). Unlike the network view, this projection is not
   * something the client can compute: it is a fold of the *whole* annotation
   * layer, and the server owns it (GP-72). So the toggle refetches — and what
   * comes back is an ordinary snapshot, which the same canvas draws unchanged.
   *
   * `expandedGroup` is the C4 drill-in: click a collapsed group and it opens in
   * place while the others stay closed.
   */
  const [expandedGroup, setExpandedGroup] = useState<string | null>(null);
  const [adapted, setAdapted] = useState<GraphState>({ status: "idle" });
  const [adaptedRetry, setAdaptedRetry] = useState(0);
  const adaptedView = view === "adapted" || view === "c4";

  useEffect(() => {
    if (!selectedId || !adaptedView) {
      setAdapted({ status: "idle" });
      return;
    }
    let cancelled = false;
    setAdapted({ status: "loading" });
    getAdaptedSnapshot(selectedId, {
      ...(view === "c4" ? { granularity: "group" as const } : {}),
      ...(view === "c4" && expandedGroup ? { expandGroup: expandedGroup } : {}),
    })
      .then((snapshot) => {
        if (!cancelled) setAdapted({ status: "ready", snapshot });
      })
      .catch((err) => {
        if (!cancelled)
          setAdapted({
            status: "error",
            message:
              err instanceof ApiError ? err.message : "Could not load the diagram.",
          });
      });
    return () => {
      cancelled = true;
    };
    // Annotations are a dependency: accepting a proposal or hiding a node must
    // change this picture, and the picture lives on the server.
  }, [selectedId, adaptedView, view, expandedGroup, annotations, adaptedRetry]);

  // Leaving C4 forgets which group was open — it is a way of looking, not a
  // setting to carry around.
  useEffect(() => {
    if (view !== "c4") setExpandedGroup(null);
  }, [view]);

  /** The snapshot on the canvas: the adapted projection, or the generated graph. */
  const shown = adaptedView ? (adapted.status === "ready" ? adapted.snapshot : null) : current;
  // GP-49: a node to select on the canvas, set when jumping from the IAM view.
  const [focusNodeId, setFocusNodeId] = useState<string | null>(null);
  const viewInPlanImpact = useCallback(
    (node: GraphNode) => {
      setFocusNodeId(node.id);
      setView("infra");
    },
    [setView],
  );

  // --- Compare mode (GP-40) -------------------------------------------------
  const canCompare = snapshots.length >= 2;
  const compareActive = compareMode && compareSel.length === 2;

  // Order the pair by createdAt: older = base, newer = target.
  const comparePair = (() => {
    if (compareSel.length !== 2) return null;
    const picked = compareSel
      .map((sid) => snapshots.find((s) => s.id === sid))
      .filter((s): s is SnapshotSummary => Boolean(s));
    if (picked.length === 2) {
      const [a, b] = picked as [SnapshotSummary, SnapshotSummary];
      return a.createdAt <= b.createdAt
        ? { baseId: a.id, targetId: b.id }
        : { baseId: b.id, targetId: a.id };
    }
    // Deep link before the list loads: assume URL order is base,target.
    return { baseId: compareSel[0]!, targetId: compareSel[1]! };
  })();

  const toggleCompareSel = useCallback((sid: string) => {
    setCompareSel((prev) => {
      if (prev.includes(sid)) return prev.filter((x) => x !== sid);
      if (prev.length < 2) return [...prev, sid];
      return [prev[1]!, sid]; // keep the two most recently picked
    });
  }, []);

  const exitCompare = useCallback(() => {
    setCompareMode(false);
    setCompareSel([]);
  }, []);

  const handleCardClick = (sid: string) => {
    if (compareMode) toggleCompareSel(sid);
    else setSelectedId(sid);
  };

  // Seed compare state from ?compare=id1,id2 once.
  useEffect(() => {
    if (seededCompare.current) return;
    seededCompare.current = true;
    const ids = (searchParams.get("compare") ?? "").split(",").filter(Boolean).slice(0, 2);
    if (ids.length === 2) {
      setCompareMode(true);
      setCompareSel(ids);
    }
  }, [searchParams]);

  // Keep the ?compare param in sync with the selection.
  useEffect(() => {
    const next = new URLSearchParams(searchParams);
    if (compareMode && compareSel.length === 2) next.set("compare", compareSel.join(","));
    else next.delete("compare");
    if (next.toString() !== searchParams.toString()) {
      setSearchParams(next, { replace: true });
    }
  }, [compareMode, compareSel, searchParams, setSearchParams]);

  const timelineSelected = compareMode
    ? compareSel
    : selectedId
      ? [selectedId]
      : [];

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
                  to={`/projects/${id}`}
                  className="hover:text-foreground inline-flex items-center gap-0.5"
                >
                  <ChevronLeft className="size-3.5" />
                  Back to project
                </Link>
                <span className="text-faint">/</span>
                Documentation · {repo?.defaultBranch ?? "main"}
              </p>
              <h1 className="font-display truncate text-xl font-semibold">
                {repo ? repoName(repo.url) : "Documentation"}
              </h1>
            </div>
            {/* Grouped by intent: what you *do to the diagram* (compare,
                annotate), then what you *take away* (share, export), then the
                panels and the rebuild, which are one-off and belong in a menu.
                Eight equal-weight buttons is eight decisions on every visit. */}
            {snapshots.length > 0 && (
              <div className="flex flex-wrap items-center gap-2">
                {/* GP-79. Leads the "what you do to the diagram" group: a tour is
                    how you meet a system you have never seen, so it comes before
                    the tools for interrogating one you already know. */}
                {current && !compareMode && <TourLauncher player={player} />}
                {canCompare && (
                  <Button
                    variant={compareMode ? "default" : "outline"}
                    onClick={compareMode ? exitCompare : () => setCompareMode(true)}
                  >
                    <GitCompareArrows className="size-4" />
                    {compareMode ? "Exit compare" : "Compare"}
                  </Button>
                )}
                {current && !compareMode && view === "infra" && <AnnotateToggle />}

                <span className="bg-border mx-1 h-5 w-px" aria-hidden="true" />

                {repoId && (
                  <ShareDialog repositoryId={repoId} currentSnapshotId={selectedId} />
                )}
                {current && (
                  <ExportMenu
                    snapshotId={current.id}
                    filenameBase={`${(repo ? repoName(repo.url) : "diagram").replaceAll("/", "-")}-${shortSha(current.commitSha)}`}
                  />
                )}

                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <Button variant="ghost" size="icon" aria-label="More actions">
                      <Ellipsis className="size-4" />
                    </Button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="end" className="w-56">
                    {/* GP-65. Absent entirely when the AI layer is off — not disabled. */}
                    {current && aiStatus?.enabled && (
                      <DropdownMenuCheckboxItem
                        checked={explainOpen}
                        onCheckedChange={(v) => setExplainOpen(Boolean(v))}
                      >
                        <Sparkles className="size-3.5" />
                        Explain
                      </DropdownMenuCheckboxItem>
                    )}
                    {/* GP-76. Same rule: no AI layer, no AI surface. */}
                    {current && aiStatus?.enabled && (
                      <DropdownMenuCheckboxItem
                        checked={proposalsOpen}
                        onCheckedChange={(v) => setProposalsOpen(Boolean(v))}
                      >
                        <Wand2 className="size-3.5" />
                        Suggest annotations
                        {proposals.length > 0 && (
                          <span className="bg-primary text-primary-foreground ml-auto rounded-full px-1.5 text-[10px]">
                            {proposals.length}
                          </span>
                        )}
                      </DropdownMenuCheckboxItem>
                    )}
                    {repo && (
                      <DropdownMenuCheckboxItem
                        checked={contextOpen}
                        onCheckedChange={(v) => setContextOpen(Boolean(v))}
                      >
                        <FileText className="size-3.5" />
                        Context
                      </DropdownMenuCheckboxItem>
                    )}
                    <DropdownMenuSeparator />
                    <DropdownMenuItem onSelect={generate} disabled={generating}>
                      <RefreshCw
                        className={generating ? "size-3.5 animate-spin" : "size-3.5"}
                      />
                      {generating ? "Regenerating…" : "Regenerate"}
                    </DropdownMenuItem>
                  </DropdownMenuContent>
                </DropdownMenu>
              </div>
            )}
          </div>
          {genError && (
            <p className="text-destructive mt-2 text-sm" role="alert">
              {genError}
            </p>
          )}
        </header>
      )}

      {snapshots.length > 0 && (
        <div className="bg-card border-border flex items-center justify-between gap-4 border-b px-8 py-2.5">
          <div className="flex items-center gap-3">
            {/* A tour is written against one lens and plays on it — switching
                mid-tour would strand the camera on a diagram the narration is not
                about. So the switcher steps aside while one runs. */}
            {current && !compareMode && !touring && <ViewSwitcher variant="docs" />}
          </div>
          <div className="flex items-center gap-4">
            <SnapshotSelect
              snapshots={snapshots}
              selectedIds={timelineSelected}
              visible={visible}
              compareMode={compareMode}
              onSelect={handleCardClick}
              onShowMore={() => setVisible((v) => v + PAGE)}
            />
            <FocusToggle />
          </div>
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
          className="bg-warning-soft text-warning border-warning/40 flex items-center justify-center gap-3 border-b px-4 py-2 text-xs"
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

      {current && !compareActive && (
        <WarningsNotice warnings={current.stats.warnings ?? []} />
      )}

      {current && !compareMode && (
        <OrphanReview
          orphans={orphans}
          graph={current.graph}
          onReanchor={(annId, anchors) => handleUpdateAnnotation(annId, { anchors })}
          onDelete={handleDeleteAnnotation}
        />
      )}

      <div className="flex min-h-0 flex-1">
        <div className="relative min-h-0 flex-1">
          {list.status === "loading" && <Centered>Loading documentation…</Centered>}

          {list.status === "error" && (
            <Centered>
              <ErrorBlock message={list.message} onRetry={() => loadList()} />
            </Centered>
          )}

          {list.status === "empty" && (
            <EmptyState generating={generating} onGenerate={generate} />
          )}

          {snapshots.length > 0 && compareActive && comparePair && (
            <CompareView
              baseId={comparePair.baseId}
              targetId={comparePair.targetId}
              onExit={exitCompare}
            />
          )}

          {snapshots.length > 0 && !compareActive && (
            <>
              {(graph.status === "loading" || adapted.status === "loading") && (
                <Centered>Loading diagram…</Centered>
              )}
              {graph.status === "error" && (
                <Centered>
                  <ErrorBlock message={graph.message} onRetry={() => loadList(false)} />
                </Centered>
              )}
              {adapted.status === "error" && (
                <Centered>
                  <ErrorBlock
                    message={adapted.message}
                    onRetry={() => setAdaptedRetry((n) => n + 1)}
                  />
                </Centered>
              )}

              {view === "iam" && current && (
                <IamTable
                  graph={current.graph}
                  variant="docs"
                  onViewInPlanImpact={viewInPlanImpact}
                />
              )}

              {/* C4 with nothing to collapse is not a broken graph — it is a
                  system nobody has grouped yet, and it should say so (GP-77). */}
              {view === "c4" && shown && !hasGroups(shown.graph) && (
                <NoGroupsState onAnnotate={() => setView("infra")} />
              )}

              {view !== "iam" && shown && !(view === "c4" && !hasGroups(shown.graph)) && (
                <GraphCanvas
                  // The adapted projection comes back as an ordinary snapshot, so
                  // the canvas draws it with no idea annotations exist (ADR #2).
                  graph={network ? network.graph : shown.graph}
                  variant="docs"
                  containerIds={network?.containerIds}
                  focusNodeId={focusNodeId}
                  annotations={view === "infra" ? annotations : undefined}
                  annotate={annotate && view === "infra"}
                  onCreateAnnotation={handleCreateAnnotation}
                  onUpdateAnnotation={handleUpdateAnnotation}
                  onDeleteAnnotation={handleDeleteAnnotation}
                  onExpandGroup={
                    view === "c4"
                      ? (id) => setExpandedGroup((open) => (open === id ? null : id))
                      : undefined
                  }
                  highlightIds={previewIds ?? undefined}
                  tour={tourChrome}
                />
              )}
            </>
          )}
        </div>

        {/* GP-79, guide style: the tour takes the rail. It is a narration of this
            snapshot, and so are the panels beside it — three of them stacked in one
            column would be three voices talking over each other. They come back the
            moment the tour ends. */}
        {player.tour && touring && tourStyle === "guide" && !focus && (
          <TourRail
            tour={player.tour}
            index={player.index}
            model={player.model}
            onGoTo={player.goTo}
            onNext={player.next}
            onPrev={player.prev}
            onExit={player.exit}
          />
        )}

        {/* GP-65. Keyed on the snapshot: each point in the timeline keeps its own
            explanation, so stepping back through history shows what *that*
            snapshot was, not the newest one's prose. */}
        {current && explainOpen && !focus && !touring && (
          <aside className="border-border bg-card w-80 shrink-0 overflow-y-auto border-l px-4 py-4">
            <AiPanel
              snapshotId={current.id}
              kind="docs_explain"
              title="Explain this infrastructure"
              cta="Explain this infrastructure"
            />
          </aside>
        )}

        {/* GP-76: suggestions live here and nowhere else until a human answers
            them. Rendered only when the AI layer is on — no key, no AI surface. */}
        {current && proposalsOpen && aiStatus?.enabled && !focus && !touring && (
          <ProposalInbox
            proposals={proposals}
            suggesting={suggesting}
            error={suggestError}
            emptyRun={emptyRun}
            onSuggest={suggest}
            onAccept={handleAcceptProposal}
            onEdit={handleEditProposal}
            onDismiss={handleDeleteAnnotation}
            onPreview={(anchors) =>
              setPreviewIds(anchors ? new Set(anchors) : null)
            }
            onClose={() => setProposalsOpen(false)}
          />
        )}

        {repo && contextOpen && !focus && (
          <ContextRail
            markdown={repo.contextMd}
            onSave={handleSaveContext}
            onClose={() => setContextOpen(false)}
          />
        )}
      </div>
    </div>
  );
}

/** Does this projection contain anything to collapse? (GP-77) */
function hasGroups(graph: Graph): boolean {
  return graph.nodes.some((n) => n.annotation_group);
}

/**
 * C4 with no groups (GP-77). Not an error and not an empty canvas: the view is
 * built out of the groups a human drew, and this repository has none yet. Say
 * that, and point at the thing that fixes it.
 */
function NoGroupsState({ onAnnotate }: { onAnnotate: () => void }) {
  return (
    <div className="grid h-full place-items-center p-8">
      <div className="max-w-md text-center">
        <div className="bg-accent text-primary mx-auto mb-4 grid size-12 place-items-center rounded-sm">
          <Boxes className="size-6" />
        </div>
        <h2 className="font-display text-lg font-semibold">Nothing to collapse yet</h2>
        <p className="text-muted-foreground mt-2 text-sm">
          The C4 view is built from the groups you draw: each top-level group
          becomes one system, and the traffic between them is aggregated into a
          single edge. Group some resources on the Global view — or let the AI
          suggest a grouping — and they will appear here.
        </p>
        <Button className="mt-5" variant="outline" onClick={onAnnotate}>
          <PencilLine className="size-4" />
          Go and group some resources
        </Button>
      </div>
    </div>
  );
}

function EmptyState({
  generating,
  onGenerate,
}: {
  generating: boolean;
  onGenerate: () => void;
}) {
  return (
    <div className="grid h-full place-items-center p-8">
      <div className="max-w-md text-center">
        <div className="bg-accent text-primary mx-auto mb-4 grid size-12 place-items-center rounded-sm">
          <FileText className="size-6" />
        </div>
        <h2 className="font-display text-lg font-semibold">
          Document this repository
        </h2>
        <p className="text-muted-foreground mt-2 text-sm">
          Groundplan clones the default branch and statically parses its Terraform
          into a resource diagram — no plan required.
        </p>
        <Button className="mt-5" onClick={onGenerate} disabled={generating}>
          {generating ? (
            <Loader2 className="size-4 animate-spin" />
          ) : (
            <FileText className="size-4" />
          )}
          {generating ? "Generating…" : "Generate documentation"}
        </Button>
      </div>
    </div>
  );
}

function Centered({ children }: { children: React.ReactNode }) {
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
