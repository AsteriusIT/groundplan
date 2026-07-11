import { useCallback, useEffect, useState } from "react";
import { Link, useParams } from "react-router-dom";
import {
  ChevronLeft,
  FileText,
  Loader2,
  RefreshCw,
  TriangleAlert,
} from "lucide-react";

import {
  ApiError,
  generateDocs,
  getLatestDocs,
  getRepository,
  getSnapshot,
} from "@/api/client";
import type { Repository, Snapshot } from "@/api/types";
import { formatDate, repoName } from "@/lib/format";
import { Button } from "@/components/ui/button";
import { GraphCanvas } from "@/components/graph-canvas";

type DocsState =
  | { status: "loading" }
  | { status: "empty" }
  | { status: "error"; message: string }
  | { status: "ready"; snapshot: Snapshot };

const shortSha = (sha: string) => sha.slice(0, 8);

export function DocsPage() {
  const { id, repoId } = useParams<{ id: string; repoId: string }>();
  const [repo, setRepo] = useState<Repository | null>(null);
  const [state, setState] = useState<DocsState>({ status: "loading" });
  const [generating, setGenerating] = useState(false);
  const [genError, setGenError] = useState<string | null>(null);

  const load = useCallback(() => {
    if (!repoId) return;
    setState({ status: "loading" });
    getRepository(repoId)
      .then(setRepo)
      .catch(() => {});
    getLatestDocs(repoId)
      .then((snapshot) => setState({ status: "ready", snapshot }))
      .catch((err) => {
        if (err instanceof ApiError && err.status === 404) {
          setState({ status: "empty" });
        } else {
          setState({
            status: "error",
            message:
              err instanceof ApiError ? err.message : "Could not load documentation.",
          });
        }
      });
  }, [repoId]);

  useEffect(() => {
    load();
  }, [load]);

  const generate = useCallback(async () => {
    if (!repoId) return;
    setGenerating(true);
    setGenError(null);
    try {
      const { id: snapshotId } = await generateDocs(repoId);
      const snapshot = await getSnapshot(snapshotId);
      setState({ status: "ready", snapshot });
    } catch (err) {
      if (err instanceof ApiError && err.status === 409) {
        setGenError(
          "A documentation run is already in progress — try again in a moment.",
        );
      } else {
        setGenError(
          err instanceof ApiError ? err.message : "Could not generate documentation.",
        );
      }
    } finally {
      setGenerating(false);
    }
  }, [repoId]);

  const snapshot = state.status === "ready" ? state.snapshot : null;

  return (
    <div className="flex h-full flex-col">
      <header className="bg-card border-b border-border px-8 py-5">
        <Link
          to={`/projects/${id}`}
          className="text-muted-foreground hover:text-foreground mb-3 inline-flex items-center gap-1 text-sm"
        >
          <ChevronLeft className="size-4" />
          Back to project
        </Link>
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div className="min-w-0">
            <p className="text-muted-foreground font-mono text-[11px] tracking-[0.14em] uppercase">
              Documentation · {repo?.defaultBranch ?? "main"}
            </p>
            <h1 className="font-display text-xl font-semibold">
              {repo ? repoName(repo.url) : "Documentation"}
            </h1>
            {snapshot && (
              <p className="text-muted-foreground mt-1 font-mono text-xs">
                {shortSha(snapshot.commitSha)} · generated{" "}
                {formatDate(snapshot.createdAt)}
              </p>
            )}
          </div>
          {snapshot && (
            <Button variant="outline" onClick={generate} disabled={generating}>
              <RefreshCw
                className={generating ? "size-4 animate-spin" : "size-4"}
              />
              {generating ? "Regenerating…" : "Regenerate"}
            </Button>
          )}
        </div>
        {genError && (
          <p className="text-destructive mt-3 text-sm" role="alert">
            {genError}
          </p>
        )}
      </header>

      <div className="blueprint-grid relative min-h-0 flex-1">
        {state.status === "loading" && <Centered>Loading documentation…</Centered>}

        {state.status === "error" && (
          <Centered>
            <ErrorBlock message={state.message} onRetry={load} />
          </Centered>
        )}

        {state.status === "empty" && (
          <EmptyState generating={generating} onGenerate={generate} />
        )}

        {snapshot && (
          <>
            {snapshot.stats.warnings && snapshot.stats.warnings.length > 0 && (
              <WarningsNotice warnings={snapshot.stats.warnings} />
            )}
            <GraphCanvas graph={snapshot.graph} variant="docs" />
          </>
        )}
      </div>
    </div>
  );
}

function WarningsNotice({ warnings }: { warnings: string[] }) {
  return (
    <details className="bg-card/90 absolute top-3 left-3 z-10 max-w-sm rounded-md border border-amber-300 backdrop-blur">
      <summary className="flex cursor-pointer items-center gap-2 px-3 py-2 text-sm text-amber-800">
        <TriangleAlert className="size-4" />
        {warnings.length} file{warnings.length === 1 ? "" : "s"} skipped
      </summary>
      <ul className="border-t border-amber-200 px-3 py-2 font-mono text-xs">
        {warnings.map((warning) => (
          <li key={warning} className="text-muted-foreground break-all">
            {warning}
          </li>
        ))}
      </ul>
    </details>
  );
}

function EmptyState({
  generating,
  onGenerate,
}: {
  generating: boolean;
  onGenerate: () => void;
}) {
  return (
    <div className="grid h-full place-items-center p-8">
      <div className="max-w-md text-center">
        <div className="bg-accent text-primary mx-auto mb-4 grid size-12 place-items-center rounded-sm">
          <FileText className="size-6" />
        </div>
        <h2 className="font-display text-lg font-semibold">
          Document this repository
        </h2>
        <p className="text-muted-foreground mt-2 text-sm">
          Groundplan clones the default branch and statically parses its Terraform
          into a resource diagram — no plan required.
        </p>
        <Button className="mt-5" onClick={onGenerate} disabled={generating}>
          {generating ? (
            <Loader2 className="size-4 animate-spin" />
          ) : (
            <FileText className="size-4" />
          )}
          {generating ? "Generating…" : "Generate documentation"}
        </Button>
      </div>
    </div>
  );
}

function Centered({ children }: { children: React.ReactNode }) {
  return (
    <div className="text-muted-foreground grid h-full place-items-center p-8 text-sm">
      {children}
    </div>
  );
}

function ErrorBlock({
  message,
  onRetry,
}: {
  message: string;
  onRetry: () => void;
}) {
  return (
    <div
      role="alert"
      className="border-destructive/30 bg-destructive/5 flex max-w-md flex-col items-center gap-4 rounded-md border px-8 py-12 text-center"
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
