import { useCallback, useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { Link2, Link2Off, TriangleAlert } from "lucide-react";

import {
  ApiError,
  connectionImpact,
  listConnections,
  listProviderCatalog,
  revokeConnection,
  startConnection,
} from "@/api/client";
import type {
  CredentialMode,
  ProviderCatalogEntry,
  ProviderConnection,
} from "@/api/types";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { cn } from "@/lib/utils";
import { useCan } from "@/rbac/use-can";

/** How each credential mode is named to a person. */
const MODE_LABEL: Record<CredentialMode, string> = {
  pat: "Personal access token",
  oauth2: "OAuth",
  installation_app: "App installation",
};

/**
 * Provider connections (GP-198): one row per provider the backend registry
 * reports, with what this deployment can actually do about it.
 *
 * The list is **generated**, not written: a new adapter on the backend appears
 * here with no change to this file, which is the point of the GP-192 registry.
 * `connectableModes` is the honest per-instance answer — a deployment that
 * registered no GitHub App shows "Token only", not a button that would 422.
 *
 * Connecting, reconnecting and revoking need `integration:manage` (owner/admin);
 * a member sees the same list, read-only, and the API enforces the same rule.
 */
export function OrgConnections() {
  const canManage = useCan("integration:manage");
  const [catalog, setCatalog] = useState<ProviderCatalogEntry[] | null>(null);
  const [connections, setConnections] = useState<ProviderConnection[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [revoking, setRevoking] = useState<ProviderConnection | null>(null);

  const load = useCallback(() => {
    listProviderCatalog()
      .then(setCatalog)
      .catch(() => setCatalog([]));
    listConnections()
      .then(setConnections)
      .catch(() => setConnections([]));
  }, []);
  useEffect(load, [load]);

  async function handleConnect(provider: ProviderCatalogEntry, mode: CredentialMode) {
    setError(null);
    setBusy(provider.id);
    try {
      const { authorizeUrl } = await startConnection({ provider: provider.id, mode });
      window.location.assign(authorizeUrl);
    } catch (err) {
      setError(
        err instanceof ApiError ? err.message : "Could not start the connection.",
      );
      setBusy(null);
    }
  }

  function connectionFor(providerId: string): ProviderConnection | undefined {
    return connections.find((c) => c.provider === providerId);
  }

  if (catalog === null) {
    return (
      <p className="text-muted-foreground text-sm" aria-busy="true">
        Loading…
      </p>
    );
  }

  return (
    <div className="space-y-4">
      <ul className="divide-y divide-border border-border rounded-md border">
        {catalog.map((provider) => {
          const connection = connectionFor(provider.id);
          const connectable = provider.connectableModes[0];
          return (
            <li key={provider.id} className="flex items-center gap-3 px-4 py-3">
              {connection ? (
                <Link2 className="text-muted-foreground size-4 shrink-0" aria-hidden="true" />
              ) : (
                <Link2Off className="text-muted-foreground size-4 shrink-0" aria-hidden="true" />
              )}
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-medium">{provider.label}</p>
                <p className="text-muted-foreground truncate text-xs">
                  {connection
                    ? `${connection.name} · ${MODE_LABEL[connection.mode]}`
                    : connectable
                      ? `Not connected · ${MODE_LABEL[connectable]} available`
                      : "Token only on this instance"}
                </p>
                {connection?.lastError && (
                  <p className="text-destructive truncate text-xs">
                    {connection.lastError}
                  </p>
                )}
              </div>

              <ConnectionStatus connection={connection} connectable={!!connectable} />

              {/* The "and then what?" a connected installation used to lack
                  (GP-230): it can list its repositories, so offer to import
                  them right here rather than making someone find the screen. */}
              {canManage && connection && provider.capabilities.includes("repo:discover") && (
                <Button variant="outline" size="sm" asChild>
                  <Link to="/import">Import repositories</Link>
                </Button>
              )}

              {canManage && connectable && (
                <div className="flex items-center gap-1">
                  <Button
                    variant={connection ? "outline" : "default"}
                    size="sm"
                    disabled={busy === provider.id}
                    onClick={() => void handleConnect(provider, connectable)}
                  >
                    {connection ? "Reconnect" : "Connect"}
                  </Button>
                  {connection && (
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => setRevoking(connection)}
                    >
                      Revoke
                    </Button>
                  )}
                </div>
              )}
            </li>
          );
        })}
      </ul>

      {error && (
        <p className="text-destructive text-sm" role="alert">
          {error}
        </p>
      )}

      {revoking && (
        <RevokeDialog
          connection={revoking}
          onClose={() => setRevoking(null)}
          onRevoked={(id) => {
            setConnections((prev) => prev.filter((c) => c.id !== id));
            setRevoking(null);
          }}
        />
      )}
    </div>
  );
}

/**
 * The one-word answer, in the same pill vocabulary as every other status in the
 * app (GP-11's badge): green only for a confident yes, destructive only when a
 * human must act, quiet otherwise.
 */
function ConnectionStatus({
  connection,
  connectable,
}: Readonly<{ connection: ProviderConnection | undefined; connectable: boolean }>) {
  const pill =
    "inline-flex shrink-0 items-center rounded-sm border px-2 py-0.5 font-mono text-xs";
  if (!connection) {
    return (
      <span className={cn(pill, "border-border bg-muted text-muted-foreground")}>
        {connectable ? "Not connected" : "Not configured"}
      </span>
    );
  }
  if (connection.status === "reconnect_required") {
    return (
      <span
        className={cn(pill, "border-destructive/30 bg-destructive/5 text-destructive")}
      >
        Reconnect required
      </span>
    );
  }
  return (
    <span className={cn(pill, "border-create bg-create text-white")}>Connected</span>
  );
}

/**
 * Revoking is destructive to *other* things, so it says what before it asks.
 * The repositories listed do not disappear: each falls back to its own token,
 * or reports that it has none — honest degradation, which is what the dialog
 * promises rather than implying a cascade.
 */
function RevokeDialog({
  connection,
  onClose,
  onRevoked,
}: Readonly<{
  connection: ProviderConnection;
  onClose: () => void;
  onRevoked: (id: string) => void;
}>) {
  const [affected, setAffected] = useState<{ id: string; url: string }[] | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    connectionImpact(connection.id)
      .then((impact) => setAffected(impact.repositories))
      .catch(() => setAffected([]));
  }, [connection.id]);

  async function handleRevoke() {
    setSubmitting(true);
    setError(null);
    try {
      await revokeConnection(connection.id);
      onRevoked(connection.id);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not revoke it.");
      setSubmitting(false);
    }
  }

  return (
    <Dialog open onOpenChange={(next) => (next ? undefined : onClose())}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle className="font-display">Revoke {connection.name}?</DialogTitle>
          <DialogDescription>
            Groundplan stops using this connection. Nothing is deleted.
          </DialogDescription>
        </DialogHeader>

        {affected === null ? (
          <p className="text-muted-foreground text-sm" aria-busy="true">
            Checking what uses it…
          </p>
        ) : affected.length === 0 ? (
          <p className="text-muted-foreground text-sm">
            No repository authenticates through it.
          </p>
        ) : (
          <div className="space-y-2">
            <p className="flex items-start gap-2 text-sm">
              <TriangleAlert className="text-impacted mt-0.5 size-4 shrink-0" aria-hidden="true" />
              <span>
                {affected.length} repositor{affected.length === 1 ? "y" : "ies"} use
                it. Each falls back to its own access token, or stops updating
                until one is set.
              </span>
            </p>
            <ul className="text-muted-foreground max-h-40 overflow-y-auto font-mono text-xs">
              {affected.map((repo) => (
                <li key={repo.id} className="truncate">
                  {repo.url}
                </li>
              ))}
            </ul>
          </div>
        )}

        {error && (
          <p className="text-destructive text-sm" role="alert">
            {error}
          </p>
        )}

        <div className="flex justify-end gap-2">
          <Button type="button" variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button
            type="button"
            variant="destructive"
            disabled={submitting || affected === null}
            onClick={() => void handleRevoke()}
          >
            {submitting ? "Revoking…" : "Revoke"}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
