import { useCallback, useEffect, useState } from "react";
import { Boxes, Plus, TriangleAlert } from "lucide-react";

import { ApiError, listClusters } from "@/api/client";
import type { Cluster } from "@/api/types";
import { Button } from "@/components/ui/button";
import { AttachClusterDialog } from "@/components/attach-cluster-dialog";
import { ClusterCard } from "@/components/cluster-card";
import { PageHeader } from "@/components/page-header";

type LoadState =
  | { status: "loading" }
  | { status: "error"; message: string }
  | { status: "ready"; clusters: Cluster[] };

/**
 * Clusters — a top-level place, beside Projects rather than inside one.
 *
 * A project is a unit of code review: repositories, their pull requests, their
 * documented main branch. A live cluster is none of that. It has no PR to diff
 * and no commit to document; it is a running thing you read at a moment. Filing
 * it under a project bought nothing and cost a cascade — deleting the project
 * deleted the clusters, and every namespace ever read from them, with it.
 *
 * So: the whole estate, in one list. (There is no per-user ownership model yet;
 * when one lands, the API scopes and this page follows.)
 */
export function ClustersPage() {
  const [state, setState] = useState<LoadState>({ status: "loading" });

  const load = useCallback(() => {
    setState({ status: "loading" });
    listClusters()
      .then((clusters) => setState({ status: "ready", clusters }))
      .catch((err) =>
        setState({
          status: "error",
          message:
            err instanceof ApiError ? err.message : "Could not load clusters.",
        }),
      );
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const handleAttached = useCallback((cluster: Cluster) => {
    setState((prev) =>
      prev.status === "ready"
        ? { status: "ready", clusters: [cluster, ...prev.clusters] }
        : prev,
    );
  }, []);

  const handleChanged = useCallback((updated: Cluster) => {
    setState((prev) =>
      prev.status === "ready"
        ? {
            status: "ready",
            clusters: prev.clusters.map((c) =>
              c.id === updated.id ? updated : c,
            ),
          }
        : prev,
    );
  }, []);

  const handleDeleted = useCallback((id: string) => {
    setState((prev) =>
      prev.status === "ready"
        ? { status: "ready", clusters: prev.clusters.filter((c) => c.id !== id) }
        : prev,
    );
  }, []);

  const hasClusters = state.status === "ready" && state.clusters.length > 0;

  return (
    <div>
      <PageHeader
        eyebrow="Workspace"
        title="Clusters"
        description="Kubernetes clusters you can read live."
        actions={
          hasClusters ? (
            <AttachClusterDialog
              onAttached={handleAttached}
              trigger={
                <Button>
                  <Plus className="size-4" />
                  Attach cluster
                </Button>
              }
            />
          ) : undefined
        }
      />

      <div className="p-8">
        {state.status === "loading" && (
          <p className="text-muted-foreground text-sm" aria-busy="true">
            Loading clusters…
          </p>
        )}

        {state.status === "error" && (
          <ErrorState message={state.message} onRetry={load} />
        )}

        {state.status === "ready" && state.clusters.length === 0 && (
          <EmptyState onAttached={handleAttached} />
        )}

        {hasClusters && state.status === "ready" && (
          <ul className="space-y-3">
            {state.clusters.map((cluster) => (
              <li key={cluster.id}>
                <ClusterCard
                  cluster={cluster}
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

/**
 * No clusters yet: one sentence and one button (the dashboard's rule). An empty
 * table would be a table that tells you nothing about what a cluster is *for*.
 */
function EmptyState({ onAttached }: { onAttached: (cluster: Cluster) => void }) {
  return (
    <div className="bg-card/40 mx-auto flex max-w-md flex-col items-center gap-4 rounded-md border border-dashed border-border px-8 py-16 text-center">
      <div className="bg-accent text-primary grid size-12 place-items-center rounded-sm">
        <Boxes className="size-6" />
      </div>
      <div className="space-y-1">
        <h2 className="font-display text-lg font-semibold">
          No clusters attached
        </h2>
        <p className="text-muted-foreground text-sm">
          Attach a Kubernetes cluster to draw a namespace as a diagram — the same
          canvas, read live from the cluster instead of from Terraform.
        </p>
      </div>
      <AttachClusterDialog
        onAttached={onAttached}
        trigger={
          <Button>
            <Plus className="size-4" />
            Attach a cluster
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
      <div className="space-y-1">
        <h2 className="font-display text-lg font-semibold">
          Couldn't load clusters
        </h2>
        <p className="text-muted-foreground text-sm">{message}</p>
      </div>
      <Button variant="outline" onClick={onRetry}>
        Try again
      </Button>
    </div>
  );
}
