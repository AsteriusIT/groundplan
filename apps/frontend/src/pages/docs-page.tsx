import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link, useParams, useSearchParams } from "react-router-dom";
import {
  ChevronLeft,
  FileText,
  GitCompareArrows,
  Loader2,
  RefreshCw,
  TriangleAlert,
} from "lucide-react";

import {
  ApiError,
  generateDocs,
  getRepository,
  getSnapshot,
  listSnapshots,
} from "@/api/client";
import type { Repository, Snapshot, SnapshotSummary } from "@/api/types";
import { formatDate, repoName } from "@/lib/format";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { CompareView } from "@/components/compare-view";
import { ExportMenu } from "@/components/export-menu";
import { ShareDialog } from "@/components/share-dialog";
import { GraphCanvas } from "@/components/graph-canvas";
import { ViewSwitcher, useGraphView } from "@/components/view-switcher";
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

  // Network view (GP-44): project the current snapshot when ?view=network.
  const { view } = useGraphView();
  const network = useMemo(
    () => (current && view === "network" ? networkProjection(current.graph) : null),
    [current, view],
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
    <div className="flex h-full flex-col">
      <header className="bg-card border-b border-border px-8 py-5">
        <Link
          to={`/projects/${id}`}
          className="text-muted-foreground hover:text-foreground mb-3 inline-flex items-center gap-1 text-sm"
        >
          <ChevronLeft className="size-4" />
          Back to project
        </Link>
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div className="min-w-0">
            <p className="text-muted-foreground font-mono text-[11px] tracking-[0.14em] uppercase">
              Documentation · {repo?.defaultBranch ?? "main"}
            </p>
            <h1 className="font-display text-xl font-semibold">
              {repo ? repoName(repo.url) : "Documentation"}
            </h1>
          </div>
          {snapshots.length > 0 && (
            <div className="flex items-center gap-2">
              {current && !compareMode && <ViewSwitcher />}
              {network && network.hiddenCount > 0 && (
                <span className="text-muted-foreground bg-muted rounded-full px-2 py-0.5 font-mono text-[11px]">
                  {network.hiddenCount} resource{network.hiddenCount === 1 ? "" : "s"} not in
                  network view
                </span>
              )}
              {canCompare && (
                <Button
                  variant={compareMode ? "default" : "outline"}
                  onClick={compareMode ? exitCompare : () => setCompareMode(true)}
                >
                  <GitCompareArrows className="size-4" />
                  {compareMode ? "Exit compare" : "Compare"}
                </Button>
              )}
              {repoId && (
                <ShareDialog repositoryId={repoId} currentSnapshotId={selectedId} />
              )}
              {current && (
                <ExportMenu
                  snapshotId={current.id}
                  filenameBase={`${(repo ? repoName(repo.url) : "diagram").replaceAll("/", "-")}-${shortSha(current.commitSha)}`}
                />
              )}
              <Button variant="outline" onClick={generate} disabled={generating}>
                <RefreshCw className={generating ? "size-4 animate-spin" : "size-4"} />
                {generating ? "Regenerating…" : "Regenerate"}
              </Button>
            </div>
          )}
        </div>
        {genError && (
          <p className="text-destructive mt-3 text-sm" role="alert">
            {genError}
          </p>
        )}
      </header>

      {snapshots.length > 0 && (
        <Timeline
          snapshots={snapshots}
          selectedIds={timelineSelected}
          visible={visible}
          onSelect={handleCardClick}
          onShowMore={() => setVisible((v) => v + PAGE)}
        />
      )}

      <div className="blueprint-grid relative min-h-0 flex-1">
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
            {compareMode && (
              <div
                role="status"
                className="bg-accent absolute inset-x-0 top-0 z-10 flex items-center justify-center gap-3 border-b border-border px-4 py-2 text-xs"
              >
                Compare mode — pick {2 - compareSel.length} more snapshot
                {2 - compareSel.length === 1 ? "" : "s"} from the timeline.
                <button
                  type="button"
                  onClick={exitCompare}
                  className="font-medium underline underline-offset-2"
                >
                  Cancel
                </button>
              </div>
            )}
            {viewingOld && !compareMode && (
              <div
                role="status"
                className="bg-amber-50 absolute inset-x-0 top-0 z-10 flex items-center justify-center gap-3 border-b border-amber-300 px-4 py-2 text-xs text-amber-900"
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
            {graph.status === "loading" && <Centered>Loading diagram…</Centered>}
            {graph.status === "error" && (
              <Centered>
                <ErrorBlock message={graph.message} onRetry={() => loadList(false)} />
              </Centered>
            )}
            {current && (
              <>
                {current.stats.warnings && current.stats.warnings.length > 0 && (
                  <WarningsNotice warnings={current.stats.warnings} />
                )}
                <GraphCanvas graph={network ? network.graph : current.graph} variant="docs" />
              </>
            )}
          </>
        )}
      </div>
    </div>
  );
}

function Timeline({
  snapshots,
  selectedIds,
  visible,
  onSelect,
  onShowMore,
}: {
  snapshots: SnapshotSummary[];
  selectedIds: string[];
  visible: number;
  onSelect: (id: string) => void;
  onShowMore: () => void;
}) {
  return (
    <div className="bg-card flex items-stretch gap-2 overflow-x-auto border-b border-border px-8 py-3">
      {snapshots.slice(0, visible).map((snap) => (
        <SnapshotCard
          key={snap.id}
          snapshot={snap}
          selected={selectedIds.includes(snap.id)}
          onSelect={() => onSelect(snap.id)}
        />
      ))}
      {snapshots.length > visible && (
        <button
          type="button"
          onClick={onShowMore}
          className="text-muted-foreground hover:text-foreground shrink-0 self-center px-2 text-xs"
        >
          Show more
        </button>
      )}
    </div>
  );
}

function SnapshotCard({
  snapshot,
  selected,
  onSelect,
}: {
  snapshot: SnapshotSummary;
  selected: boolean;
  onSelect: () => void;
}) {
  const trigger = snapshot.stats.trigger ?? "manual";
  return (
    <button
      type="button"
      onClick={onSelect}
      aria-current={selected ? "true" : undefined}
      className={cn(
        "flex w-40 shrink-0 flex-col rounded-md border px-3 py-2 text-left transition-colors",
        selected
          ? "border-primary bg-accent"
          : "border-border hover:border-primary/50",
      )}
    >
      <div className="flex items-center justify-between gap-2">
        <span className="font-mono text-xs font-medium">
          {shortSha(snapshot.commitSha)}
        </span>
        <span
          className={cn(
            "rounded-xs px-1.5 py-0.5 font-mono text-[9px] uppercase",
            trigger === "auto"
              ? "bg-primary/10 text-primary"
              : "bg-muted text-muted-foreground",
          )}
        >
          {trigger}
        </span>
      </div>
      <span className="text-muted-foreground mt-1 font-mono text-[10px]">
        {formatDate(snapshot.createdAt)}
      </span>
    </button>
  );
}

function WarningsNotice({ warnings }: { warnings: string[] }) {
  return (
    <details className="bg-card/90 absolute top-12 left-3 z-10 max-w-sm rounded-md border border-amber-300 backdrop-blur">
      <summary className="flex cursor-pointer items-center gap-2 px-3 py-2 text-sm text-amber-800">
        <TriangleAlert className="size-4" />
        {warnings.length} file{warnings.length === 1 ? "" : "s"} skipped
      </summary>
      <ul className="border-t border-amber-200 px-3 py-2 font-mono text-xs">
        {warnings.map((warning) => (
          <li key={warning} className="text-muted-foreground break-all">
            {warning}
          </li>
        ))}
      </ul>
    </details>
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
