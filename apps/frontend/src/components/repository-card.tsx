import { useState } from "react";
import { Link } from "react-router-dom";
import {
  BookUp,
  Ellipsis,
  FileText,
  FolderTree,
  GitBranch,
  GitPullRequest,
  Inbox,
  Plug,
  RefreshCw,
  Settings2,
  Trash2,
  TriangleAlert,
} from "lucide-react";

import {
  deleteRepository,
  regenerateWebhookToken,
  updateRepository,
  verifyRepository,
  webhookUrl,
} from "@/api/client";
import type { Repository, RepositoryActivity } from "@/api/types";
import { relativeTime, repoName } from "@/lib/format";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Chip } from "@/components/ui/chip";
import { CiSetupBlock } from "@/components/ci-setup-block";
import { IacTypeMark } from "@/components/iac-type-mark";
import { IngestionStatus } from "@/components/ingestion-status";
import { IAC_PATH_LABELS, IAC_TYPE_LABELS } from "@/lib/iac-type";
import {
  ConnectionStatusDot,
  connectionErrorMessage,
} from "@/components/connection-status";
import { ConfluenceSettingsDialog } from "@/components/confluence-settings-dialog";
import { DeleteRepositoryDialog } from "@/components/delete-repository-dialog";
import { RepositorySettingsDialog } from "@/components/repository-settings-dialog";

/**
 * One repository on the project page.
 *
 * The row carries two calls to action — the two places you can *go*, its pull
 * requests and its docs. Everything else is configuration (verify, settings, CI
 * setup, remove) and lives in the overflow menu: with ten repos attached, six
 * equal-weight buttons per row is sixty competing buttons on one screen.
 *
 * The footer answers the question the page could not answer before: is my CI
 * actually sending data?
 */
export function RepositoryCard({
  repo,
  activity,
  onChanged,
  onDeleted,
}: Readonly<{
  repo: Repository;
  /** Undefined while activity is loading, or if the call failed. */
  activity?: RepositoryActivity;
  onChanged: (repo: Repository) => void;
  onDeleted: (id: string) => void;
}>) {
  const [showCi, setShowCi] = useState(false);
  const [verifying, setVerifying] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [confluenceOpen, setConfluenceOpen] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);
  // A freshly rotated token, shown once inside the CI block; null until rotated.
  const [freshToken, setFreshToken] = useState<string | null>(null);
  const [regenerating, setRegenerating] = useState(false);

  async function handleVerify() {
    setVerifying(true);
    setError(null);
    try {
      const result = await verifyRepository(repo.id);
      onChanged({
        ...repo,
        connectionStatus: result.ok ? "ok" : "failed",
        verifiedAt: new Date().toISOString(),
      });
      if (!result.ok) setError(connectionErrorMessage(result.error));
    } catch {
      setError("Could not verify the connection.");
    } finally {
      setVerifying(false);
    }
  }

  async function handleDelete() {
    await deleteRepository(repo.id);
    onDeleted(repo.id);
  }

  /** Clearing the last comment error is a settings concern, kept off the card. */
  async function handleRetryComments() {
    const updated = await updateRepository(repo.id, { prCommentsEnabled: true });
    onChanged(updated);
  }

  /** Rotate the webhook token; the new value is shown once in the CI block. */
  async function handleRegenerateToken() {
    setRegenerating(true);
    setError(null);
    try {
      const result = await regenerateWebhookToken(repo.id);
      setFreshToken(result.webhookToken);
    } catch {
      setError("Could not regenerate the webhook token.");
    } finally {
      setRegenerating(false);
    }
  }

  return (
    <div className="bg-card hover:border-primary/40 rounded-md border border-border transition-colors">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-3 px-4 py-3">
        <div className="min-w-0 flex-1">
          <p className="flex items-center gap-2 font-mono text-sm font-medium">
            <ConnectionStatusDot status={repo.connectionStatus} />
            <span className="truncate">{repoName(repo.url)}</span>
          </p>
          <p className="text-muted-foreground mt-1 ml-4 flex items-center gap-2 font-mono text-xs">
            <span className="capitalize">{repo.provider}</span>
            {/* What it holds (GP-101). Read-only: it is set when the repository
                is attached and never changes. The official logo makes the kind
                legible at a glance; the label stays for the screen reader. */}
            <Chip variant="neutral">
              <IacTypeMark iacType={repo.iacType} className="size-3.5" />
              {IAC_TYPE_LABELS[repo.iacType]}
            </Chip>
            <span className="inline-flex items-center gap-1">
              <GitBranch className="size-3" />
              {repo.defaultBranch}
            </span>
            {/* Only when it is not the root: silence means "the whole repo". */}
            {repo.terraformPath && (
              <span
                className="inline-flex items-center gap-1"
                title={`${IAC_PATH_LABELS[repo.iacType]} — where the documentation parse starts`}
              >
                <FolderTree className="size-3" />
                {repo.terraformPath}
              </span>
            )}
          </p>
        </div>

        <div className="flex items-center gap-1.5">
          <Button variant="outline" size="sm" asChild>
            <Link to={`/projects/${repo.projectId}/repos/${repo.id}/pulls`}>
              <GitPullRequest className="size-3.5" />
              Pull requests
            </Link>
          </Button>
          <Button variant="outline" size="sm" asChild>
            <Link to={`/projects/${repo.projectId}/repos/${repo.id}/docs`}>
              <FileText className="size-3.5" />
              Docs
            </Link>
          </Button>

          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button
                variant="ghost"
                size="icon"
                aria-label={`Manage ${repoName(repo.url)}`}
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
              <DropdownMenuItem onSelect={() => setSettingsOpen(true)}>
                <Settings2 className="size-3.5" />
                Repository settings
              </DropdownMenuItem>
              {/* GP-181: where this repository's docs page publishes to. */}
              <DropdownMenuItem onSelect={() => setConfluenceOpen(true)}>
                <BookUp className="size-3.5" />
                Confluence
              </DropdownMenuItem>
              <DropdownMenuItem onSelect={() => setShowCi((v) => !v)}>
                <Plug className="size-3.5" />
                CI setup
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem
                variant="destructive"
                onSelect={() => setDeleteOpen(true)}
              >
                <Trash2 className="size-3.5" />
                Remove repository
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </div>

      {activity && (
        <ActivityStrip
          activity={activity}
          prCommentsFailed={Boolean(repo.lastCommentError)}
          onCiSetup={() => setShowCi(true)}
        />
      )}

      {error && (
        <p
          className="text-destructive border-t border-border px-4 py-2 text-sm"
          role="alert"
        >
          {error}
        </p>
      )}

      {repo.lastCommentError && (
        <p className="text-destructive flex flex-wrap items-center gap-2 border-t border-border px-4 py-2 font-mono text-xs">
          <TriangleAlert className="size-3.5 shrink-0" />
          <span className="min-w-0 flex-1 truncate" title={repo.lastCommentError}>
            Last PR comment failed: {repo.lastCommentError}
          </span>
          <button
            type="button"
            className="hover:text-foreground underline underline-offset-2"
            onClick={handleRetryComments}
          >
            Retry
          </button>
        </p>
      )}

      {showCi && (
        <div className="space-y-4 border-t border-border p-4">
          <CiSetupBlock
            webhookUrl={webhookUrl(repo.id)}
            iacType={repo.iacType}
            {...(freshToken ? { webhookToken: freshToken } : {})}
            regenerate={{
              onRegenerate: handleRegenerateToken,
              regenerating,
            }}
          />
          <IngestionStatus repositoryId={repo.id} iacType={repo.iacType} />
        </div>
      )}

      <RepositorySettingsDialog
        repository={repo}
        open={settingsOpen}
        onOpenChange={setSettingsOpen}
        onUpdated={onChanged}
      />
      <ConfluenceSettingsDialog
        repository={repo}
        open={confluenceOpen}
        onOpenChange={setConfluenceOpen}
      />
      <DeleteRepositoryDialog
        name={repoName(repo.url)}
        open={deleteOpen}
        onOpenChange={setDeleteOpen}
        onConfirm={handleDelete}
      />
    </div>
  );
}

/**
 * The freshness of a repository, in one line: has a plan ever landed, how many
 * pull requests are open, and when CI last reached us. A repo CI has never
 * posted to says so, and points at the setup snippet.
 */
function ActivityStrip({
  activity,
  prCommentsFailed,
  onCiSetup,
}: Readonly<{
  activity: RepositoryActivity;
  prCommentsFailed: boolean;
  onCiSetup: () => void;
}>) {
  const { openPrs, lastSnapshotAt, lastEventAt } = activity;

  if (!lastEventAt && !lastSnapshotAt && openPrs === 0) {
    return (
      <div className="text-muted-foreground flex flex-wrap items-center gap-2 border-t border-border px-4 py-2 text-xs">
        <Inbox className="size-3.5" />
        <span>No CI events yet — groundplan is waiting for its first plan.</span>
        {!prCommentsFailed && (
          <button
            type="button"
            onClick={onCiSetup}
            className="text-foreground hover:text-primary underline underline-offset-2"
          >
            Set up CI
          </button>
        )}
      </div>
    );
  }

  return (
    <dl className="text-muted-foreground flex flex-wrap items-center gap-x-6 gap-y-1 border-t border-border px-4 py-2 text-xs">
      <Fact label="Last plan">
        {lastSnapshotAt ? relativeTime(lastSnapshotAt) : "never"}
      </Fact>
      <Fact label="Open PRs">{openPrs}</Fact>
      <Fact label="Last CI event">
        {lastEventAt ? relativeTime(lastEventAt) : "never"}
      </Fact>
    </dl>
  );
}

function Fact({
  label,
  children,
}: Readonly<{
  label: string;
  children: React.ReactNode;
}>) {
  return (
    <div className="flex items-center gap-1.5">
      <dt>{label}</dt>
      <dd className="text-foreground font-mono">{children}</dd>
    </div>
  );
}
