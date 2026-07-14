import { useCallback, useEffect, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { Boxes, ChevronLeft, Loader2, RefreshCw, TriangleAlert } from "lucide-react";

import {
  ApiError,
  generateNamespaceSnapshot,
  getCluster,
  getSnapshot,
  listClusterNamespaces,
  listNamespaceSnapshots,
} from "@/api/client";
import type { Cluster, Snapshot, SnapshotSummary } from "@/api/types";
import { Button } from "@/components/ui/button";
import { GraphCanvas } from "@/components/graph-canvas";
import { SnapshotSelect } from "@/components/snapshot-select";
import { WarningsNotice } from "@/components/warnings-notice";

type NamespaceState =
  | { status: "loading" }
  | { status: "error"; message: string }
  | { status: "ready"; namespaces: string[] };

type GraphState =
  | { status: "idle" }
  | { status: "loading" }
  | { status: "error"; message: string }
  | { status: "ready"; snapshot: Snapshot };

const PAGE = 10;

/**
 * The Kubernetes view (GP-99): pick a namespace on an attached cluster, read it,
 * and look at it on the same canvas as everything else — because it *is* the same
 * canvas. The namespace arrives as the container the way a VNET does, the kinds
 * resolve to their icons (GP-93), and the renderer knows nothing about Kubernetes.
 *
 * Two things this page does NOT have, and both are deliberate:
 *
 *   - **No view switcher.** `network`, `iam`, `adapted` and `c4` are lenses on
 *     Terraform semantics; drawn over a namespace read they would be empty, and an
 *     empty lens is worse than a missing one. A `?view=` in the URL is simply not
 *     read here, so a deep link from a Terraform diagram lands on the diagram.
 *   - **No auto-generate.** Reading a namespace reaches into somebody's live
 *     cluster. It happens when a person asks for it, not when a page mounts.
 */
export function ClusterPage() {
  // `/clusters/:id` — the cluster stands alone, so its id is the only one here.
  const { id: clusterId } = useParams<{ id: string }>();
  const [cluster, setCluster] = useState<Cluster | null>(null);
  const [namespaces, setNamespaces] = useState<NamespaceState>({ status: "loading" });
  const [selectedNs, setSelectedNs] = useState<string>("");

  const [snapshots, setSnapshots] = useState<SnapshotSummary[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [graph, setGraph] = useState<GraphState>({ status: "idle" });
  const [visible, setVisible] = useState(PAGE);

  const [generating, setGenerating] = useState(false);
  const [busy, setBusy] = useState(false);
  const [genError, setGenError] = useState<string | null>(null);

  useEffect(() => {
    if (!clusterId) return;
    getCluster(clusterId).then(setCluster).catch(() => {});

    setNamespaces({ status: "loading" });
    listClusterNamespaces(clusterId)
      .then((names) => {
        setNamespaces({ status: "ready", namespaces: names });
        // Pre-select the first namespace so the page has something to talk about;
        // it still reads nothing until somebody presses Generate.
        setSelectedNs((current) => current || (names[0] ?? ""));
      })
      .catch((err) =>
        setNamespaces({
          status: "error",
          message:
            err instanceof ApiError
              ? err.message
              : "Could not reach the cluster to list its namespaces.",
        }),
      );
  }, [clusterId]);

  /** The chosen namespace's history. Newest first; newest selected. */
  const loadHistory = useCallback(
    (namespace: string, selectNewest = true) => {
      if (!clusterId || !namespace) return;
      listNamespaceSnapshots(clusterId, namespace)
        .then((rows) => {
          setSnapshots(rows);
          if (selectNewest) setSelectedId(rows[0]?.id ?? null);
        })
        .catch(() => {
          setSnapshots([]);
          setSelectedId(null);
        });
    },
    [clusterId],
  );

  // Changing namespace is changing subject: the previous namespace's history,
  // diagram and last outcome say nothing about this one.
  useEffect(() => {
    setSnapshots([]);
    setSelectedId(null);
    setGraph({ status: "idle" });
    setGenError(null);
    setBusy(false);
    loadHistory(selectedNs);
  }, [selectedNs, loadHistory]);

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
        if (!cancelled) {
          setGraph({
            status: "error",
            message:
              err instanceof ApiError ? err.message : "Could not load the diagram.",
          });
        }
      });
    return () => {
      cancelled = true;
    };
  }, [selectedId]);

  const generate = useCallback(async () => {
    if (!clusterId || !selectedNs) return;
    setGenerating(true);
    setGenError(null);
    setBusy(false);
    try {
      const snapshot = await generateNamespaceSnapshot(clusterId, selectedNs);
      setSelectedId(snapshot.id);
      setGraph({ status: "ready", snapshot });
      loadHistory(selectedNs, false);
    } catch (err) {
      // 409 is not a failure: somebody (or another tab) is already reading this
      // namespace, and the answer is to wait, not to apologise.
      if (err instanceof ApiError && err.status === 409) setBusy(true);
      else {
        setGenError(
          err instanceof ApiError ? err.message : "Could not read the namespace.",
        );
      }
    } finally {
      setGenerating(false);
    }
  }, [clusterId, selectedNs, loadHistory]);

  const current = graph.status === "ready" ? graph.snapshot : null;
  // Only the namespace container came back: the read worked, there is simply
  // nothing in there that we map.
  const emptyNamespace = current !== null && current.graph.nodes.length <= 1;

  return (
    <div className="blueprint-grid flex h-full flex-col">
      <header className="bg-card border-b border-border px-8 py-3.5">
        <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
          <div className="min-w-0">
            <p className="text-muted-foreground flex items-center gap-2 font-mono text-[11px] tracking-[0.14em] uppercase">
              <Link
                to="/clusters"
                className="hover:text-foreground inline-flex items-center gap-0.5"
              >
                <ChevronLeft className="size-3.5" />
                All clusters
              </Link>
              <span className="text-faint">/</span>
              Kubernetes
            </p>
            <h1 className="font-display truncate text-xl font-semibold">
              {cluster?.name ?? "Cluster"}
            </h1>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <label
              htmlFor="cluster-namespace"
              className="text-muted-foreground font-mono text-xs"
            >
              Namespace
            </label>
            <select
              id="cluster-namespace"
              value={selectedNs}
              onChange={(e) => setSelectedNs(e.target.value)}
              disabled={namespaces.status !== "ready"}
              className="border-border bg-background text-foreground focus-visible:ring-ring rounded-md border px-2 py-1.5 font-mono text-sm focus-visible:ring-2 focus-visible:outline-none"
            >
              {namespaces.status === "ready" ? (
                namespaces.namespaces.map((ns) => (
                  <option key={ns} value={ns}>
                    {ns}
                  </option>
                ))
              ) : (
                <option value="">…</option>
              )}
            </select>

            <Button onClick={generate} disabled={generating || !selectedNs}>
              {generating ? (
                <Loader2 className="size-4 animate-spin" />
              ) : (
                <RefreshCw className="size-4" />
              )}
              {generating ? "Reading…" : "Generate"}
            </Button>

            {snapshots.length > 0 && (
              <SnapshotSelect
                snapshots={snapshots}
                selectedIds={selectedId ? [selectedId] : []}
                visible={visible}
                compareMode={false}
                onSelect={setSelectedId}
                onShowMore={() => setVisible((v) => v + PAGE)}
              />
            )}
          </div>
        </div>

        {genError && (
          <p className="text-destructive mt-2 text-sm" role="alert">
            {genError}
          </p>
        )}
      </header>

      {namespaces.status === "error" && (
        <div
          role="alert"
          className="border-destructive/30 bg-destructive/5 text-destructive flex items-center gap-2 border-b px-4 py-2 text-xs"
        >
          <TriangleAlert className="size-4 shrink-0" />
          {namespaces.message}
        </div>
      )}

      {busy && (
        <div
          role="status"
          className="bg-accent border-border flex items-center justify-center gap-3 border-b px-4 py-2 text-xs"
        >
          This namespace is already being read — the diagram will be ready in a
          moment.
        </div>
      )}

      {current && (
        <WarningsNotice warnings={current.stats.warnings ?? []} dismissible />
      )}

      <div className="min-h-0 flex-1">
        {graph.status === "loading" && <Centered>Loading diagram…</Centered>}

        {graph.status === "error" && (
          <Centered>
            <span className="text-destructive">{graph.message}</span>
          </Centered>
        )}

        {graph.status === "idle" && namespaces.status !== "error" && (
          <EmptyState
            namespace={selectedNs}
            generating={generating}
            onGenerate={generate}
          />
        )}

        {emptyNamespace && <NothingToDraw namespace={selectedNs} />}

        {current && !emptyNamespace && (
          <GraphCanvas graph={current.graph} variant="docs" />
        )}
      </div>
    </div>
  );
}

/**
 * The namespace read fine — there is just nothing in it we draw. Say that, rather
 * than showing a canvas holding one lonely container and letting the reader
 * wonder what broke.
 */
function NothingToDraw({ namespace }: { namespace: string }) {
  return (
    <div className="grid h-full place-items-center p-8">
      <div className="max-w-md text-center">
        <div className="bg-accent text-primary mx-auto mb-4 grid size-12 place-items-center rounded-sm">
          <Boxes className="size-6" />
        </div>
        <h2 className="font-display text-lg font-semibold">
          Nothing mappable in this namespace
        </h2>
        <p className="text-muted-foreground mt-2 text-sm">
          We read{" "}
          <span className="text-foreground font-mono">{namespace || "it"}</span> and
          found no workloads, services or config to draw. Pick another namespace, or
          check the kubeconfig's role can list resources here.
        </p>
      </div>
    </div>
  );
}

function EmptyState({
  namespace,
  generating,
  onGenerate,
}: {
  namespace: string;
  generating: boolean;
  onGenerate: () => void;
}) {
  return (
    <div className="grid h-full place-items-center p-8">
      <div className="max-w-md text-center">
        <div className="bg-accent text-primary mx-auto mb-4 grid size-12 place-items-center rounded-sm">
          <Boxes className="size-6" />
        </div>
        <h2 className="font-display text-lg font-semibold">Draw this namespace</h2>
        <p className="text-muted-foreground mt-2 text-sm">
          Groundplan lists the resources in{" "}
          <span className="text-foreground font-mono">{namespace || "a namespace"}</span>{" "}
          — workloads, services, ingresses, config — and draws what depends on what.
          Read-only: we never write to your cluster.
        </p>
        <Button className="mt-5" onClick={onGenerate} disabled={generating || !namespace}>
          {generating ? (
            <Loader2 className="size-4 animate-spin" />
          ) : (
            <RefreshCw className="size-4" />
          )}
          {generating ? "Reading…" : "Generate diagram"}
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
