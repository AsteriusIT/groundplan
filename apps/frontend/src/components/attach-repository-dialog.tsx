/**
 * "Attach by URL" (GP-231) — now the **secondary** path.
 *
 * Importing from a connected installation (GP-230) is the main road; this modal
 * is for what that road cannot reach: a self-hosted host, a provider with no
 * app, a repository outside the installation's scope. What changed here is what
 * it asks for.
 *
 * It used to demand a token "optional — required for private repositories"
 * while never mentioning the GitHub App installation that makes the token
 * unnecessary. Now the credential is *reported*, live, as soon as the URL is
 * readable: covered by an installation (no token field at all), several
 * candidates (pick one), or nothing (the token path, unchanged from GP-51/52).
 *
 * And the repository is only added if it can actually be read: the server
 * verifies before persisting (GP-229) and its typed refusal is shown here, in
 * the modal, beside the field that can fix it — never as a repository that was
 * created and then silently reported as broken.
 */
import {
  type ReactNode,
  type SyntheticEvent,
  useEffect,
  useMemo,
  useState,
} from "react";

import {
  ApiError,
  createRepository,
  listConnections,
  webhookUrl,
} from "@/api/client";
import type {
  CreatedRepository,
  IacType,
  Provider,
  ProviderConnection,
} from "@/api/types";
import { attachRemediation } from "@/lib/attach-errors";
import { IAC_TYPES } from "@/lib/iac-type";
import {
  detectProvider,
  PROVIDER_LABELS,
  PROVIDER_PAT_HELP,
  PROVIDERS,
} from "@/lib/providers";
import { resolveCredential } from "@/lib/repo-credential";
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
import { ConnectionStatusBadge } from "@/components/connection-status";

export function AttachRepositoryDialog({
  projectId,
  trigger,
  onAttached,
}: Readonly<{
  projectId: string;
  trigger: ReactNode;
  onAttached: (repo: CreatedRepository) => void;
}>) {
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
  const [error, setError] = useState<{ message: string; code?: string } | null>(
    null,
  );
  const [created, setCreated] = useState<CreatedRepository | null>(null);
  /** The org's connections, for reporting which one covers this URL. */
  const [connections, setConnections] = useState<ProviderConnection[]>([]);
  /** Which connection to use when more than one candidate covers the URL. */
  const [chosenConnection, setChosenConnection] = useState<string | null>(null);

  const provider = providerOverride ?? detectProvider(url);
  const patHelp = PROVIDER_PAT_HELP[provider];
  const kubernetes = iacType === "kubernetes";

  // Loaded once the dialog opens: before that it is a request nobody asked for.
  useEffect(() => {
    if (!open) return;
    listConnections()
      .then(setConnections)
      // No connections is a perfectly good answer — it is the PAT path.
      .catch(() => setConnections([]));
  }, [open]);

  const credential = useMemo(
    () => resolveCredential(url, provider, connections),
    [url, provider, connections],
  );
  /** A covered repository needs no token, so it is not asked for one. */
  const needsToken = credential.kind === "token" || credential.kind === "unknown";

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
    setChosenConnection(null);
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

  async function handleSubmit(event: SyntheticEvent) {
    event.preventDefault();
    if (!url.trim()) {
      setError({ message: "Enter the repository URL." });
      return;
    }
    setSubmitting(true);
    setError(null);
    try {
      // The server resolves the credential and proves the repository is
      // readable before storing anything (GP-229), so a success here is a
      // repository that works — there is nothing left to check afterwards.
      const repo = await createRepository(projectId, {
        provider,
        url: url.trim(),
        defaultBranch: branch.trim() || "main",
        iacType,
        ...(credential.kind === "covered"
          ? { credentialId: credential.connection.id }
          : {}),
        ...(credential.kind === "ambiguous" && chosenConnection
          ? { credentialId: chosenConnection }
          : {}),
        ...(needsToken && pat.trim() ? { accessToken: pat.trim() } : {}),
        ...(terraformPath.trim() ? { terraformPath: terraformPath.trim() } : {}),
      });
      setCreated(repo);
    } catch (err) {
      // The refusal is typed, so it lands here beside the field that fixes it
      // rather than as a repository created in a state nobody can use.
      setError(
        err instanceof ApiError
          ? { message: err.message, ...(err.code ? { code: err.code } : {}) }
          : { message: "Could not attach the repository." },
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
                {/* Reachability was proven before the row existed (GP-229), so
                    this badge can only ever say so — there is no "attached but
                    broken" state left to report here. */}
                <ConnectionStatusBadge status={created.connectionStatus} />
                {created.authMode === "installation_app" && (
                  <span className="text-muted-foreground text-sm">
                    via the organization&apos;s app installation
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
                <fieldset
                  id="repo-iac-type"
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
                </fieldset>
                {/* Preventive, not descriptive (GP-231): the choice is
                    permanent, and this is the last moment to say so. */}
                <p className="text-muted-foreground text-xs">
                  This cannot be changed later — a repository is one kind, not
                  both. A monorepo holding both is attached twice, with a
                  different path each time.
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

              {/* The credential, reported rather than demanded. A repository an
                  installation already covers needs no token, so none is asked
                  for — the field that used to be here was the whole reason a
                  connected app looked useless. */}
              {credential.kind === "covered" && (
                <div className="border-border bg-muted/30 rounded-md border px-3 py-2">
                  <p className="text-sm">
                    Access via {credential.connection.name} — this organization&apos;s
                    app installation.
                  </p>
                  <p className="text-muted-foreground text-xs">
                    No token needed. Groundplan authenticates with a short-lived
                    installation token.
                  </p>
                </div>
              )}

              {credential.kind === "ambiguous" && (
                <div className="space-y-2">
                  <Label htmlFor="repo-connection">Connection</Label>
                  <select
                    id="repo-connection"
                    value={chosenConnection ?? ""}
                    onChange={(e) => setChosenConnection(e.target.value || null)}
                    className="border-border bg-background text-foreground focus-visible:ring-ring w-full rounded-md border px-2 py-1.5 text-sm focus-visible:ring-2 focus-visible:outline-none"
                  >
                    <option value="">Choose a connection…</option>
                    {credential.candidates.map((connection) => (
                      <option key={connection.id} value={connection.id}>
                        {connection.name}
                      </option>
                    ))}
                  </select>
                  <p className="text-muted-foreground text-xs">
                    Several of this organization&apos;s connections cover this
                    owner. Pick the one to authenticate with.
                  </p>
                </div>
              )}

              {needsToken && (
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
              )}

              {error && (
                <div className="text-destructive space-y-1 text-sm" role="alert">
                  <p>{error.message}</p>
                  {attachRemediation(error.code) && (
                    <p className="text-muted-foreground text-xs">
                      {attachRemediation(error.code)}
                    </p>
                  )}
                </div>
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
