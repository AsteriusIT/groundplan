/**
 * "Import repositories" (GP-230) — the answer to *and then what?*
 *
 * Connecting a GitHub App used to lead nowhere: the installation showed as
 * connected and the only way to attach anything was still to retype a URL the
 * backend already knew. This screen is the missing half — attaching becomes an
 * act of **selection**, not of typing.
 *
 * Two ideas govern the design:
 *
 *  - **The type is chosen per row, and choosing is compulsory.** It is immutable
 *    after import (GP-100), so detection (GP-228) pre-selects only when it is
 *    confident, leaves the control empty when it is not, and the import button
 *    stays disabled until every selected row has one. The warning about
 *    irreversibility is shown *before* the click, not after.
 *  - **A monorepo is two imports, never a "mixed" type.** When detection finds
 *    both families the row says so and offers, in one click, a second row for
 *    the same repository with the other type and a different path.
 *
 * The result of an import is reported exactly as the server gave it: imported,
 * skipped (already attached — quietly, not as an error) and failed with a
 * reason per row, so a partial success can be finished rather than restarted.
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import {
  ArrowLeft,
  Check,
  GitBranch,
  Lock,
  RefreshCw,
  Search,
  TriangleAlert,
} from "lucide-react";

import {
  ApiError,
  detectRepositoryKinds,
  discoverRepositories,
  importRepositories,
  listConnections,
  listProjects,
  listProviderCatalog,
} from "@/api/client";
import type {
  DiscoveredRepository,
  IacType,
  ImportResult,
  Project,
  Provider,
  RepoKindDetection,
} from "@/api/types";
import { Button } from "@/components/ui/button";
import { Chip } from "@/components/ui/chip";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { IAC_TYPES, IAC_TYPE_LABELS } from "@/lib/iac-type";
import {
  importableProviders,
  type ImportableProvider,
} from "@/lib/importable-providers";
import { cn } from "@/lib/utils";
import { useCan } from "@/rbac/use-can";

/** How long we wait after a keystroke before asking the server (GP-227). */
const SEARCH_DEBOUNCE_MS = 300;

/**
 * One row the user has selected. Keyed separately from the repository so the
 * same repository can appear twice — the monorepo, imported once per type.
 */
type Selection = {
  key: string;
  fullName: string;
  cloneUrl: string;
  defaultBranch: string;
  /** Null until the user (or a confident detection) has chosen. */
  kind: IacType | null;
  path: string;
  /** Set when the type came from detection, so the row can say "detected". */
  detected: boolean;
  /**
   * The user has picked a type here. Detection must never overwrite that — it
   * arrives asynchronously, and a value that changes under the cursor on an
   * irreversible choice is the worst thing this screen could do.
   */
  touched: boolean;
};

type LoadState =
  | { status: "loading" }
  | { status: "error"; message: string; code?: string }
  | { status: "ready" };

export function ImportRepositoriesPage() {
  const canManage = useCan("project:manage");
  const navigate = useNavigate();
  const [params] = useSearchParams();

  const [projects, setProjects] = useState<Project[]>([]);
  const [projectId, setProjectId] = useState(params.get("project") ?? "");

  /**
   * Which provider we are importing from (GP-232). Read, never assumed: the
   * backend route has always been `:provider`, and this screen used to name
   * GitHub in three places — which made the port's promise ("a new adapter
   * costs no frontend change") untrue of the only screen that used it.
   */
  const [importable, setImportable] = useState<ImportableProvider[] | null>(null);
  const [provider, setProvider] = useState<Provider | null>(
    (params.get("provider") as Provider | null) ?? null,
  );

  const [state, setState] = useState<LoadState>({ status: "loading" });
  /**
   * The connection that answered discovery. Sent back with the import so the
   * server authenticates with *the connection that listed the repository*
   * rather than re-deriving one from the URL — which is guesswork we do not
   * need to do here, and got wrong for GitLab.
   */
  const [credentialId, setCredentialId] = useState<string | null>(null);
  const [repos, setRepos] = useState<DiscoveredRepository[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [total, setTotal] = useState(0);
  const [loadingMore, setLoadingMore] = useState(false);

  const [search, setSearch] = useState("");
  const [debounced, setDebounced] = useState("");
  const [hideArchived, setHideArchived] = useState(true);
  const [hideImported, setHideImported] = useState(false);

  const [detections, setDetections] = useState<Map<string, RepoKindDetection>>(
    new Map(),
  );
  const [selection, setSelection] = useState<Map<string, Selection>>(new Map());
  const [submitting, setSubmitting] = useState(false);
  const [result, setResult] = useState<ImportResult | null>(null);

  useEffect(() => {
    listProjects()
      .then((rows) => {
        setProjects(rows);
        // One project is not a choice; pre-select it rather than asking.
        setProjectId((current) => current || (rows.length === 1 ? rows[0]!.id : ""));
      })
      .catch(() => setProjects([]));
  }, []);

  useEffect(() => {
    if (!canManage) return;
    Promise.all([listProviderCatalog(), listConnections()])
      .then(([catalog, connections]) => {
        const options = importableProviders(catalog, connections);
        setImportable(options);
        // A single importable provider is not a choice; only offer one when
        // there genuinely is one to make.
        setProvider((current) => {
          if (current && options.some((o) => o.id === current)) return current;
          return options[0]?.id ?? null;
        });
      })
      .catch(() => setImportable([]));
  }, [canManage]);

  useEffect(() => {
    const timer = setTimeout(() => setDebounced(search.trim()), SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [search]);

  const load = useCallback(async (term: string, from: Provider) => {
    setState({ status: "loading" });
    try {
      const page = await discoverRepositories(from, { search: term });
      setCredentialId(page.credentialId);
      setRepos(page.repositories);
      setCursor(page.nextCursor);
      setTotal(page.total);
      setState({ status: "ready" });
    } catch (err) {
      setState({
        status: "error",
        message:
          err instanceof ApiError ? err.message : "Could not list repositories.",
        ...(err instanceof ApiError && err.code ? { code: err.code } : {}),
      });
    }
  }, []);

  /**
   * Switching provider starts over. A selection carried across would import
   * GitHub rows while the screen shows GitLab ones — the counter would even
   * look right. (A *search* change deliberately keeps the selection: that is
   * the same estate, filtered.)
   */
  useEffect(() => {
    setSelection(new Map());
    setDetections(new Map());
    setResult(null);
  }, [provider]);

  useEffect(() => {
    // A member cannot import, so nothing here should call an API on their
    // behalf — the screen says so instead of listing what they cannot use.
    if (!canManage || !provider) return;
    void load(debounced, provider);
  }, [load, debounced, canManage, provider]);

  /**
   * Detection is lazy and per page (GP-228): the repositories on screen, and
   * only the ones we have not already asked about.
   */
  useEffect(() => {
    const pending = repos.filter((repo) => !detections.has(repo.fullName));
    if (pending.length === 0) return;
    let cancelled = false;
    if (!provider) return;
    detectRepositoryKinds(
      provider,
      pending.map((repo) => ({
        owner: repo.owner,
        name: repo.name,
        ref: repo.defaultBranch,
      })),
    )
      .then(({ detections: found }) => {
        if (cancelled) return;
        setDetections((current) => {
          const next = new Map(current);
          for (const detection of found) next.set(detection.fullName, detection);
          return next;
        });
      })
      // Detection is a convenience: without it every row simply asks the user.
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [repos, detections, provider]);

  /**
   * A detection that lands *after* a row was selected still pre-fills it — the
   * user should not be punished for clicking quickly. A row they have already
   * typed themselves is never touched: the choice is irreversible, and a value
   * that changes under the cursor would be the worst thing this screen could do.
   */
  useEffect(() => {
    setSelection((current) => {
      let changed = false;
      const next = new Map(current);
      for (const [key, row] of current) {
        if (row.touched || row.kind !== null) continue;
        const detection = detections.get(row.fullName);
        if (detection?.confidence !== "high" || detection.kind === null) continue;
        next.set(key, {
          ...row,
          kind: detection.kind,
          path: row.path || (detection.suggestedPath ?? ""),
          detected: true,
        });
        changed = true;
      }
      return changed ? next : current;
    });
  }, [detections]);

  async function loadMore() {
    if (!cursor || !provider) return;
    setLoadingMore(true);
    try {
      const page = await discoverRepositories(provider, {
        search: debounced,
        cursor,
      });
      setRepos((current) => [...current, ...page.repositories]);
      setCursor(page.nextCursor);
    } catch {
      setCursor(null);
    } finally {
      setLoadingMore(false);
    }
  }

  const visible = useMemo(
    () =>
      repos.filter((repo) => {
        if (hideArchived && repo.archived) return false;
        if (hideImported && repo.attachments.length > 0) return false;
        return true;
      }),
    [repos, hideArchived, hideImported],
  );

  function selectionsFor(fullName: string): Selection[] {
    return [...selection.values()].filter((row) => row.fullName === fullName);
  }

  function toggle(repo: DiscoveredRepository) {
    setSelection((current) => {
      const next = new Map(current);
      const mine = [...next.values()].filter((row) => row.fullName === repo.fullName);
      if (mine.length > 0) {
        for (const row of mine) next.delete(row.key);
        return next;
      }
      next.set(repo.fullName, newSelection(repo, detections.get(repo.fullName)));
      return next;
    });
  }

  function selectAllOnPage() {
    setSelection((current) => {
      const next = new Map(current);
      const everySelected = visible.every((repo) =>
        [...next.values()].some((row) => row.fullName === repo.fullName),
      );
      for (const repo of visible) {
        const mine = [...next.values()].filter((r) => r.fullName === repo.fullName);
        if (everySelected) {
          for (const row of mine) next.delete(row.key);
        } else if (mine.length === 0) {
          next.set(repo.fullName, newSelection(repo, detections.get(repo.fullName)));
        }
      }
      return next;
    });
  }

  function patch(key: string, changes: Partial<Selection>) {
    setSelection((current) => {
      const row = current.get(key);
      if (!row) return current;
      const next = new Map(current);
      next.set(key, { ...row, ...changes });
      return next;
    });
  }

  /** The monorepo affordance: the same repository again, with the other type. */
  function addSecondRow(repo: DiscoveredRepository, existing: Selection) {
    const other: IacType = existing.kind === "terraform" ? "kubernetes" : "terraform";
    setSelection((current) => {
      const next = new Map(current);
      const key = `${repo.fullName}::${next.size}-${other}`;
      next.set(key, {
        key,
        fullName: repo.fullName,
        cloneUrl: repo.cloneUrl,
        defaultBranch: repo.defaultBranch,
        kind: existing.kind ? other : null,
        path: "",
        detected: false,
        touched: true,
      });
      return next;
    });
  }

  const rows = [...selection.values()];
  const incomplete = rows.filter((row) => row.kind === null).length;
  const canImport =
    canManage && rows.length > 0 && incomplete === 0 && projectId !== "" && !submitting;

  async function handleImport(only?: Selection[]) {
    const batch = only ?? rows;
    setSubmitting(true);
    try {
      const outcome = await importRepositories({
        projectId,
        ...(credentialId ? { credentialId } : {}),
        items: batch.map((row) => ({
          cloneUrl: row.cloneUrl,
          kind: row.kind as IacType,
          ...(row.path.trim() ? { path: row.path.trim() } : {}),
          defaultBranch: row.defaultBranch,
        })),
      });
      setResult(outcome);
      // Keep only what failed, so "retry the failures" is the same button.
      const failedNames = new Set(
        outcome.failed
          .map((entry) => entry.item.cloneUrl)
          .filter((url): url is string => url !== undefined),
      );
      setSelection((current) => {
        const next = new Map<string, Selection>();
        for (const [key, row] of current) {
          if (failedNames.has(row.cloneUrl)) next.set(key, row);
        }
        return next;
      });
      if (provider) await load(debounced, provider);
    } catch (err) {
      setState({
        status: "error",
        message: err instanceof ApiError ? err.message : "The import failed.",
      });
    } finally {
      setSubmitting(false);
    }
  }

  if (!canManage) {
    return (
      <div className="mx-auto max-w-2xl px-6 py-16 text-center">
        <h1 className="font-display text-lg font-semibold">Import repositories</h1>
        <p className="text-muted-foreground mt-2 text-sm">
          An admin can import repositories for this organization.
        </p>
      </div>
    );
  }

  // Nothing connected can list: say that, rather than showing an empty screen
  // that reads as "you have no repositories".
  if (importable !== null && importable.length === 0) {
    return (
      <div className="mx-auto max-w-2xl px-6 py-16 text-center">
        <h1 className="font-display text-lg font-semibold">Import repositories</h1>
        <p className="text-muted-foreground mt-2 text-sm">
          No connected provider on this instance can list repositories. Connect
          one from your organization settings, or attach a repository by URL.
        </p>
        <div className="mt-4">
          <Button variant="outline" size="sm" asChild>
            <Link to="/settings">Organization settings</Link>
          </Button>
        </div>
      </div>
    );
  }

  const current = importable?.find((option) => option.id === provider);

  return (
    <div className="mx-auto w-full max-w-4xl px-6 py-8">
      <div className="mb-6 space-y-2">
        <button
          type="button"
          onClick={() => navigate(-1)}
          className="text-muted-foreground hover:text-foreground flex items-center gap-1 text-xs"
        >
          <ArrowLeft className="size-3" aria-hidden="true" />
          Back
        </button>
        <h1 className="font-display text-xl font-semibold">Import repositories</h1>
        <p className="text-muted-foreground text-sm">
          {/* Named after the connection, never after an "organization scope":
              a GitLab token lists what its account can reach, which is not the
              same promise a GitHub App installation makes (GP-232). */}
          Pick what your {current?.label ?? "provider"} connection can reach. No
          URLs, no tokens.
        </p>
      </div>

      {/* Only a real choice is offered as one. */}
      {importable && importable.length > 1 && (
        <div className="mb-4 flex items-center gap-2">
          <span className="text-muted-foreground text-xs">Import from</span>
          <fieldset className="flex gap-1" aria-label="Provider">
            {importable.map((option) => (
              <button
                key={option.id}
                type="button"
                aria-pressed={provider === option.id}
                onClick={() => setProvider(option.id)}
                className={cn(
                  "rounded-md border px-3 py-1.5 text-sm transition-colors",
                  provider === option.id
                    ? "border-primary bg-accent-soft text-primary"
                    : "border-border text-muted-foreground hover:text-foreground",
                )}
              >
                {option.label}
              </button>
            ))}
          </fieldset>
        </div>
      )}

      {result && <ImportSummary result={result} onRetry={() => void handleImport()} />}

      <div className="space-y-4">
        <div className="grid gap-4 sm:grid-cols-2">
          <div className="space-y-2">
            <Label htmlFor="import-project">Project</Label>
            <select
              id="import-project"
              value={projectId}
              onChange={(e) => setProjectId(e.target.value)}
              className="border-border bg-background text-foreground focus-visible:ring-ring w-full rounded-md border px-2 py-1.5 text-sm focus-visible:ring-2 focus-visible:outline-none"
            >
              <option value="">Choose a project…</option>
              {projects.map((project) => (
                <option key={project.id} value={project.id}>
                  {project.name}
                </option>
              ))}
            </select>
          </div>
          <div className="space-y-2">
            <Label htmlFor="import-search">Search</Label>
            <div className="relative">
              <Search
                className="text-muted-foreground pointer-events-none absolute top-1/2 left-2 size-4 -translate-y-1/2"
                aria-hidden="true"
              />
              <Input
                id="import-search"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="owner/name"
                autoComplete="off"
                className="pl-8"
              />
            </div>
          </div>
        </div>

        <div className="text-muted-foreground flex flex-wrap items-center gap-4 text-xs">
          <label className="flex items-center gap-1.5">
            <input
              type="checkbox"
              checked={hideArchived}
              onChange={(e) => setHideArchived(e.target.checked)}
            />
            Hide archived
          </label>
          <label className="flex items-center gap-1.5">
            <input
              type="checkbox"
              checked={hideImported}
              onChange={(e) => setHideImported(e.target.checked)}
            />
            Hide already imported
          </label>
          {state.status === "ready" && (
            <span className="font-mono">
              {visible.length} of {total} shown
            </span>
          )}
        </div>

        {state.status === "loading" && (
          <p className="text-muted-foreground text-sm" aria-busy="true">
            Loading repositories…
          </p>
        )}

        {state.status === "error" && <DiscoveryError state={state} onRetry={() => provider && void load(debounced, provider)} />}

        {state.status === "ready" && visible.length === 0 && (
          <EmptyScope filtered={repos.length > 0} />
        )}

        {state.status === "ready" && visible.length > 0 && (
          <>
            <div className="flex items-center justify-between gap-3">
              <Button variant="ghost" size="sm" onClick={selectAllOnPage}>
                Select all on this page
              </Button>
              <span className="text-muted-foreground text-xs" data-testid="selection-count">
                {rows.length} selected
              </span>
            </div>

            <ul className="divide-border border-border divide-y rounded-md border">
              {visible.map((repo) => (
                <RepoRow
                  key={repo.externalId}
                  repo={repo}
                  detection={detections.get(repo.fullName)}
                  selections={selectionsFor(repo.fullName)}
                  onToggle={() => toggle(repo)}
                  onPatch={patch}
                  onAddSecondRow={(existing) => addSecondRow(repo, existing)}
                />
              ))}
            </ul>

            {cursor && (
              <Button
                variant="outline"
                size="sm"
                onClick={() => void loadMore()}
                disabled={loadingMore}
              >
                {loadingMore ? "Loading…" : "Load more"}
              </Button>
            )}
          </>
        )}

        <div className="border-border flex flex-wrap items-center justify-between gap-3 border-t pt-4">
          <p className="text-muted-foreground max-w-md text-xs">
            The type cannot be changed after the import. A repository holding both
            Terraform and manifests is imported twice, with a different path.
          </p>
          <div className="flex items-center gap-3">
            {incomplete > 0 && (
              <span className="text-muted-foreground text-xs" role="status">
                {incomplete} selected {incomplete === 1 ? "row needs" : "rows need"} a type
              </span>
            )}
            {projectId === "" && rows.length > 0 && (
              <span className="text-muted-foreground text-xs">Choose a project</span>
            )}
            <Button
              data-testid="import-submit"
              disabled={!canImport}
              onClick={() => void handleImport()}
            >
              {submitting ? "Importing…" : `Import ${rows.length || ""}`.trim()}
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}

/** A fresh selection, pre-filled only when detection was confident (GP-228). */
function newSelection(
  repo: DiscoveredRepository,
  detection: RepoKindDetection | undefined,
): Selection {
  const confident = detection?.confidence === "high" && detection.kind !== null;
  return {
    key: repo.fullName,
    fullName: repo.fullName,
    cloneUrl: repo.cloneUrl,
    defaultBranch: repo.defaultBranch,
    kind: confident ? detection.kind : null,
    path: confident ? (detection.suggestedPath ?? "") : "",
    detected: confident,
    touched: false,
  };
}

function RepoRow({
  repo,
  detection,
  selections,
  onToggle,
  onPatch,
  onAddSecondRow,
}: Readonly<{
  repo: DiscoveredRepository;
  detection: RepoKindDetection | undefined;
  selections: Selection[];
  onToggle: () => void;
  onPatch: (key: string, changes: Partial<Selection>) => void;
  onAddSecondRow: (existing: Selection) => void;
}>) {
  const selected = selections.length > 0;
  // Both families of signal: not a type, an invitation to import twice.
  const monorepo =
    detection?.kind === null && detection.evidence.length > 0 && !detection.truncated;

  return (
    <li className="px-4 py-3">
      <div className="flex items-start gap-3">
        <input
          type="checkbox"
          checked={selected}
          onChange={onToggle}
          aria-label={`Select ${repo.fullName}`}
          className="mt-1"
        />
        <div className="min-w-0 flex-1 space-y-1">
          <div className="flex flex-wrap items-center gap-2">
            <span className="truncate font-mono text-sm">{repo.fullName}</span>
            {repo.private && (
              <Lock className="text-muted-foreground size-3" aria-label="Private" />
            )}
            {repo.archived && <Chip>Archived</Chip>}
            {repo.attachments.length > 0 && (
              <Chip variant="accent">
                Already imported ·{" "}
                {repo.attachments.map((a) => IAC_TYPE_LABELS[a.kind]).join(", ")}
              </Chip>
            )}
          </div>
          <p className="text-muted-foreground flex flex-wrap items-center gap-3 text-xs">
            <span className="flex items-center gap-1">
              <GitBranch className="size-3" aria-hidden="true" />
              {repo.defaultBranch}
            </span>
            {repo.updatedAt && (
              <span>Updated {new Date(repo.updatedAt).toLocaleDateString()}</span>
            )}
          </p>

          {selected && monorepo && (
            <p className="text-muted-foreground bg-muted/40 rounded-sm px-2 py-1.5 text-xs">
              This repository holds both Terraform and manifests — import it once
              per type, with a different path.
            </p>
          )}

          {selections.map((row) => (
            <SelectionControls
              key={row.key}
              row={row}
              detection={detection}
              onPatch={onPatch}
              onAddSecondRow={() => onAddSecondRow(row)}
              canAddSecondRow={selections.length === 1}
            />
          ))}
        </div>
      </div>
    </li>
  );
}

function SelectionControls({
  row,
  detection,
  onPatch,
  onAddSecondRow,
  canAddSecondRow,
}: Readonly<{
  row: Selection;
  detection: RepoKindDetection | undefined;
  onPatch: (key: string, changes: Partial<Selection>) => void;
  onAddSecondRow: () => void;
  canAddSecondRow: boolean;
}>) {
  return (
    <div className="border-border mt-2 flex flex-wrap items-center gap-2 border-l pl-3">
      <fieldset
        aria-label={`Type for ${row.fullName}`}
        className="flex gap-1"
      >
        {IAC_TYPES.map(({ id, label }) => (
          <button
            key={id}
            type="button"
            aria-pressed={row.kind === id}
            onClick={() => onPatch(row.key, { kind: id, detected: false, touched: true })}
            className={cn(
              "rounded-md border px-2 py-1 text-xs transition-colors",
              row.kind === id
                ? "border-primary bg-accent-soft text-primary"
                : "border-border text-muted-foreground hover:text-foreground",
            )}
          >
            {label}
          </button>
        ))}
      </fieldset>

      {row.detected && (
        <span className="text-muted-foreground text-xs" title={detection?.evidence.join(", ")}>
          detected
        </span>
      )}
      {row.kind === null && (
        <span className="text-muted-foreground text-xs">Choose a type</span>
      )}

      <Input
        value={row.path}
        onChange={(e) => onPatch(row.key, { path: e.target.value })}
        placeholder="Path (optional)"
        aria-label={`Path for ${row.fullName}`}
        className="h-7 w-40 text-xs"
      />

      {canAddSecondRow && (
        <Button variant="ghost" size="sm" onClick={onAddSecondRow}>
          Import twice
        </Button>
      )}
    </div>
  );
}

/**
 * A discovery failure, with the remediation that matches it. An empty list is
 * never one of these — that is a different, and much less alarming, fact.
 */
function DiscoveryError({
  state,
  onRetry,
}: Readonly<{
  state: { message: string; code?: string };
  onRetry: () => void;
}>) {
  const remediation = (() => {
    switch (state.code) {
      case "installation_revoked":
        return "Reconnect the GitHub App from your organization settings.";
      case "installation_not_linked":
        return "Connect the GitHub App to this organization first.";
      case "insufficient_permissions":
        return "Review what the app is allowed to read on GitHub.";
      case "multiple_connections":
        return "This organization has several connections — pick one from settings.";
      default:
        return null;
    }
  })();

  return (
    <div
      role="alert"
      className="border-destructive/30 bg-destructive/5 space-y-2 rounded-md border px-4 py-3"
    >
      <p className="flex items-center gap-2 text-sm">
        <TriangleAlert className="text-destructive size-4" aria-hidden="true" />
        {state.message}
      </p>
      {remediation && <p className="text-muted-foreground text-xs">{remediation}</p>}
      <div className="flex items-center gap-2">
        <Button variant="outline" size="sm" onClick={onRetry}>
          <RefreshCw className="size-3" aria-hidden="true" />
          Try again
        </Button>
        <Button variant="ghost" size="sm" asChild>
          <Link to="/settings">Organization settings</Link>
        </Button>
      </div>
    </div>
  );
}

function EmptyScope({ filtered }: Readonly<{ filtered: boolean }>) {
  if (filtered) {
    return (
      <p className="text-muted-foreground text-sm">
        Nothing matches the current filters.
      </p>
    );
  }
  return (
    <div className="border-border rounded-md border border-dashed px-6 py-10 text-center">
      <p className="text-sm">This installation does not cover any repository.</p>
      <p className="text-muted-foreground mt-1 text-xs">
        Adjust which repositories the app can access on GitHub, then come back.
      </p>
    </div>
  );
}

/** The outcome, exactly as the server reported it — partial success included. */
function ImportSummary({
  result,
  onRetry,
}: Readonly<{ result: ImportResult; onRetry: () => void }>) {
  return (
    <div className="border-border mb-6 space-y-2 rounded-md border px-4 py-3" role="status">
      <p className="flex items-center gap-2 text-sm">
        <Check className="text-create size-4" aria-hidden="true" />
        {result.imported.length} imported · {result.skipped.length} already
        attached · {result.failed.length} failed
      </p>
      {result.failed.length > 0 && (
        <>
          <ul className="text-muted-foreground space-y-1 text-xs">
            {result.failed.map((entry) => (
              <li key={entry.item.cloneUrl ?? entry.item.fullName}>
                <span className="font-mono">
                  {entry.item.cloneUrl ?? entry.item.fullName}
                </span>
                {" — "}
                {entry.error}
              </li>
            ))}
          </ul>
          <Button variant="outline" size="sm" onClick={onRetry}>
            Retry the failures
          </Button>
        </>
      )}
    </div>
  );
}
