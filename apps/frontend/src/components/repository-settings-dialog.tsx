import { type FormEvent, useEffect, useState } from "react";
import { TriangleAlert } from "lucide-react";

import { ApiError, updateRepository } from "@/api/client";
import type { Repository, UpdateRepositoryInput } from "@/api/types";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

/**
 * One home for a repository's set-once configuration: the access token, the
 * default branch and whether plan snapshots comment on GitHub PRs (GP-38).
 * These are settings, not daily actions — they belong behind a dialog rather
 * than on the row, which is why the card carries destinations only.
 *
 * Only the fields the user actually touched are sent; the server re-verifies
 * the connection when the token or the branch changes.
 *
 * Controlled (no trigger): it opens from the card's overflow menu, which
 * unmounts on select and would take an embedded trigger's dialog with it.
 */
export function RepositorySettingsDialog({
  repository,
  open,
  onOpenChange,
  onUpdated,
}: {
  repository: Repository;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onUpdated: (repo: Repository) => void;
}) {
  const [pat, setPat] = useState("");
  const [branch, setBranch] = useState(repository.defaultBranch);
  const [tfPath, setTfPath] = useState(repository.terraformPath);
  const [prComments, setPrComments] = useState(repository.prCommentsEnabled);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Re-seed the form each time it opens: the repo may have changed since the
  // last time (a verify, a token edit) and a stale draft would silently undo it.
  useEffect(() => {
    if (open) {
      setBranch(repository.defaultBranch);
      setTfPath(repository.terraformPath);
      setPrComments(repository.prCommentsEnabled);
    }
  }, [
    open,
    repository.defaultBranch,
    repository.terraformPath,
    repository.prCommentsEnabled,
  ]);

  function handleOpenChange(next: boolean) {
    onOpenChange(next);
    if (!next) {
      setPat("");
      setError(null);
      setSubmitting(false);
    }
  }

  const patch: UpdateRepositoryInput = {
    ...(pat.trim() ? { accessToken: pat.trim() } : {}),
    ...(branch.trim() && branch.trim() !== repository.defaultBranch
      ? { defaultBranch: branch.trim() }
      : {}),
    // Unlike the branch, an emptied path is meaningful: it moves the Terraform
    // root back to the repository root.
    ...(tfPath.trim() !== repository.terraformPath
      ? { terraformPath: tfPath.trim() }
      : {}),
    ...(prComments !== repository.prCommentsEnabled
      ? { prCommentsEnabled: prComments }
      : {}),
  };
  const dirty = Object.keys(patch).length > 0;

  async function handleSubmit(event: FormEvent) {
    event.preventDefault();
    if (!dirty) {
      handleOpenChange(false);
      return;
    }
    setSubmitting(true);
    setError(null);
    try {
      const updated = await updateRepository(repository.id, patch);
      onUpdated(updated);
      handleOpenChange(false);
    } catch (err) {
      setError(
        err instanceof ApiError ? err.message : "Could not save the settings.",
      );
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle className="font-display">Repository settings</DialogTitle>
          <DialogDescription>
            How groundplan reaches this repository, and what it does on a pull
            request.
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={handleSubmit} className="space-y-5">
          <div className="space-y-2">
            <Label htmlFor="repo-settings-pat">
              {repository.accessToken ? "Replace access token" : "Access token"}
            </Label>
            <Input
              id="repo-settings-pat"
              type="password"
              value={pat}
              onChange={(e) => setPat(e.target.value)}
              placeholder={repository.accessToken ? "••••••••" : "Only for private repositories"}
              autoComplete="off"
            />
            <p className="text-muted-foreground text-xs">
              {repository.accessToken
                ? "A token is stored. Leave this blank to keep it."
                : "Stored encrypted at rest. Needs read access to the repository."}
            </p>
          </div>

          <div className="space-y-2">
            <Label htmlFor="repo-settings-branch">Default branch</Label>
            <Input
              id="repo-settings-branch"
              value={branch}
              onChange={(e) => setBranch(e.target.value)}
              autoComplete="off"
            />
            <p className="text-muted-foreground text-xs">
              The branch documentation is generated from, and the target pull
              requests are compared against.
            </p>
          </div>

          <div className="space-y-2">
            <Label htmlFor="repo-settings-tf-path">Terraform path</Label>
            <Input
              id="repo-settings-tf-path"
              value={tfPath}
              onChange={(e) => setTfPath(e.target.value)}
              placeholder="Repository root"
              autoComplete="off"
            />
            <p className="text-muted-foreground text-xs">
              The directory your Terraform lives in, e.g.{" "}
              <span className="font-mono">infra/azure</span>. Leave empty for the
              repository root. Applies to the next documentation snapshot; plans
              come from your CI and are unaffected.
            </p>
          </div>

          {/* GP-38: opt in to GitHub PR comments; surface the last failure. */}
          <div className="space-y-2">
            <label className="flex cursor-pointer items-start gap-2.5 text-sm">
              <input
                type="checkbox"
                className="accent-primary mt-0.5 size-4"
                checked={prComments}
                onChange={(e) => setPrComments(e.target.checked)}
              />
              <span>
                Comment on GitHub pull requests
                <span className="text-muted-foreground block text-xs">
                  Posts the change summary back to the PR when a plan arrives.
                  Needs a token with write access.
                </span>
              </span>
            </label>
            {repository.lastCommentError && (
              <p className="text-destructive flex items-start gap-1.5 font-mono text-xs">
                <TriangleAlert className="mt-0.5 size-3.5 shrink-0" />
                <span>Last PR comment failed: {repository.lastCommentError}</span>
              </p>
            )}
          </div>

          {error && (
            <p className="text-destructive text-sm" role="alert">
              {error}
            </p>
          )}

          <DialogFooter>
            <Button type="submit" disabled={submitting || !dirty}>
              {submitting ? "Saving…" : "Save settings"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
