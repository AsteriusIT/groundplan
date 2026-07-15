/**
 * Share dialog for a docs repository (GP-39): create tokenized read-only links
 * (either "always latest" or pinned to the current snapshot), copy them, and
 * revoke the active ones. The links resolve on the public, no-login share page.
 */
import { useCallback, useEffect, useState } from "react";
import { Link2, Loader2, Share2, Trash2 } from "lucide-react";

import {
  ApiError,
  createShareLink,
  listShareLinks,
  revokeShareLink,
  shareUrl,
} from "@/api/client";
import type { ShareLink } from "@/api/types";
import { Button } from "@/components/ui/button";
import { CopyButton } from "@/components/copy-button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";

export function ShareDialog({
  repositoryId,
  currentSnapshotId,
}: Readonly<{
  repositoryId: string;
  /** The snapshot currently open — offered as the "pin this version" target. */
  currentSnapshotId: string | null;
}>) {
  const [open, setOpen] = useState(false);
  const [links, setLinks] = useState<ShareLink[]>([]);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(() => {
    setLoading(true);
    listShareLinks(repositoryId)
      .then(setLinks)
      .catch((err) => setError(err instanceof ApiError ? err.message : "Could not load links."))
      .finally(() => setLoading(false));
  }, [repositoryId]);

  useEffect(() => {
    if (open) {
      setError(null);
      load();
    }
  }, [open, load]);

  const create = async (kind: "docs_latest" | "snapshot") => {
    setBusy(true);
    setError(null);
    try {
      await createShareLink(repositoryId, {
        kind,
        snapshotId: kind === "snapshot" ? currentSnapshotId ?? undefined : undefined,
      });
      load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not create link.");
    } finally {
      setBusy(false);
    }
  };

  const revoke = async (id: string) => {
    setBusy(true);
    setError(null);
    try {
      await revokeShareLink(id);
      setLinks((current) => current.filter((l) => l.id !== id));
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not revoke link.");
    } finally {
      setBusy(false);
    }
  };

  const linksSection =
    links.length === 0 ? (
      <p className="text-muted-foreground text-sm">No active share links yet.</p>
    ) : (
      <ul className="divide-y divide-border">
        {links.map((link) => (
          <li key={link.id} className="flex items-center gap-2 py-2">
            <div className="min-w-0 flex-1">
              <p className="truncate font-mono text-xs">{shareUrl(link.token)}</p>
              <p className="text-muted-foreground text-[11px]">
                {link.kind === "docs_latest" ? "Always latest" : "Pinned snapshot"}
              </p>
            </div>
            <CopyButton value={shareUrl(link.token)} label="Copy" className="shrink-0" />
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="shrink-0"
              aria-label="Revoke link"
              disabled={busy}
              onClick={() => revoke(link.id)}
            >
              <Trash2 className="text-destructive size-4" />
            </Button>
          </li>
        ))}
      </ul>
    );

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button variant="outline">
          <Share2 className="size-4" />
          Share
        </Button>
      </DialogTrigger>
      <DialogContent className="sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>Share this documentation</DialogTitle>
          <DialogDescription>
            Anyone with the link can view a read-only diagram — no login required.
          </DialogDescription>
        </DialogHeader>

        <div className="flex flex-wrap gap-2">
          <Button size="sm" onClick={() => create("docs_latest")} disabled={busy}>
            <Link2 className="size-4" />
            New link · always latest
          </Button>
          <Button
            size="sm"
            variant="outline"
            onClick={() => create("snapshot")}
            disabled={busy || !currentSnapshotId}
          >
            Pin this version
          </Button>
        </div>

        {error && (
          <p role="alert" className="text-destructive text-sm">
            {error}
          </p>
        )}

        {/* min-w-0: this is a grid item, and the nowrap URL below would otherwise
            push the track past the dialog's width instead of truncating. */}
        <div className="min-h-16 min-w-0">
          {loading ? (
            <p className="text-muted-foreground flex items-center gap-2 text-sm">
              <Loader2 className="size-4 animate-spin" /> Loading links…
            </p>
          ) : (
            linksSection
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
