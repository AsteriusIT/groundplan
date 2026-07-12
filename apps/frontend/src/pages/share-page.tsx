/**
 * Public, read-only share page (GP-39) at /share/:token. Rendered OUTSIDE the
 * auth guard: it fetches only the public snapshot route (no login, no sidebar,
 * no mutating actions) and shows the diagram on a minimal-chrome canvas. An
 * unknown or revoked token yields a clean 404 state.
 */
import { useEffect, useState } from "react";
import { useParams } from "react-router-dom";
import { Loader2, LinkIcon, TriangleAlert } from "lucide-react";

import { ApiError, getPublicSnapshot } from "@/api/client";
import type { PublicSnapshotView } from "@/api/types";
import { formatDate } from "@/lib/format";
import { Logo } from "@/components/logo";
import { GraphCanvas } from "@/components/graph-canvas";
import { ContextSection } from "@/components/context-section";

type State =
  | { status: "loading" }
  | { status: "not-found" }
  | { status: "error"; message: string }
  | { status: "ready"; view: PublicSnapshotView };

const shortSha = (sha: string) => sha.slice(0, 8);

export function SharePage() {
  const { token } = useParams<{ token: string }>();
  const [state, setState] = useState<State>({ status: "loading" });

  useEffect(() => {
    if (!token) {
      setState({ status: "not-found" });
      return;
    }
    let cancelled = false;
    setState({ status: "loading" });
    getPublicSnapshot(token)
      .then((view) => {
        if (!cancelled) setState({ status: "ready", view });
      })
      .catch((err) => {
        if (cancelled) return;
        if (err instanceof ApiError && err.status === 404) {
          setState({ status: "not-found" });
        } else {
          setState({
            status: "error",
            message: err instanceof ApiError ? err.message : "Could not load this diagram.",
          });
        }
      });
    return () => {
      cancelled = true;
    };
  }, [token]);

  if (state.status === "not-found") return <NotFound />;

  return (
    <div className="bg-background flex h-dvh flex-col">
      <header className="bg-card flex items-center justify-between gap-4 border-b border-border px-6 py-3">
        <div className="flex items-center gap-3">
          <Logo className="size-6" />
          {state.status === "ready" && (
            <div className="min-w-0">
              <p className="font-display truncate text-sm font-semibold">
                {state.view.repository.name}
              </p>
              <p className="text-muted-foreground truncate font-mono text-[11px]">
                {state.view.snapshot.ref} · {shortSha(state.view.snapshot.commitSha)} ·{" "}
                {formatDate(state.view.snapshot.createdAt)}
              </p>
            </div>
          )}
        </div>
        <span className="text-muted-foreground hidden items-center gap-1.5 text-xs sm:inline-flex">
          <LinkIcon className="size-3.5" />
          Read-only shared view
        </span>
      </header>

      <div className="blueprint-grid relative min-h-0 flex-1">
        {state.status === "loading" && (
          <div className="text-muted-foreground grid h-full place-items-center text-sm">
            <span className="inline-flex items-center gap-2">
              <Loader2 className="size-4 animate-spin" /> Loading diagram…
            </span>
          </div>
        )}
        {state.status === "error" && (
          <div className="grid h-full place-items-center p-8">
            <div
              role="alert"
              className="border-destructive/30 bg-destructive/5 flex max-w-md flex-col items-center gap-3 rounded-md border px-8 py-10 text-center"
            >
              <TriangleAlert className="text-destructive size-8" />
              <p className="text-muted-foreground text-sm">{state.message}</p>
            </div>
          </div>
        )}
        {state.status === "ready" && (
          <GraphCanvas
            graph={state.view.snapshot.graph}
            variant="docs"
            annotations={state.view.annotations}
          />
        )}
      </div>

      {/* GP-60: the repository's context, read-only, under the diagram. */}
      {state.status === "ready" && state.view.repository.context && (
        <div className="bg-card max-h-48 overflow-auto border-t border-border px-6 py-4">
          <div className="mx-auto max-w-3xl">
            <ContextSection markdown={state.view.repository.context} readOnly />
          </div>
        </div>
      )}
    </div>
  );
}

function NotFound() {
  return (
    <div className="bg-background grid h-dvh place-items-center p-8">
      <div className="max-w-md text-center">
        <Logo className="mx-auto mb-4 size-8" />
        <h1 className="font-display text-xl font-semibold">Link not available</h1>
        <p className="text-muted-foreground mt-2 text-sm">
          This share link is invalid or has been revoked. Ask the owner for a new
          one.
        </p>
      </div>
    </div>
  );
}
