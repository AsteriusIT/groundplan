import { type FormEvent, type ReactNode, useState } from "react";

import {
  ApiError,
  createRepository,
  verifyRepository,
  webhookUrl,
} from "@/api/client";
import type { CreatedRepository, Provider } from "@/api/types";
import { cn } from "@/lib/utils";
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
import { CiSetupBlock } from "@/components/ci-setup-block";
import {
  ConnectionStatusBadge,
  connectionErrorMessage,
} from "@/components/connection-status";

const PROVIDERS: Provider[] = ["github", "gitlab"];

export function AttachRepositoryDialog({
  projectId,
  trigger,
  onAttached,
}: {
  projectId: string;
  trigger: ReactNode;
  onAttached: (repo: CreatedRepository) => void;
}) {
  const [open, setOpen] = useState(false);
  const [url, setUrl] = useState("");
  const [provider, setProvider] = useState<Provider>("github");
  const [branch, setBranch] = useState("main");
  const [pat, setPat] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [created, setCreated] = useState<CreatedRepository | null>(null);
  const [connectionIssue, setConnectionIssue] = useState<string | null>(null);

  function reset() {
    setUrl("");
    setProvider("github");
    setBranch("main");
    setPat("");
    setSubmitting(false);
    setError(null);
    setCreated(null);
    setConnectionIssue(null);
  }

  function handleOpenChange(next: boolean) {
    setOpen(next);
    // Add the repo to the list only once the dialog closes — keeping it mounted
    // means the empty→list transition can't unmount the CI-setup success step.
    if (!next) {
      if (created) onAttached(created);
      reset();
    }
  }

  async function handleSubmit(event: FormEvent) {
    event.preventDefault();
    if (!url.trim()) {
      setError("Enter the repository URL.");
      return;
    }
    setSubmitting(true);
    setError(null);
    try {
      const repo = await createRepository(projectId, {
        provider,
        url: url.trim(),
        defaultBranch: branch.trim() || "main",
        accessToken: pat.trim() || undefined,
      });
      // Surface the structured reason so a bad PAT gets a clear message.
      if (repo.connectionStatus === "failed") {
        try {
          const result = await verifyRepository(repo.id);
          if (!result.ok) setConnectionIssue(connectionErrorMessage(result.error));
        } catch {
          setConnectionIssue("Could not verify the connection.");
        }
      }
      setCreated(repo);
    } catch (err) {
      setError(
        err instanceof ApiError ? err.message : "Could not attach the repository.",
      );
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogTrigger asChild>{trigger}</DialogTrigger>
      {/* The CI-setup step (webhook URL + workflow snippet) needs more room
          than the attach form, so widen the dialog once a repo is created. */}
      <DialogContent className={cn("sm:max-w-xl", created && "sm:max-w-3xl")}>
        {created ? (
          <>
            <DialogHeader>
              <DialogTitle className="font-display">Repository attached</DialogTitle>
              <DialogDescription>
                Wire up your CI to send Terraform plans to Groundplan.
              </DialogDescription>
            </DialogHeader>
            <div className="min-w-0 space-y-4">
              <div className="flex items-center gap-2">
                <ConnectionStatusBadge status={created.connectionStatus} />
                {connectionIssue && (
                  <span className="text-destructive text-sm" role="alert">
                    {connectionIssue}
                  </span>
                )}
              </div>
              <CiSetupBlock
                webhookUrl={webhookUrl(created.id)}
                webhookToken={created.webhookToken}
              />
            </div>
            <DialogFooter>
              <Button onClick={() => handleOpenChange(false)}>Done</Button>
            </DialogFooter>
          </>
        ) : (
          <>
            <DialogHeader>
              <DialogTitle className="font-display">Attach repository</DialogTitle>
              <DialogDescription>
                Connect a repository so Groundplan can read its Terraform.
              </DialogDescription>
            </DialogHeader>
            <form onSubmit={handleSubmit} className="space-y-4">
              <div className="space-y-2">
                <Label htmlFor="repo-url">Repository URL</Label>
                <Input
                  id="repo-url"
                  value={url}
                  onChange={(e) => setUrl(e.target.value)}
                  placeholder="https://github.com/acme/infra"
                  autoComplete="off"
                  autoFocus
                />
              </div>

              <div className="space-y-2">
                <Label>Provider</Label>
                <div className="flex gap-2">
                  {PROVIDERS.map((p) => (
                    <button
                      key={p}
                      type="button"
                      aria-pressed={provider === p}
                      onClick={() => setProvider(p)}
                      className={cn(
                        "flex-1 rounded-md border px-3 py-2 text-sm capitalize transition-colors",
                        provider === p
                          ? "border-primary bg-accent text-primary font-medium"
                          : "border-border text-muted-foreground hover:bg-accent/60",
                      )}
                    >
                      {p}
                    </button>
                  ))}
                </div>
              </div>

              <div className="space-y-2">
                <Label htmlFor="repo-branch">Default branch</Label>
                <Input
                  id="repo-branch"
                  value={branch}
                  onChange={(e) => setBranch(e.target.value)}
                  placeholder="main"
                  autoComplete="off"
                />
              </div>

              <div className="space-y-2">
                <Label htmlFor="repo-pat">Access token</Label>
                <Input
                  id="repo-pat"
                  type="password"
                  value={pat}
                  onChange={(e) => setPat(e.target.value)}
                  placeholder="Optional — required for private repositories"
                  autoComplete="off"
                />
                <p className="text-muted-foreground text-xs">
                  Stored encrypted, used only to clone. Leave empty for public
                  repositories.
                </p>
              </div>

              {error && (
                <p className="text-destructive text-sm" role="alert">
                  {error}
                </p>
              )}
              <DialogFooter>
                <Button type="submit" disabled={submitting}>
                  {submitting ? "Attaching…" : "Attach repository"}
                </Button>
              </DialogFooter>
            </form>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}
