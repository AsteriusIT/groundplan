import { type FormEvent, type ReactNode, useState } from "react";

import {
  ApiError,
  createRepository,
  verifyRepository,
  webhookUrl,
} from "@/api/client";
import type { CreatedRepository, IacType, Provider } from "@/api/types";
import { IAC_TYPES } from "@/lib/iac-type";
import {
  detectProvider,
  PROVIDER_LABELS,
  PROVIDER_PAT_HELP,
  PROVIDERS,
} from "@/lib/providers";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Chip } from "@/components/ui/chip";
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
  // null = follow URL auto-detection; a value is an explicit user override that
  // wins and persists across later URL edits (GP-52).
  const [providerOverride, setProviderOverride] = useState<Provider | null>(null);
  const [branch, setBranch] = useState("main");
  // What the repository holds (GP-101). Asked once, here, because it is set at
  // attach time and never changes: a repository is one kind, not both.
  const [iacType, setIacType] = useState<IacType>("terraform");
  const [terraformPath, setTerraformPath] = useState("");
  const [pat, setPat] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [created, setCreated] = useState<CreatedRepository | null>(null);
  const [connectionIssue, setConnectionIssue] = useState<string | null>(null);

  const provider = providerOverride ?? detectProvider(url);
  const patHelp = PROVIDER_PAT_HELP[provider];
  const kubernetes = iacType === "kubernetes";

  function reset() {
    setUrl("");
    setProviderOverride(null);
    setBranch("main");
    setIacType("terraform");
    setTerraformPath("");
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
        iacType,
        accessToken: pat.trim() || undefined,
        terraformPath: terraformPath.trim() || undefined,
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
                {created.iacType === "kubernetes"
                  ? "Wire up your CI to send rendered manifests to Groundplan."
                  : "Wire up your CI to send Terraform plans to Groundplan."}
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
                iacType={created.iacType}
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
                Connect a repository so Groundplan can read its infrastructure.
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
                <Label htmlFor="repo-provider">Provider</Label>
                <div className="flex items-center gap-2">
                  <span data-testid="provider-chip">
                    <Chip variant="accent">{PROVIDER_LABELS[provider]}</Chip>
                  </span>
                  <select
                    id="repo-provider"
                    aria-label="Provider"
                    value={providerOverride ?? ""}
                    onChange={(e) =>
                      setProviderOverride(
                        e.target.value ? (e.target.value as Provider) : null,
                      )
                    }
                    className="border-border bg-background text-foreground focus-visible:ring-ring rounded-md border px-2 py-1.5 text-sm focus-visible:ring-2 focus-visible:outline-none"
                  >
                    <option value="">Auto-detect</option>
                    {PROVIDERS.map((p) => (
                      <option key={p} value={p}>
                        {PROVIDER_LABELS[p]}
                      </option>
                    ))}
                  </select>
                </div>
                <p className="text-muted-foreground text-xs">
                  Detected from the URL. Change it for a self-hosted host.
                </p>
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
                <Label htmlFor="repo-iac-type">What&apos;s in this repository?</Label>
                <div
                  id="repo-iac-type"
                  role="group"
                  aria-label="What's in this repository?"
                  className="flex gap-1"
                >
                  {IAC_TYPES.map(({ id, label }) => (
                    <button
                      key={id}
                      type="button"
                      aria-pressed={iacType === id}
                      onClick={() => setIacType(id)}
                      className={cn(
                        "rounded-md border px-3 py-1.5 text-sm transition-colors",
                        iacType === id
                          ? "border-primary bg-accent-soft text-primary"
                          : "border-border text-muted-foreground hover:text-foreground",
                      )}
                    >
                      {label}
                    </button>
                  ))}
                </div>
                <p className="text-muted-foreground text-xs">
                  Set once, when the repository is attached — a repository is one
                  kind, not both. Attach a monorepo twice, with different paths.
                </p>
              </div>

              <div className="space-y-2">
                <Label htmlFor="repo-terraform-path">
                  {kubernetes ? "Manifests path" : "Terraform path"}
                </Label>
                <Input
                  id="repo-terraform-path"
                  value={terraformPath}
                  onChange={(e) => setTerraformPath(e.target.value)}
                  placeholder={
                    kubernetes ? "Optional — e.g. deploy/prod" : "Optional — e.g. infra/azure"
                  }
                  autoComplete="off"
                />
                <p className="text-muted-foreground text-xs">
                  The directory your {kubernetes ? "manifests live" : "Terraform lives"}{" "}
                  in. Leave empty if {kubernetes ? "they sit" : "it sits"} at the
                  repository root.
                </p>
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
                <p className="text-muted-foreground text-xs">
                  {patHelp.hint}
                  {patHelp.href && (
                    <>
                      {" "}
                      <a
                        href={patHelp.href}
                        target="_blank"
                        rel="noreferrer"
                        className="text-primary underline underline-offset-2"
                      >
                        {patHelp.linkLabel}
                      </a>
                    </>
                  )}
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
