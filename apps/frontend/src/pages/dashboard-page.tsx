import { useCallback, useEffect, useState, type ReactNode } from "react";
import { Link } from "react-router-dom";
import {
  Boxes,
  FileText,
  FolderGit2,
  Globe,
  GitPullRequest,
  ShieldAlert,
  TriangleAlert,
  Unlink,
  type LucideIcon,
} from "lucide-react";

import { ApiError, getDashboard } from "@/api/client";
import type {
  Dashboard,
  DashboardDocsSnapshot,
  DashboardPull,
} from "@/api/types";
import { branchName, formatDate, repoName, shortSha } from "@/lib/format";
import { cn } from "@/lib/utils";
import { ChangeChips } from "@/components/change-chips";
import { PageHeader } from "@/components/page-header";
import { Chip } from "@/components/ui/chip";

type LoadState =
  | { status: "loading" }
  | { status: "error"; message: string }
  | { status: "ready"; data: Dashboard };

/**
 * The landing page (GP-68): a read on the estate, then straight into the work.
 * Everything comes from one aggregate call (GP-67) and every row deep-links into
 * the view that owns it — this page shows, it never becomes a second home for
 * detail.
 */
export function DashboardPage() {
  const [state, setState] = useState<LoadState>({ status: "loading" });

  const load = useCallback(() => {
    setState({ status: "loading" });
    getDashboard()
      .then((data) => setState({ status: "ready", data }))
      .catch((err) =>
        setState({
          status: "error",
          message:
            err instanceof ApiError ? err.message : "Could not load the dashboard.",
        }),
      );
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  return (
    <div>
      <PageHeader
        eyebrow="Overview"
        title="Dashboard"
        description="A read on your estate at a glance."
      />
      <div className="p-8">
        {state.status === "loading" && (
          <p className="text-muted-foreground text-sm" aria-busy="true">
            Loading dashboard…
          </p>
        )}

        {state.status === "error" && (
          <ErrorState message={state.message} onRetry={load} />
        )}

        {state.status === "ready" &&
          (state.data.stats.repositories === 0 ? (
            <FirstRepositoryCta />
          ) : (
            <Estate data={state.data} />
          ))}
      </div>
    </div>
  );
}

function Estate({ data }: Readonly<{ data: Dashboard }>) {
  const { stats, recentPrs, recentDocsSnapshots, orphanRepositories } = data;
  // Worst-hit repository first (GP-67), so the card lands on the review that
  // matters most when several repositories have drifted.
  const worstOrphans = orphanRepositories[0];

  return (
    <div className="space-y-8">
      <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
        <StatCard
          icon={Boxes}
          label="Projects"
          value={stats.projects}
          to="/projects"
        />
        <StatCard
          icon={FolderGit2}
          label="Repositories"
          value={stats.repositories}
          to="/projects"
        />
        <StatCard
          icon={GitPullRequest}
          label="Open pull requests"
          value={stats.openPrs}
        />
        {/* Only when something is actually orphaned — an always-on zero would be
            noise, and with nothing to fix the card has nowhere to go (GP-59). */}
        {stats.orphanedAnnotations > 0 && worstOrphans && (
          <StatCard
            icon={Unlink}
            label="Orphaned annotations"
            value={stats.orphanedAnnotations}
            to={`/projects/${worstOrphans.projectId}/repos/${worstOrphans.repositoryId}/docs`}
            tone="warning"
          />
        )}
      </div>

      <Section
        title="Recent pull requests"
        description="Plan impact from your CI, newest first."
        empty={
          recentPrs.length === 0
            ? "No pull requests yet — they appear as soon as your CI posts a plan."
            : undefined
        }
      >
        {recentPrs.map((pull) => (
          <PullRow key={pull.id} pull={pull} />
        ))}
      </Section>

      <Section
        title="Recent documentation updates"
        description="Docs regenerate on every merge to the default branch."
        empty={
          recentDocsSnapshots.length === 0
            ? "No documentation generated yet — generate it from a repository."
            : undefined
        }
      >
        {recentDocsSnapshots.map((snapshot) => (
          <DocsRow key={snapshot.id} snapshot={snapshot} />
        ))}
      </Section>
    </div>
  );
}

function StatCard({
  icon: Icon,
  label,
  value,
  to,
  tone = "neutral",
}: Readonly<{
  icon: LucideIcon;
  label: string;
  value: number;
  /** Makes the card a link. Omit for a card with nowhere useful to go. */
  to?: string;
  tone?: "neutral" | "warning";
}>) {
  const warning = tone === "warning";
  const body = (
    <>
      <div className="flex items-center gap-2">
        <Icon
          className={cn("size-4", warning ? "text-exposed" : "text-muted-foreground")}
        />
        <p className="text-muted-foreground text-xs font-medium">{label}</p>
      </div>
      <p
        className={cn(
          "font-display mt-2 text-3xl font-semibold tracking-tight tabular-nums",
          warning && "text-exposed",
        )}
      >
        {value}
      </p>
    </>
  );

  const className = cn(
    "bg-card block rounded-md border px-4 py-3.5",
    warning ? "border-exposed/30" : "border-border",
  );

  // A card with nowhere to go stays a plain card — a link that navigates
  // nowhere useful is worse than no link.
  if (!to) {
    return (
      <div data-stat={label} className={className}>
        {body}
      </div>
    );
  }
  return (
    <Link
      data-stat={label}
      to={to}
      className={cn(className, "hover:border-primary transition-colors")}
    >
      {body}
    </Link>
  );
}

function Section({
  title,
  description,
  empty,
  children,
}: Readonly<{
  title: string;
  description: string;
  /** Set when there is nothing to list — shown instead of the rows. */
  empty?: string;
  children: ReactNode;
}>) {
  return (
    <section>
      <div className="mb-3">
        <h2 className="font-display text-base font-semibold tracking-tight">
          {title}
        </h2>
        <p className="text-muted-foreground mt-0.5 text-xs">{description}</p>
      </div>
      {empty ? (
        <p className="text-muted-foreground bg-card/40 rounded-md border border-dashed border-border px-4 py-6 text-center text-sm">
          {empty}
        </p>
      ) : (
        <ul className="space-y-2">{children}</ul>
      )}
    </section>
  );
}

function PullRow({ pull }: Readonly<{ pull: DashboardPull }>) {
  return (
    <li>
      <Link
        to={`/projects/${pull.projectId}/repos/${pull.repositoryId}/pulls/${pull.number}`}
        className="bg-card hover:border-primary flex items-center gap-4 rounded-md border border-border px-4 py-3 transition-colors"
      >
        <GitPullRequest
          className={cn(
            "size-4 shrink-0",
            pull.state === "open" ? "text-create" : "text-faint",
          )}
        />

        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <p
              className={cn(
                "truncate text-sm font-medium",
                pull.state === "closed" && "text-muted-foreground line-through",
              )}
            >
              {pull.title ?? `Pull request #${pull.number}`}
            </p>
            {pull.internetExposed && (
              <Chip variant="exposed">
                <Globe className="size-3" />
                Exposed
              </Chip>
            )}
            {pull.privileged && (
              <Chip variant="exposed">
                <ShieldAlert className="size-3" />
                Privileged
              </Chip>
            )}
          </div>
          <p className="text-muted-foreground mt-0.5 truncate font-mono text-xs">
            {repoName(pull.repositoryUrl)} · #{pull.number} ·{" "}
            {branchName(pull.sourceRef)} → {pull.targetRef} · updated{" "}
            {formatDate(pull.updatedAt)}
          </p>
        </div>

        {pull.latestSnapshot ? (
          <ChangeChips
            changes={pull.latestSnapshot.stats.changes}
            impacted={pull.latestSnapshot.stats.impactedCount}
          />
        ) : (
          <span className="text-faint shrink-0 font-mono text-xs">no diagram</span>
        )}
      </Link>
    </li>
  );
}

function DocsRow({ snapshot }: Readonly<{ snapshot: DashboardDocsSnapshot }>) {
  return (
    <li>
      <Link
        to={`/projects/${snapshot.projectId}/repos/${snapshot.repositoryId}/docs`}
        className="bg-card hover:border-primary flex items-center gap-4 rounded-md border border-border px-4 py-3 transition-colors"
      >
        <FileText className="text-muted-foreground size-4 shrink-0" />
        <p className="min-w-0 flex-1 truncate text-sm font-medium">
          {repoName(snapshot.repositoryUrl)}
        </p>
        <span className="text-muted-foreground shrink-0 font-mono text-xs">
          {shortSha(snapshot.commitSha)}
        </span>
        <Chip variant={snapshot.trigger === "auto" ? "accent" : "neutral"}>
          {snapshot.trigger}
        </Chip>
        <span className="text-faint shrink-0 font-mono text-xs">
          {formatDate(snapshot.createdAt)}
        </span>
      </Link>
    </li>
  );
}

/**
 * The whole fresh-user story: one thing to do, no empty tables behind it. A
 * repository is attached from inside a project, so the CTA lands on the project
 * list — which is also where the first project gets created.
 */
function FirstRepositoryCta() {
  return (
    <div className="bg-card/40 mx-auto flex max-w-md flex-col items-center gap-4 rounded-md border border-dashed border-border px-8 py-16 text-center">
      <div className="bg-accent text-primary grid size-12 place-items-center rounded-sm">
        <FolderGit2 className="size-6" />
      </div>
      <div className="space-y-1">
        <h2 className="font-display text-lg font-semibold">
          Nothing mapped yet
        </h2>
        <p className="text-muted-foreground text-sm">
          Attach a repository and Groundplan turns its Terraform into diagrams —
          on every pull request, and on every merge.
        </p>
      </div>
      <Link
        to="/projects"
        className="bg-primary text-primary-foreground rounded-sm px-4 py-2 text-sm font-medium"
      >
        Attach your first repository
      </Link>
    </div>
  );
}

function ErrorState({
  message,
  onRetry,
}: Readonly<{
  message: string;
  onRetry: () => void;
}>) {
  return (
    <div
      role="alert"
      className="border-destructive/30 bg-destructive/5 mx-auto flex max-w-md flex-col items-center gap-4 rounded-md border px-8 py-12 text-center"
    >
      <TriangleAlert className="text-destructive size-8" />
      <p className="text-muted-foreground text-sm">{message}</p>
      <button
        type="button"
        onClick={onRetry}
        className="text-primary text-sm underline-offset-4 hover:underline"
      >
        Try again
      </button>
    </div>
  );
}
