import { useEffect, useState } from "react";

import type { IngestionSettings } from "@/api/types";
import {
  clearAppWebhookToken,
  getIngestionSettings,
  rotateAppWebhookToken,
} from "@/api/client";
import { formatDate } from "@/lib/format";
import { Button } from "@/components/ui/button";
import { Chip } from "@/components/ui/chip";
import { CopyButton } from "@/components/copy-button";

/**
 * The app-wide CI ingestion token (GP): a single token that authenticates a plan
 * push to *any* repository, alongside each repository's own token — so an estate
 * can wire one CI secret instead of one per repository.
 *
 * Its value leaves the server exactly once, on generate/rotate; on reload it is a
 * "Set" chip, never the value. Revoking it does not touch per-repo tokens. There
 * is no role model yet, so any signed-in user can rotate it — the copy says as
 * much, since a shared secret every teammate can rotate is a footgun if it is
 * silent about it.
 */
export function AppIngestionSettings() {
  const [status, setStatus] = useState<IngestionSettings | null>(null);
  const [freshToken, setFreshToken] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    getIngestionSettings()
      .then((s) => {
        if (!cancelled) setStatus(s);
      })
      .catch(() => {
        if (!cancelled) setError("Could not load ingestion settings.");
      });
    return () => {
      cancelled = true;
    };
  }, []);

  async function rotate() {
    setBusy(true);
    setError(null);
    try {
      const { webhookToken } = await rotateAppWebhookToken();
      setFreshToken(webhookToken);
      setStatus(await getIngestionSettings());
    } catch {
      setError("Could not generate the token.");
    } finally {
      setBusy(false);
    }
  }

  async function revoke() {
    setBusy(true);
    setError(null);
    try {
      await clearAppWebhookToken();
      setFreshToken(null);
      setStatus(await getIngestionSettings());
    } catch {
      setError("Could not revoke the token.");
    } finally {
      setBusy(false);
    }
  }

  if (status === null && error === null) {
    return (
      <p className="text-muted-foreground text-sm" aria-busy="true">
        Checking…
      </p>
    );
  }

  const isSet = status?.appWebhookTokenSet ?? false;

  let rotateLabel: string;
  if (busy) {
    rotateLabel = "Working…";
  } else {
    rotateLabel = isSet ? "Regenerate" : "Generate token";
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-3">
        <Chip variant={isSet ? "create" : "neutral"}>{isSet ? "Set" : "Not set"}</Chip>
        <p className="text-muted-foreground text-sm">
          {isSet ? (
            <>
              One token any repository&apos;s webhook accepts
              {status?.updatedAt ? <> — set {formatDate(status.updatedAt)}</> : null}.
            </>
          ) : (
            "No app-wide token. Only each repository's own token authenticates its pushes."
          )}
        </p>
      </div>

      {freshToken && (
        <div className="space-y-1.5">
          <p className="text-muted-foreground font-mono text-[11px] tracking-wide uppercase">
            App-wide token — shown once
          </p>
          <div className="flex items-center gap-2">
            <code className="bg-muted min-w-0 flex-1 truncate rounded-sm border border-border px-2.5 py-1.5 font-mono text-xs">
              {freshToken}
            </code>
            <CopyButton value={freshToken} label="Copy token" />
          </div>
          <p className="text-muted-foreground text-xs">
            Store it as the CI secret{" "}
            <code className="font-mono">GROUNDPLAN_TOKEN</code> — it won&apos;t be
            shown again.
          </p>
        </div>
      )}

      <div className="flex flex-wrap items-center gap-2">
        <Button variant="outline" size="sm" onClick={() => void rotate()} disabled={busy}>
          {rotateLabel}
        </Button>
        {isSet && (
          <Button
            variant="ghost"
            size="sm"
            onClick={() => void revoke()}
            disabled={busy}
          >
            Revoke
          </Button>
        )}
      </div>

      {error && (
        <p className="text-destructive text-sm" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}
