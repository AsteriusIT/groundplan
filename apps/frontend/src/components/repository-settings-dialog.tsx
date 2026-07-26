import { type SubmitEvent, useEffect, useState } from "react";
import { TriangleAlert } from "lucide-react";

import {
  ApiError,
  listConnections,
  setRepositoryCredential,
  updateRepository,
} from "@/api/client";
import type {
  CredentialMode,
  ProviderConnection,
  Repository,
  UpdateRepositoryInput,
} from "@/api/types";
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
import { IAC_PATH_LABELS } from "@/lib/iac-type";

/** How the repository's active credential mode reads to a person (GP-198). */
const AUTH_MODE_LABEL: Record<CredentialMode | "none", string> = {
  pat: "This repository's own access token.",
  oauth2: "An organization OAuth connection.",
  installation_app: "An organization app installation — no token stored here.",
  none: "No credential — only public repositories can be read.",
};

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
}: Readonly<{
  repository: Repository;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onUpdated: (repo: Repository) => void;
}>) {
  const [pat, setPat] = useState("");
  const [branch, setBranch] = useState(repository.defaultBranch);
  // Org connections this repository *could* use — same provider only (GP-198).
  const [connections, setConnections] = useState<ProviderConnection[]>([]);
  const [credentialId, setCredentialId] = useState(repository.credentialId);
  const [authMode, setAuthMode] = useState(repository.authMode);
  const [switching, setSwitching] = useState(false);
  const [tfPath, setTfPath] = useState(repository.terraformPath);
  const [prComments, setPrComments] = useState(repository.prCommentsEnabled);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Re-seed the form each time it opens: the repo may have changed since the
  // last time (a verify, a token edit) and a stale draft would silently undo it.
  // The connections list is only useful while the dialog is open, and it is
  // one call per opening rather than one per repository row behind it.
  useEffect(() => {
    if (!open) return;
    listConnections()
      .then((all) => setConnections(all.filter((c) => c.provider === repository.provider)))
      .catch(() => setConnections([]));
  }, [open, repository.provider]);

  useEffect(() => {
    if (open) {
      setCredentialId(repository.credentialId);
      setAuthMode(repository.authMode);
      setBranch(repository.defaultBranch);
      setTfPath(repository.terraformPath);
      setPrComments(repository.prCommentsEnabled);
    }
  }, [
    open,
    repository.defaultBranch,
    repository.terraformPath,
    repository.prCommentsEnabled,
    repository.credentialId,
    repository.authMode,
  ]);

  /**
   * Move this repository onto an org connection, or back to its own token.
   * It saves immediately rather than joining the form's patch: it is a
   * different kind of change — one that can degrade the repository — and
   * folding it into "Save changes" would hide that.
   */
  async function handleCredential(next: string | null) {
    setSwitching(true);
    setError(null);
    try {
      const result = await setRepositoryCredential(repository.id, next);
      setCredentialId(result.credentialId);
      setAuthMode(result.authMode);
    } catch (err) {
      setError(
        err instanceof ApiError ? err.message : "Could not change how this repository authenticates.",
      );
    } finally {
      setSwitching(false);
    }
  }

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

  async function handleSubmit(event: SubmitEvent) {
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
          {/* GP-198: which credential is actually in force, and the one-click
              move onto an org connection that covers this repository. */}
          <div className="space-y-2">
            <p className="text-sm leading-none font-medium">Authentication</p>
            <p className="text-muted-foreground text-xs">
              {AUTH_MODE_LABEL[authMode ?? "none"]}
            </p>
            {connections.length > 0 && (
              <div className="flex flex-wrap gap-2 pt-1">
                {connections.map((connection) => (
                  <Button
                    key={connection.id}
                    type="button"
                    size="sm"
                    variant={credentialId === connection.id ? "default" : "outline"}
                    aria-pressed={credentialId === connection.id}
                    disabled={switching}
                    onClick={() => void handleCredential(connection.id)}
                  >
                    {connection.name}
                  </Button>
                ))}
                <Button
                  type="button"
                  size="sm"
                  variant={credentialId === null ? "default" : "outline"}
                  aria-pressed={credentialId === null}
                  disabled={switching}
                  onClick={() => void handleCredential(null)}
                >
                  Use this repository's token
                </Button>
              </div>
            )}
          </div>

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
            <Label htmlFor="repo-settings-tf-path">
              {IAC_PATH_LABELS[repository.iacType]}
            </Label>
            <Input
              id="repo-settings-tf-path"
              value={tfPath}
              onChange={(e) => setTfPath(e.target.value)}
              placeholder="Repository root"
              autoComplete="off"
            />
            {repository.iacType === "kubernetes" ? (
              <p className="text-muted-foreground text-xs">
                The directory your manifests live in, e.g.{" "}
                <span className="font-mono">deploy/prod</span>. Leave empty for the
                repository root. Applies to the next documentation snapshot; what
                your CI renders comes rendered and is unaffected.
              </p>
            ) : (
              <p className="text-muted-foreground text-xs">
                The directory your Terraform lives in, e.g.{" "}
                <span className="font-mono">infra/azure</span>. Leave empty for the
                repository root. Applies to the next documentation snapshot; plans
                come from your CI and are unaffected.
              </p>
            )}
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
                Comment on GitHub pull requests{/* */}
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
