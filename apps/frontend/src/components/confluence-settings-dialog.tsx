import { type SubmitEvent, useEffect, useState } from "react";
import { Link } from "react-router-dom";

import {
  ApiError,
  deleteConfluenceConnection,
  getConfluenceConnection,
  listIntegrations,
  saveConfluenceConnection,
} from "@/api/client";
import type {
  ConfluenceConnection,
  Integration,
  Repository,
} from "@/api/types";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { ConnectionStatusBadge } from "@/components/connection-status";
import { cn } from "@/lib/utils";
import { useOrg } from "@/org/use-org";
import { useCan } from "@/rbac/use-can";

/**
 * Where this repository's docs page publishes to (GP-179; simplified by GP-184):
 * pick one of the organization's Atlassian integrations — which holds the
 * credential — plus the space key. No credential lives here anymore; it is
 * configured once per org in organization settings.
 *
 * Controlled (no trigger): it opens from the card's overflow menu, which
 * unmounts on select.
 */
export function ConfluenceSettingsDialog({
  repository,
  open,
  onOpenChange,
}: Readonly<{
  repository: Repository;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}>) {
  const { activeOrg } = useOrg();
  const canManageIntegrations = useCan("integration:manage");
  const [connection, setConnection] = useState<ConfluenceConnection | null>(null);
  const [integrations, setIntegrations] = useState<Integration[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [integrationId, setIntegrationId] = useState("");
  const [spaceKey, setSpaceKey] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Re-fetch each time it opens: the target may have been published to or
  // removed, and the org's integrations may have changed, since last time.
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setLoaded(false);
    setError(null);
    Promise.all([getConfluenceConnection(repository.id), listIntegrations()])
      .then(([conn, list]) => {
        if (cancelled) return;
        const atlassian = list.filter((i) => i.type === "atlassian");
        setConnection(conn);
        setIntegrations(atlassian);
        setIntegrationId(conn?.integrationId ?? atlassian[0]?.id ?? "");
        setSpaceKey(conn?.spaceKey ?? "");
        setLoaded(true);
      })
      .catch(() => {
        if (cancelled) return;
        setConnection(null);
        setIntegrations([]);
        setIntegrationId("");
        setSpaceKey("");
        setLoaded(true);
      });
    return () => {
      cancelled = true;
    };
  }, [open, repository.id]);

  function handleOpenChange(next: boolean) {
    onOpenChange(next);
    if (!next) {
      setError(null);
      setSubmitting(false);
    }
  }

  const incomplete = !integrationId || !spaceKey.trim();
  const selected = integrations.find((i) => i.id === integrationId);

  async function handleSubmit(event: SubmitEvent) {
    event.preventDefault();
    setSubmitting(true);
    setError(null);
    try {
      const saved = await saveConfluenceConnection(repository.id, {
        integrationId,
        spaceKey: spaceKey.trim(),
      });
      setConnection(saved);
    } catch (err) {
      setError(
        err instanceof ApiError ? err.message : "Could not save the target.",
      );
    } finally {
      setSubmitting(false);
    }
  }

  async function handleRemove() {
    setError(null);
    try {
      await deleteConfluenceConnection(repository.id);
      setConnection(null);
    } catch {
      setError("Could not remove the target.");
    }
  }

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle className="font-display">Confluence</DialogTitle>
          <DialogDescription>
            Publish this repository's documentation to a Confluence page, using
            one of your organization's Atlassian integrations. The page is created
            once and updated in place on every publish.
          </DialogDescription>
        </DialogHeader>

        {loaded && integrations.length === 0 && (
          <div className="space-y-3 text-sm">
            <p className="text-muted-foreground">
              {canManageIntegrations
                ? "No Atlassian integration yet."
                : "No Atlassian integration is configured for this organization."}
            </p>
            {canManageIntegrations && (
              <Link
                to={
                  activeOrg
                    ? `/orgs/${activeOrg.id}/settings#integrations`
                    : "/settings"
                }
                onClick={() => handleOpenChange(false)}
                className="text-primary text-sm underline underline-offset-2"
              >
                Set one up in organization settings
              </Link>
            )}
          </div>
        )}

        {loaded && integrations.length > 0 && (
          <form onSubmit={handleSubmit} className="space-y-5">
            {connection && (
              <div className="flex items-center gap-2">
                {selected && (
                  <ConnectionStatusBadge status={selected.connectionStatus} />
                )}
                <button
                  type="button"
                  className="text-muted-foreground hover:text-destructive ml-auto text-xs underline underline-offset-2"
                  onClick={handleRemove}
                >
                  Remove target
                </button>
              </div>
            )}

            <div className="space-y-2">
              <Label htmlFor="confluence-integration">Atlassian integration</Label>
              <select
                id="confluence-integration"
                value={integrationId}
                onChange={(e) => setIntegrationId(e.target.value)}
                className={cn(
                  "border-input bg-transparent h-9 w-full min-w-0 rounded-md border px-3 py-1 text-sm shadow-xs outline-none",
                  "focus-visible:border-ring focus-visible:ring-ring/50 focus-visible:ring-[3px]",
                  "dark:bg-input/30",
                )}
              >
                {integrations.map((i) => (
                  <option key={i.id} value={i.id}>
                    {i.name} — {i.config.baseUrl}
                  </option>
                ))}
              </select>
            </div>

            <div className="space-y-2">
              <Label htmlFor="confluence-space-key">Space key</Label>
              <Input
                id="confluence-space-key"
                value={spaceKey}
                onChange={(e) => setSpaceKey(e.target.value)}
                placeholder="DOCS"
                autoComplete="off"
              />
            </div>

            {error && (
              <p className="text-destructive text-sm" role="alert">
                {error}
              </p>
            )}

            <div className="flex justify-end">
              <Button type="submit" disabled={submitting || incomplete}>
                {submitting ? "Saving…" : "Save target"}
              </Button>
            </div>
          </form>
        )}
      </DialogContent>
    </Dialog>
  );
}
