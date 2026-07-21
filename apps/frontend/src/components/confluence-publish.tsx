import { useCallback, useEffect, useState } from "react";
import { BookUp, ExternalLink, Loader2 } from "lucide-react";

import { ApiError, getConfluenceConnection, publishToConfluence } from "@/api/client";
import type { ConfluenceConnection } from "@/api/types";
import { Button } from "@/components/ui/button";
import { confluenceErrorMessage } from "@/components/connection-status";
import { relativeTime } from "@/lib/format";

/**
 * The docs page's "Publish to Confluence" action (GP-181). Renders only when
 * the repository has a Confluence target configured (GP-184: the credential and
 * its verified status live on the org integration now) — absent, not disabled,
 * otherwise every repo without one carries a button that cannot work. Success
 * shows the page link and when it was last published; failure shows the
 * categorized reason in words a non-dev can act on.
 */
export function ConfluencePublish({
  repositoryId,
}: Readonly<{ repositoryId: string }>) {
  const [connection, setConnection] = useState<ConfluenceConnection | null>(null);
  const [publishing, setPublishing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    getConfluenceConnection(repositoryId)
      .then((conn) => {
        if (!cancelled) setConnection(conn);
      })
      .catch(() => {}); // no connection info → no publish surface, silently
    return () => {
      cancelled = true;
    };
  }, [repositoryId]);

  const publish = useCallback(async () => {
    setPublishing(true);
    setError(null);
    try {
      const result = await publishToConfluence(repositoryId);
      if (result.ok) {
        setConnection((prev) =>
          prev
            ? {
                ...prev,
                pageUrl: result.pageUrl,
                lastPublishedAt: result.publishedAt,
                lastPublishError: null,
              }
            : prev,
        );
      } else {
        setError(confluenceErrorMessage(result.error));
      }
    } catch (err) {
      setError(
        err instanceof ApiError ? err.message : "Could not publish to Confluence.",
      );
    } finally {
      setPublishing(false);
    }
  }, [repositoryId]);

  if (!connection) return null;

  return (
    <>
      <Button variant="outline" onClick={publish} disabled={publishing}>
        {publishing ? (
          <Loader2 className="size-4 animate-spin" />
        ) : (
          <BookUp className="size-4" />
        )}
        {publishing ? "Publishing…" : "Publish"}
      </Button>
      {!error && connection.pageUrl && connection.lastPublishedAt && (
        <a
          href={connection.pageUrl}
          target="_blank"
          rel="noreferrer"
          className="text-muted-foreground hover:text-foreground inline-flex items-center gap-1 text-xs underline-offset-2 hover:underline"
        >
          <ExternalLink className="size-3.5" />
          Published {relativeTime(connection.lastPublishedAt)}
        </a>
      )}
      {error && (
        <span className="text-destructive max-w-64 text-xs" role="alert">
          {error}
        </span>
      )}
    </>
  );
}
