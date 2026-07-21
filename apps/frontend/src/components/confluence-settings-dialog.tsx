import { type SubmitEvent, useCallback, useEffect, useState } from "react";

import {
  ApiError,
  deleteConfluenceConnection,
  getConfluenceConnection,
  saveConfluenceConnection,
  verifyConfluenceConnection,
} from "@/api/client";
import type {
  ConfluenceAuthType,
  ConfluenceConnection,
  Repository,
  SaveConfluenceConnectionInput,
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
import {
  ConnectionStatusBadge,
  confluenceErrorMessage,
} from "@/components/connection-status";

/**
 * Where this repository's docs page publishes to (GP-179/GP-181): base URL,
 * space key, and a credential that follows the repository-PAT rules — write
 * only, never displayed back, blank on update means "keep the stored one".
 *
 * Auth is a toggle, not two forms: Cloud (API token, as Basic email:token) and
 * Data Center (PAT, as Bearer) differ only in the credential field and whether
 * an email is needed. The server verifies the target on save; the outcome is
 * shown here rather than the dialog closing on a connection that does not work.
 *
 * Controlled (no trigger) for the same reason as the settings dialog: it opens
 * from the card's overflow menu, which unmounts on select.
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
  const [connection, setConnection] = useState<ConfluenceConnection | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [baseUrl, setBaseUrl] = useState("");
  const [spaceKey, setSpaceKey] = useState("");
  const [authType, setAuthType] = useState<ConfluenceAuthType>("cloud_token");
  const [email, setEmail] = useState("");
  const [credential, setCredential] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [verifying, setVerifying] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const seed = useCallback((conn: ConfluenceConnection | null) => {
    setBaseUrl(conn?.baseUrl ?? "");
    setSpaceKey(conn?.spaceKey ?? "");
    setAuthType(conn?.authType ?? "cloud_token");
    setEmail(conn?.email ?? "");
    setCredential("");
  }, []);

  // Re-fetch each time it opens: the connection may have been verified,
  // published to, or removed since — a stale draft would silently undo that.
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setLoaded(false);
    setError(null);
    getConfluenceConnection(repository.id)
      .then((conn) => {
        if (cancelled) return;
        setConnection(conn);
        seed(conn);
        setLoaded(true);
      })
      .catch(() => {
        if (cancelled) return;
        setConnection(null);
        seed(null);
        setLoaded(true);
      });
    return () => {
      cancelled = true;
    };
  }, [open, repository.id, seed]);

  function handleOpenChange(next: boolean) {
    onOpenChange(next);
    if (!next) {
      setCredential("");
      setError(null);
      setSubmitting(false);
    }
  }

  const hasStored = connection !== null;
  const cloud = authType === "cloud_token";
  const credentialLabel = cloud
    ? hasStored
      ? "Replace API token"
      : "API token"
    : hasStored
      ? "Replace personal access token"
      : "Personal access token";

  const incomplete =
    !baseUrl.trim() ||
    !spaceKey.trim() ||
    (cloud && !email.trim()) ||
    (!hasStored && !credential.trim());

  async function handleSubmit(event: SubmitEvent) {
    event.preventDefault();
    setSubmitting(true);
    setError(null);
    try {
      const input: SaveConfluenceConnectionInput = {
        baseUrl: baseUrl.trim(),
        spaceKey: spaceKey.trim(),
        authType,
        ...(cloud ? { email: email.trim() } : {}),
        ...(credential.trim() ? { credential: credential.trim() } : {}),
      };
      const saved = await saveConfluenceConnection(repository.id, input);
      setConnection(saved);
      setCredential("");
      if (saved.connectionStatus === "failed") {
        // The row stores the outcome, not the reason — ask the verify endpoint
        // once, so the user reads *why* instead of just "failed".
        const result = await verifyConfluenceConnection(repository.id);
        if (result.ok) {
          setConnection({ ...saved, connectionStatus: "ok" });
        } else {
          setError(confluenceErrorMessage(result.error));
        }
      }
    } catch (err) {
      setError(
        err instanceof ApiError ? err.message : "Could not save the connection.",
      );
    } finally {
      setSubmitting(false);
    }
  }

  async function handleVerify() {
    setVerifying(true);
    setError(null);
    try {
      const result = await verifyConfluenceConnection(repository.id);
      setConnection((prev) =>
        prev ? { ...prev, connectionStatus: result.ok ? "ok" : "failed" } : prev,
      );
      if (!result.ok) setError(confluenceErrorMessage(result.error));
    } catch {
      setError("Could not verify the connection.");
    } finally {
      setVerifying(false);
    }
  }

  async function handleRemove() {
    setError(null);
    try {
      await deleteConfluenceConnection(repository.id);
      setConnection(null);
      seed(null);
    } catch {
      setError("Could not remove the connection.");
    }
  }

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle className="font-display">Confluence</DialogTitle>
          <DialogDescription>
            Publish this repository's documentation to a Confluence page. The
            page is created once and updated in place on every publish.
          </DialogDescription>
        </DialogHeader>

        {loaded && (
          <form onSubmit={handleSubmit} className="space-y-5">
            {connection && (
              <div className="flex items-center gap-2">
                <ConnectionStatusBadge status={connection.connectionStatus} />
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={handleVerify}
                  disabled={verifying}
                >
                  {verifying ? "Verifying…" : "Verify"}
                </Button>
                <button
                  type="button"
                  className="text-muted-foreground hover:text-destructive ml-auto text-xs underline underline-offset-2"
                  onClick={handleRemove}
                >
                  Remove connection
                </button>
              </div>
            )}

            <div className="space-y-2">
              <Label htmlFor="confluence-base-url">Base URL</Label>
              <Input
                id="confluence-base-url"
                value={baseUrl}
                onChange={(e) => setBaseUrl(e.target.value)}
                placeholder="https://your-site.atlassian.net/wiki"
                autoComplete="off"
              />
              <p className="text-muted-foreground text-xs">
                For Confluence Cloud include the{" "}
                <span className="font-mono">/wiki</span> suffix; for Data Center
                the instance origin.
              </p>
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

            <div className="space-y-2">
              <p className="text-sm leading-none font-medium">Authentication</p>
              <div
                role="group"
                aria-label="Authentication type"
                className="flex gap-2"
              >
                <Button
                  type="button"
                  size="sm"
                  variant={cloud ? "default" : "outline"}
                  aria-pressed={cloud}
                  onClick={() => setAuthType("cloud_token")}
                >
                  Cloud API token
                </Button>
                <Button
                  type="button"
                  size="sm"
                  variant={cloud ? "outline" : "default"}
                  aria-pressed={!cloud}
                  onClick={() => setAuthType("dc_pat")}
                >
                  Data Center PAT
                </Button>
              </div>
            </div>

            {cloud && (
              <div className="space-y-2">
                <Label htmlFor="confluence-email">Account email</Label>
                <Input
                  id="confluence-email"
                  type="email"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  autoComplete="off"
                />
                <p className="text-muted-foreground text-xs">
                  The Atlassian account the API token belongs to.
                </p>
              </div>
            )}

            <div className="space-y-2">
              <Label htmlFor="confluence-credential">{credentialLabel}</Label>
              <Input
                id="confluence-credential"
                type="password"
                value={credential}
                onChange={(e) => setCredential(e.target.value)}
                placeholder={hasStored ? "••••••••" : undefined}
                autoComplete="off"
              />
              <p className="text-muted-foreground text-xs">
                {hasStored
                  ? "A credential is stored. Leave this blank to keep it."
                  : "Stored encrypted at rest. Used only to publish this repository's docs page."}
              </p>
            </div>

            {error && (
              <p className="text-destructive text-sm" role="alert">
                {error}
              </p>
            )}

            <div className="flex justify-end">
              <Button type="submit" disabled={submitting || incomplete}>
                {submitting ? "Saving…" : "Save connection"}
              </Button>
            </div>
          </form>
        )}
      </DialogContent>
    </Dialog>
  );
}
