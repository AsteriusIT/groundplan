import { type FormEvent, type ReactNode, useState } from "react";
import { ShieldCheck } from "lucide-react";

import { ApiError, createCluster, verifyCluster } from "@/api/client";
import type { Cluster } from "@/api/types";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  ConnectionStatusBadge,
  clusterErrorMessage,
} from "@/components/connection-status";

/**
 * Attach a cluster (GP-98) — the repository-attach flow (GP-16) pointed at a
 * kubeconfig, deliberately: the same shape, so the same habits apply.
 *
 * The kubeconfig is write-only. It lives in this textarea, goes up once, and is
 * masked in every response — which is why the success step below shows a status,
 * not the credential. There is nothing to re-display and nothing to copy back.
 *
 * The trust copy is a feature, not a caption. Somebody is about to hand us a key
 * to their cluster; they are owed a plain sentence about what we do with it,
 * before they paste, not in a doc they will never open.
 */
export function AttachClusterDialog({
  projectId,
  trigger,
  onAttached,
}: {
  projectId: string;
  trigger: ReactNode;
  onAttached: (cluster: Cluster) => void;
}) {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [kubeconfig, setKubeconfig] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [created, setCreated] = useState<Cluster | null>(null);
  const [connectionIssue, setConnectionIssue] = useState<string | null>(null);

  function reset() {
    setName("");
    setKubeconfig("");
    setSubmitting(false);
    setError(null);
    setCreated(null);
    setConnectionIssue(null);
  }

  function handleOpenChange(next: boolean) {
    setOpen(next);
    if (!next) {
      if (created) onAttached(created);
      reset();
    }
  }

  async function handleSubmit(event: FormEvent) {
    event.preventDefault();
    if (!name.trim()) {
      setError("Name this cluster.");
      return;
    }
    if (!kubeconfig.trim()) {
      setError("Paste a kubeconfig.");
      return;
    }

    setSubmitting(true);
    setError(null);
    try {
      const cluster = await createCluster(projectId, {
        name: name.trim(),
        kubeconfig,
      });
      // The API auto-verifies on create; a failure deserves a reason, not a chip
      // that just says no.
      if (cluster.connectionStatus === "failed") {
        try {
          const result = await verifyCluster(cluster.id);
          if (!result.ok) setConnectionIssue(clusterErrorMessage(result.error));
        } catch {
          setConnectionIssue("Could not verify the connection.");
        }
      }
      setCreated(cluster);
    } catch (err) {
      // A rejected kubeconfig keeps the form — and the paste. A 422 is something
      // to fix, not a reason to make somebody find the file again.
      setError(
        err instanceof ApiError ? err.message : "Could not attach the cluster.",
      );
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogTrigger asChild>{trigger}</DialogTrigger>
      <DialogContent className="sm:max-w-xl">
        {created ? (
          <>
            <DialogHeader>
              <DialogTitle className="font-display">Cluster attached</DialogTitle>
              <DialogDescription>
                Pick a namespace to draw it as a diagram.
              </DialogDescription>
            </DialogHeader>
            <div className="flex items-center gap-2">
              <ConnectionStatusBadge status={created.connectionStatus} />
              {connectionIssue && (
                <span className="text-destructive text-sm" role="alert">
                  {connectionIssue}
                </span>
              )}
            </div>
            <DialogFooter>
              <Button onClick={() => handleOpenChange(false)}>Done</Button>
            </DialogFooter>
          </>
        ) : (
          <>
            <DialogHeader>
              <DialogTitle className="font-display">Attach cluster</DialogTitle>
              <DialogDescription>
                Connect a Kubernetes cluster so Groundplan can draw its namespaces.
              </DialogDescription>
            </DialogHeader>
            <form onSubmit={handleSubmit} className="space-y-4">
              <div className="space-y-2">
                <Label htmlFor="cluster-name">Cluster name</Label>
                <Input
                  id="cluster-name"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder="production"
                  autoComplete="off"
                  autoFocus
                />
              </div>

              <div className="space-y-2">
                <Label htmlFor="cluster-kubeconfig">Kubeconfig</Label>
                <Textarea
                  id="cluster-kubeconfig"
                  value={kubeconfig}
                  onChange={(e) => setKubeconfig(e.target.value)}
                  placeholder="Paste the contents of your kubeconfig file"
                  rows={8}
                  spellCheck={false}
                  autoComplete="off"
                  className="font-mono text-xs"
                />
                <p className="text-muted-foreground text-xs">
                  Stored encrypted and never shown again. We use its{" "}
                  <span className="font-mono">current context</span> — there is no
                  context picker, so point that at the cluster you mean.
                </p>
              </div>

              <div className="bg-accent/60 flex gap-2.5 rounded-md border border-border px-3 py-2.5">
                <ShieldCheck className="text-primary mt-0.5 size-4 shrink-0" />
                <p className="text-muted-foreground text-xs leading-relaxed">
                  Read-only access. We list resources to draw diagrams — we never
                  write to your cluster and never read Secret values. Use a
                  kubeconfig bound to a read-only role.
                </p>
              </div>

              {error && (
                <p className="text-destructive text-sm" role="alert">
                  {error}
                </p>
              )}
              <DialogFooter>
                <Button type="submit" disabled={submitting}>
                  {submitting ? "Attaching…" : "Attach cluster"}
                </Button>
              </DialogFooter>
            </form>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}
