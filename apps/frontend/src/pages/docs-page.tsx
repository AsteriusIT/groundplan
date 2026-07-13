import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link, useParams, useSearchParams } from "react-router-dom";
import {
  ChevronLeft,
  Ellipsis,
  FileText,
  GitCompareArrows,
  Loader2,
  RefreshCw,
  Sparkles,
  TriangleAlert,
} from "lucide-react";

import {
  ApiError,
  createAnnotation,
  deleteAnnotation,
  generateDocs,
  getRepository,
  getSnapshot,
  listAnnotations,
  listSnapshots,
  updateAnnotation,
  updateRepository,
} from "@/api/client";
import type {
  Annotation,
  CreateAnnotationInput,
  GraphNode,
  Repository,
  Snapshot,
  SnapshotSummary,
  UpdateAnnotationInput,
} from "@/api/types";
import { repoName } from "@/lib/format";
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
import { orphanedAnnotations } from "@/lib/annotations";
import { IamTable } from "@/components/iam-table";
import { ViewSwitcher, useGraphView } from "@/components/view-switcher";
import { SnapshotSelect } from "@/components/snapshot-select";
import { useAiStatus } from "@/lib/use-ai-status";
import { networkProjection } from "@/lib/graph-layout";

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

  // Network view (GP-44): project the current snapshot when ?view=network.
  const { view, setView } = useGraphView();
  const network = useMemo(
    () => (current && view === "network" ? networkProjection(current.graph) : null),
    [current, view],
  );
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

  return (
    <div className="blueprint-grid flex h-full flex-col">
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
            {current && !compareMode && <ViewSwitcher variant="docs" />}
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
              {graph.status === "loading" && <Centered>Loading diagram…</Centered>}
              {graph.status === "error" && (
                <Centered>
                  <ErrorBlock message={graph.message} onRetry={() => loadList(false)} />
                </Centered>
              )}
              {current && (
                <>
                  {view === "iam" ? (
                    <IamTable
                      graph={current.graph}
                      variant="docs"
                      onViewInPlanImpact={viewInPlanImpact}
                    />
                  ) : (
                    <GraphCanvas
                      graph={network ? network.graph : current.graph}
                      variant="docs"
                      containerIds={network?.containerIds}
                      focusNodeId={focusNodeId}
                      annotations={view === "infra" ? annotations : undefined}
                      annotate={annotate && view === "infra"}
                      onCreateAnnotation={handleCreateAnnotation}
                      onUpdateAnnotation={handleUpdateAnnotation}
                      onDeleteAnnotation={handleDeleteAnnotation}
                    />
                  )}
                </>
              )}
            </>
          )}
        </div>

        {/* GP-65. Keyed on the snapshot: each point in the timeline keeps its own
            explanation, so stepping back through history shows what *that*
            snapshot was, not the newest one's prose. */}
        {current && explainOpen && !focus && (
          <aside className="border-border bg-card w-80 shrink-0 overflow-y-auto border-l px-4 py-4">
            <AiPanel
              snapshotId={current.id}
              kind="docs_explain"
              title="Explain this infrastructure"
              cta="Explain this infrastructure"
            />
          </aside>
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

/**
 * What went wrong while parsing this snapshot — a file we could not read, or a
 * terraform path that matched nothing.
 *
 * A banner in the page flow, above the canvas. It used to be an absolutely
 * positioned box in the canvas's top-left corner, which is where the filter
 * panel also lives: the panel paints later and covered it, so the one warning
 * that explains an empty diagram ("no .tf files found in 'infra'") was hidden
 * behind "0 of 0 shown".
 */
function WarningsNotice({ warnings }: { warnings: string[] }) {
  const [expanded, setExpanded] = useState(false);
  if (warnings.length === 0) return null;

  // One warning IS the message. Hiding it behind a "1 file skipped" summary made
  // the reader click to learn what happened — and lied when it wasn't a file.
  const only = warnings.length === 1 ? warnings[0] : null;

  return (
    <div
      role="status"
      className="border-warning/40 bg-warning-soft text-warning flex items-start gap-2 border-b px-4 py-2 text-xs"
    >
      <TriangleAlert className="mt-0.5 size-4 shrink-0" />
      {only ? (
        <span className="font-mono break-all">{only}</span>
      ) : (
        <div className="min-w-0 flex-1">
          <button
            type="button"
            aria-expanded={expanded}
            onClick={() => setExpanded((v) => !v)}
            className="underline underline-offset-2"
          >
            {warnings.length} warnings while parsing this snapshot
          </button>
          {expanded && (
            <ul className="mt-1 space-y-0.5 font-mono">
              {warnings.map((warning) => (
                <li key={warning} className="break-all">
                  {warning}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
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
