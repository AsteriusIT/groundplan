import { type SubmitEvent, useCallback, useEffect, useState } from "react";
import { Plug, Trash2 } from "lucide-react";

import {
  ApiError,
  createIntegration,
  deleteIntegration,
  listIntegrations,
  updateIntegration,
  verifyIntegration,
} from "@/api/client";
import type {
  ConfluenceAuthType,
  CreateIntegrationInput,
  Integration,
  UpdateIntegrationInput,
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
import { useCan } from "@/rbac/use-can";

/**
 * The org's external integrations (GP-183): a Confluence credential configured
 * once per org and attached by N repositories, instead of a credential per repo.
 * Any member reads the list (name + verified status); creating, editing,
 * verifying and deleting need `integration:manage` (owner/admin) — gated here
 * and enforced by the API. The credential is write-only: never shown back, blank
 * on an edit means "keep the stored one".
 */
export function OrgIntegrations() {
  const canManage = useCan("integration:manage");
  const [integrations, setIntegrations] = useState<Integration[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  // `null` = closed, `"new"` = the add form, an Integration = editing it.
  const [editing, setEditing] = useState<Integration | "new" | null>(null);

  const load = useCallback(() => {
    listIntegrations()
      .then(setIntegrations)
      .catch(() => setIntegrations([]));
  }, []);
  useEffect(load, [load]);

  async function handleVerify(id: string) {
    setError(null);
    try {
      const result = await verifyIntegration(id);
      setIntegrations(
        (prev) =>
          prev?.map((i) =>
            i.id === id
              ? { ...i, connectionStatus: result.ok ? "ok" : "failed" }
              : i,
          ) ?? prev,
      );
      if (!result.ok) setError(confluenceErrorMessage(result.error));
    } catch {
      setError("Could not verify the integration.");
    }
  }

  async function handleDelete(id: string) {
    setError(null);
    try {
      await deleteIntegration(id);
      setIntegrations((prev) => prev?.filter((i) => i.id !== id) ?? prev);
    } catch (err) {
      setError(
        err instanceof ApiError
          ? err.message
          : "Could not delete the integration.",
      );
    }
  }

  function handleSaved(saved: Integration) {
    setIntegrations((prev) => {
      if (!prev) return [saved];
      return prev.some((i) => i.id === saved.id)
        ? prev.map((i) => (i.id === saved.id ? saved : i))
        : [...prev, saved];
    });
    setEditing(null);
  }

  if (integrations === null) {
    return (
      <p className="text-muted-foreground text-sm" aria-busy="true">
        Loading…
      </p>
    );
  }

  return (
    <div className="space-y-4">
      {integrations.length === 0 ? (
        <p className="text-muted-foreground text-sm">
          No integrations yet.
          {canManage
            ? " Add an Atlassian site to publish documentation to Confluence."
            : ""}
        </p>
      ) : (
        <ul className="divide-y divide-border border-border rounded-md border">
          {integrations.map((i) => (
            <li key={i.id} className="flex items-center gap-3 px-4 py-3">
              <Plug
                className="text-muted-foreground size-4 shrink-0"
                aria-hidden="true"
              />
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-medium">{i.name}</p>
                <p className="text-muted-foreground truncate font-mono text-xs">
                  {i.config.baseUrl}
                </p>
              </div>
              <ConnectionStatusBadge status={i.connectionStatus} />
              {canManage && (
                <div className="flex items-center gap-1">
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => void handleVerify(i.id)}
                  >
                    Verify
                  </Button>
                  <Button variant="outline" size="sm" onClick={() => setEditing(i)}>
                    Edit
                  </Button>
                  <Button
                    variant="ghost"
                    size="sm"
                    aria-label={`Delete ${i.name}`}
                    onClick={() => void handleDelete(i.id)}
                  >
                    <Trash2 className="size-4" />
                  </Button>
                </div>
              )}
            </li>
          ))}
        </ul>
      )}

      {error && (
        <p className="text-destructive text-sm" role="alert">
          {error}
        </p>
      )}

      {canManage && (
        <Button variant="outline" size="sm" onClick={() => setEditing("new")}>
          Add integration
        </Button>
      )}

      {editing && (
        <AtlassianForm
          integration={editing === "new" ? null : editing}
          onClose={() => setEditing(null)}
          onSaved={handleSaved}
        />
      )}
    </div>
  );
}

/**
 * The Atlassian integration form — a controlled dialog for both add and edit.
 * Auth is a toggle, not two forms: Cloud (API token, as Basic email:token) and
 * Data Center (PAT, as Bearer) differ only in the credential field and whether
 * an email is needed. The server verifies the credential on save.
 */
function AtlassianForm({
  integration,
  onClose,
  onSaved,
}: Readonly<{
  integration: Integration | null;
  onClose: () => void;
  onSaved: (saved: Integration) => void;
}>) {
  const isEdit = integration !== null;
  const [name, setName] = useState(integration?.name ?? "");
  const [baseUrl, setBaseUrl] = useState(integration?.config.baseUrl ?? "");
  const [authType, setAuthType] = useState<ConfluenceAuthType>(
    integration?.config.authType ?? "cloud_token",
  );
  const [email, setEmail] = useState(integration?.config.email ?? "");
  const [credential, setCredential] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const cloud = authType === "cloud_token";
  const credentialLabel = cloud
    ? isEdit
      ? "Replace API token"
      : "API token"
    : isEdit
      ? "Replace personal access token"
      : "Personal access token";

  const incomplete =
    !name.trim() ||
    !baseUrl.trim() ||
    (cloud && !email.trim()) ||
    (!isEdit && !credential.trim());

  async function handleSubmit(event: SubmitEvent) {
    event.preventDefault();
    setSubmitting(true);
    setError(null);
    try {
      let saved: Integration;
      if (integration) {
        const input: UpdateIntegrationInput = {
          name: name.trim(),
          baseUrl: baseUrl.trim(),
          authType,
          ...(cloud ? { email: email.trim() } : {}),
          ...(credential.trim() ? { credential: credential.trim() } : {}),
        };
        saved = await updateIntegration(integration.id, input);
      } else {
        const input: CreateIntegrationInput = {
          type: "atlassian",
          name: name.trim(),
          baseUrl: baseUrl.trim(),
          authType,
          ...(cloud ? { email: email.trim() } : {}),
          credential: credential.trim(),
        };
        saved = await createIntegration(input);
      }
      onSaved(saved);
    } catch (err) {
      setError(
        err instanceof ApiError
          ? err.message
          : "Could not save the integration.",
      );
      setSubmitting(false);
    }
  }

  return (
    <Dialog open onOpenChange={(next) => (next ? undefined : onClose())}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle className="font-display">
            {isEdit ? "Edit Atlassian integration" : "Add Atlassian integration"}
          </DialogTitle>
          <DialogDescription>
            A Confluence credential your repositories share to publish
            documentation. Stored encrypted; used only to publish.
          </DialogDescription>
        </DialogHeader>

        <form onSubmit={handleSubmit} className="space-y-5">
          <div className="space-y-2">
            <Label htmlFor="integration-name">Name</Label>
            <Input
              id="integration-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Acme Confluence"
              autoComplete="off"
            />
          </div>

          <div className="space-y-2">
            <Label htmlFor="integration-base-url">Base URL</Label>
            <Input
              id="integration-base-url"
              value={baseUrl}
              onChange={(e) => setBaseUrl(e.target.value)}
              placeholder="https://your-site.atlassian.net/wiki"
              autoComplete="off"
            />
            <p className="text-muted-foreground text-xs">
              For Confluence Cloud include the{" "}
              <span className="font-mono">/wiki</span> suffix; for Data Center the
              instance origin.
            </p>
          </div>

          <div className="space-y-2">
            <p className="text-sm leading-none font-medium">Authentication</p>
            <div role="group" aria-label="Authentication type" className="flex gap-2">
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
              <Label htmlFor="integration-email">Account email</Label>
              <Input
                id="integration-email"
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
            <Label htmlFor="integration-credential">{credentialLabel}</Label>
            <Input
              id="integration-credential"
              type="password"
              value={credential}
              onChange={(e) => setCredential(e.target.value)}
              placeholder={isEdit ? "••••••••" : undefined}
              autoComplete="off"
            />
            <p className="text-muted-foreground text-xs">
              {isEdit
                ? "A credential is stored. Leave this blank to keep it."
                : "Stored encrypted at rest."}
            </p>
          </div>

          {error && (
            <p className="text-destructive text-sm" role="alert">
              {error}
            </p>
          )}

          <div className="flex justify-end gap-2">
            <Button type="button" variant="ghost" onClick={onClose}>
              Cancel
            </Button>
            <Button type="submit" disabled={submitting || incomplete}>
              {submitting ? "Saving…" : isEdit ? "Save changes" : "Add integration"}
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}
