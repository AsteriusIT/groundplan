/**
 * Docs snapshot compare (GP-40): render the diff between two docs snapshots.
 * Fetches the target (newer) graph + the diff, recolours into a compare graph
 * (added green / removed red ghosts / rest neutral) and hands it to the existing
 * canvas. A summary strip above shows the counts and collapsible add/remove
 * lists; clicking an added resource flies to it.
 */
import { useEffect, useState } from "react";
import { ArrowRight, Loader2, TriangleAlert, X } from "lucide-react";

import { ApiError, diffSnapshots, getSnapshot } from "@/api/client";
import type { Graph, SnapshotDiff } from "@/api/types";
import { formatDate } from "@/lib/format";
import { buildCompareGraph, diffIsEmpty } from "@/lib/snapshot-diff";
import { cn } from "@/lib/utils";
import { GraphCanvas } from "@/components/graph-canvas";

type State =
  | { status: "loading" }
  | { status: "error"; message: string }
  | { status: "ready"; diff: SnapshotDiff; graph: Graph };

const shortSha = (sha: string) => sha.slice(0, 8);

export function CompareView({
  baseId,
  targetId,
  onExit,
}: {
  /** The older snapshot (base). */
  baseId: string;
  /** The newer snapshot (target) — its layout is rendered. */
  targetId: string;
  onExit: () => void;
}) {
  const [state, setState] = useState<State>({ status: "loading" });
  const [focusId, setFocusId] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setState({ status: "loading" });
    Promise.all([getSnapshot(targetId), diffSnapshots(baseId, targetId)])
      .then(([target, diff]) => {
        if (!cancelled) {
          setState({ status: "ready", diff, graph: buildCompareGraph(target.graph, diff) });
        }
      })
      .catch((err) => {
        if (!cancelled) {
          setState({
            status: "error",
            message: err instanceof ApiError ? err.message : "Could not compare the snapshots.",
          });
        }
      });
    return () => {
      cancelled = true;
    };
  }, [baseId, targetId]);

  return (
    <div className="absolute inset-0 flex flex-col">
      {state.status === "ready" && (
        <CompareSummary diff={state.diff} onFocus={setFocusId} onExit={onExit} />
      )}

      <div className="relative min-h-0 flex-1">
        {state.status === "loading" && (
          <div className="text-muted-foreground grid h-full place-items-center text-sm">
            <span className="inline-flex items-center gap-2">
              <Loader2 className="size-4 animate-spin" /> Comparing snapshots…
            </span>
          </div>
        )}
        {state.status === "error" && (
          <div className="grid h-full place-items-center p-8">
            <div
              role="alert"
              className="border-destructive/30 bg-destructive/5 flex max-w-md flex-col items-center gap-3 rounded-md border px-8 py-10 text-center"
            >
              <TriangleAlert className="text-destructive size-8" />
              <p className="text-muted-foreground text-sm">{state.message}</p>
              <button type="button" onClick={onExit} className="text-primary text-sm hover:underline">
                Exit compare
              </button>
            </div>
          </div>
        )}
        {state.status === "ready" && (
          <GraphCanvas graph={state.graph} variant="plan" focusNodeId={focusId} />
        )}
      </div>
    </div>
  );
}

function CompareSummary({
  diff,
  onFocus,
  onExit,
}: {
  diff: SnapshotDiff;
  onFocus: (id: string) => void;
  onExit: () => void;
}) {
  const empty = diffIsEmpty(diff);
  return (
    <div className="bg-card z-10 border-b border-border px-6 py-3">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        {empty ? (
          <span className="text-muted-foreground text-sm">No differences between these snapshots.</span>
        ) : (
          <>
            <span className="text-create inline-flex items-center gap-1 font-mono text-sm font-medium">
              +{diff.added.length} added
            </span>
            <span className="text-delete inline-flex items-center gap-1 font-mono text-sm font-medium">
              −{diff.removed.length} removed
            </span>
            {diff.moved.length > 0 && (
              <span className="text-muted-foreground font-mono text-sm">
                ~{diff.moved.length} moved
              </span>
            )}
          </>
        )}
        <span className="text-muted-foreground inline-flex items-center gap-1.5 font-mono text-xs">
          {shortSha(diff.base.commitSha)} ({formatDate(diff.base.createdAt)})
          <ArrowRight className="size-3" />
          {shortSha(diff.target.commitSha)} ({formatDate(diff.target.createdAt)})
        </span>
        <button
          type="button"
          onClick={onExit}
          className="text-muted-foreground hover:text-foreground ml-auto inline-flex items-center gap-1 text-xs"
        >
          <X className="size-3.5" />
          Exit compare
        </button>
      </div>

      {!empty && (
        <div className="mt-2 flex flex-wrap gap-4">
          {diff.added.length > 0 && (
            <DiffList title="Added" tone="create">
              {diff.added.map((n) => (
                <li key={n.id}>
                  <button
                    type="button"
                    onClick={() => onFocus(n.id)}
                    className="hover:text-foreground text-muted-foreground truncate text-left font-mono text-[11px]"
                  >
                    {n.id}
                  </button>
                </li>
              ))}
            </DiffList>
          )}
          {diff.removed.length > 0 && (
            <DiffList title="Removed" tone="delete">
              {diff.removed.map((n) => (
                <li key={n.id} className="text-muted-foreground truncate font-mono text-[11px]">
                  {n.id}
                </li>
              ))}
            </DiffList>
          )}
        </div>
      )}
    </div>
  );
}

function DiffList({
  title,
  tone,
  children,
}: {
  title: string;
  tone: "create" | "delete";
  children: React.ReactNode;
}) {
  return (
    <details className="min-w-40">
      <summary
        className={cn(
          "cursor-pointer font-mono text-[11px] font-medium uppercase",
          tone === "create" ? "text-create" : "text-delete",
        )}
      >
        {title}
      </summary>
      <ul className="mt-1 max-h-40 space-y-0.5 overflow-auto pr-2">{children}</ul>
    </details>
  );
}
