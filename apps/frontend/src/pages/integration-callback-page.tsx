import { useEffect, useRef, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { CheckCircle2, CircleAlert, Loader2 } from "lucide-react";

import { ApiError, completeConnection } from "@/api/client";
import { Button } from "@/components/ui/button";
import { useOrg } from "@/org/use-org";

/**
 * Where a provider sends the browser back (GP-193): `/integrations/callback`.
 *
 * One page for every provider, because every flow ends the same way — a `state`
 * we minted plus whatever the provider added — and the backend decides what any
 * of it means. The page hands the whole query over and reports the answer; it
 * knows nothing about installations, codes or PKCE.
 *
 * The URL carries no secret of ours: `state` is a sealed blob the browser cannot
 * read, and the provider's `code`/`installation_id` are single-use.
 */
export function IntegrationCallbackPage() {
  const [params] = useSearchParams();
  const { activeOrg } = useOrg();
  const [status, setStatus] = useState<"working" | "done" | "failed">("working");
  const [message, setMessage] = useState<string | null>(null);
  // React 18 mounts effects twice in StrictMode; a connect is not idempotent
  // from the provider's side (a code is single-use), so it runs once.
  const started = useRef(false);

  useEffect(() => {
    if (started.current || !activeOrg) return;
    started.current = true;

    const query: Record<string, string> = {};
    for (const [key, value] of params.entries()) query[key] = value;

    const state = query.state ?? "";
    delete query.state;

    // The provider can also come back with its own refusal (`error=access_denied`).
    if (query.error) {
      setStatus("failed");
      setMessage(query.error_description ?? query.error);
      return;
    }
    if (!state) {
      setStatus("failed");
      setMessage("This callback is missing its state — start the connection again.");
      return;
    }

    completeConnection({ state, params: query })
      .then((connection) => {
        setStatus("done");
        setMessage(connection.name);
      })
      .catch((err: unknown) => {
        setStatus("failed");
        setMessage(
          err instanceof ApiError
            ? err.message
            : "Could not finish this connection.",
        );
      });
  }, [params, activeOrg]);

  const settingsHref = activeOrg ? `/orgs/${activeOrg.id}/settings#integrations` : "/";

  return (
    <main className="mx-auto flex min-h-screen max-w-lg flex-col items-center justify-center gap-4 px-8 text-center">
      {status === "working" && (
        <>
          <Loader2 className="text-muted-foreground size-6 animate-spin" aria-hidden="true" />
          <p className="text-sm" aria-busy="true">
            Finishing the connection…
          </p>
        </>
      )}

      {status === "done" && (
        <>
          <CheckCircle2 className="text-create size-6" aria-hidden="true" />
          <h1 className="font-display text-lg">Connected</h1>
          <p className="text-muted-foreground text-sm">
            {message} is connected. Repositories can now authenticate through it
            instead of a personal access token.
          </p>
        </>
      )}

      {status === "failed" && (
        <>
          <CircleAlert className="text-destructive size-6" aria-hidden="true" />
          <h1 className="font-display text-lg">Connection not completed</h1>
          <p className="text-destructive text-sm" role="alert">
            {message}
          </p>
        </>
      )}

      {status !== "working" && (
        <Button asChild variant="outline" size="sm">
          <Link to={settingsHref}>Back to integrations</Link>
        </Button>
      )}
    </main>
  );
}
