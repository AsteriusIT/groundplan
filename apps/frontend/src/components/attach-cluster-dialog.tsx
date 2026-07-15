import { type ReactNode, type SyntheticEvent, useState } from "react";
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
  trigger,
  onAttached,
}: Readonly<{
  trigger: ReactNode;
  onAttached: (cluster: Cluster) => void;
}>) {
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

  async function handleSubmit(event: SyntheticEvent) {
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
      const cluster = await createCluster({ name: name.trim(), kubeconfig });
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
      {/* A kubeconfig is a wide, tall thing to look at. Cap the height rather than
          letting the dialog grow past the viewport and take the submit button with
          it — a form you cannot reach the bottom of is not a form. */}
      <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-2xl">
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
            {/* `min-w-0`: this form is a grid item of the dialog, so its default
                `min-width: auto` would size it to its widest child. A kubeconfig's
                base64 lines are single unbroken ~1500-character tokens, which is
                how the dialog ended up wider than the screen. */}
            <form onSubmit={handleSubmit} className="min-w-0 space-y-4">
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
                {/* `field-sizing-fixed` overrides the primitive's
                    `field-sizing-content`, which sizes a textarea to its content:
                    fine for prose, ruinous for a pasted file — a kubeconfig's
                    base64 lines are single unbroken ~1500-character tokens, so the
                    box grew to swallow the whole dialog (and, before `min-w-0`
                    below, the whole screen). Fixed, it keeps the height we asked
                    for and the paste wraps and scrolls inside it. */}
                <Textarea
                  id="cluster-kubeconfig"
                  value={kubeconfig}
                  onChange={(e) => setKubeconfig(e.target.value)}
                  placeholder="Paste the contents of your kubeconfig file"
                  rows={10}
                  spellCheck={false}
                  autoComplete="off"
                  className="field-sizing-fixed h-56 w-full min-w-0 resize-y overflow-auto font-mono text-xs"
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
