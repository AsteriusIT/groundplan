import { useState } from "react";
import { Link } from "react-router-dom";
import { Boxes, Ellipsis, RefreshCw, Trash2 } from "lucide-react";

import { deleteCluster, verifyCluster } from "@/api/client";
import type { Cluster } from "@/api/types";
import { relativeTime } from "@/lib/format";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  ConnectionStatusDot,
  clusterErrorMessage,
} from "@/components/connection-status";
import { DeleteClusterDialog } from "@/components/delete-cluster-dialog";

/**
 * One cluster on the project page (GP-98) — the repository row's twin, for the
 * same reason it looks like one: attaching a cluster and attaching a repository
 * are the same act, and a person who has done one should recognise the other.
 *
 * The row carries one call to action (go and look at its namespaces) and puts
 * everything else — verify, remove — in the overflow menu.
 */
export function ClusterCard({
  cluster,
  onChanged,
  onDeleted,
}: {
  cluster: Cluster;
  onChanged: (cluster: Cluster) => void;
  onDeleted: (id: string) => void;
}) {
  const [verifying, setVerifying] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [deleteOpen, setDeleteOpen] = useState(false);

  async function handleVerify() {
    setVerifying(true);
    setError(null);
    try {
      const result = await verifyCluster(cluster.id);
      onChanged({
        ...cluster,
        connectionStatus: result.ok ? "ok" : "failed",
        verifiedAt: new Date().toISOString(),
      });
      if (!result.ok) setError(clusterErrorMessage(result.error));
    } catch {
      setError("Could not verify the connection.");
    } finally {
      setVerifying(false);
    }
  }

  async function handleDelete() {
    await deleteCluster(cluster.id);
    onDeleted(cluster.id);
  }

  return (
    <div className="bg-card hover:border-primary/40 rounded-md border border-border transition-colors">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-3 px-4 py-3">
        <div className="min-w-0 flex-1">
          <p className="flex items-center gap-2 font-mono text-sm font-medium">
            <ConnectionStatusDot status={cluster.connectionStatus} />
            <span className="truncate">{cluster.name}</span>
          </p>
          <p className="text-muted-foreground mt-1 ml-4 font-mono text-xs">
            {cluster.verifiedAt
              ? `Checked ${relativeTime(cluster.verifiedAt)}`
              : "Never checked"}
          </p>
        </div>

        <div className="flex items-center gap-1.5">
          <Button variant="outline" size="sm" asChild>
            <Link to={`/projects/${cluster.projectId}/clusters/${cluster.id}`}>
              <Boxes className="size-3.5" />
              Namespaces
            </Link>
          </Button>

          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button
                variant="ghost"
                size="icon"
                aria-label={`Manage ${cluster.name}`}
              >
                <Ellipsis className="size-4" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-52">
              <DropdownMenuItem onSelect={handleVerify} disabled={verifying}>
                <RefreshCw
                  className={verifying ? "size-3.5 animate-spin" : "size-3.5"}
                />
                {verifying ? "Verifying…" : "Verify connection"}
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem
                variant="destructive"
                onSelect={() => setDeleteOpen(true)}
              >
                <Trash2 className="size-3.5" />
                Remove cluster
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </div>

      {error && (
        <p
          className="text-destructive border-t border-border px-4 py-2 text-sm"
          role="alert"
        >
          {error}
        </p>
      )}

      <DeleteClusterDialog
        name={cluster.name}
        open={deleteOpen}
        onOpenChange={setDeleteOpen}
        onConfirm={handleDelete}
      />
    </div>
  );
}
