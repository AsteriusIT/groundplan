import { Loader2 } from "lucide-react";

import { GraphCanvas } from "@/components/graph-canvas";
import type { GraphNode } from "@/api/types";
import type { StudioSession } from "./use-studio-session";

/**
 * The studio's right-hand region (GP-142): the generated infrastructure on
 * the shared canvas — the exact renderer the docs view uses, so the studio's
 * diagram and a committed repository's diagram are the same picture.
 *
 * Nodes new since the previous turn ride `highlightIds` (presentation only);
 * lint findings ride `lint` (badge + detail-panel section). On a parse
 * failure this region simply keeps rendering the last good snapshot — the
 * failure itself is the chat's story.
 */
export function StudioWorkspace({
  session,
  onNodeSelect,
}: Readonly<{
  session: StudioSession;
  /** GP-143: the code panel's node→code jump listens here. */
  onNodeSelect?: (node: GraphNode | null) => void;
}>) {
  if (!session.snapshot) {
    return (
      <div className="blueprint-grid flex h-full items-center justify-center">
        {session.parsing ? (
          <p className="text-muted-foreground flex items-center gap-2 text-sm">
            <Loader2 className="size-4 animate-spin" />
            Drawing the diagram…
          </p>
        ) : (
          <p className="text-muted-foreground max-w-sm px-4 text-center text-sm">
            The diagram appears here as soon as the first generation lands.
          </p>
        )}
      </div>
    );
  }

  return (
    <div className="blueprint-grid relative h-full">
      <GraphCanvas
        graph={session.snapshot}
        variant="docs"
        highlightIds={session.freshNodeIds}
        lint={session.lint}
        onNodeSelect={onNodeSelect}
      />
      {session.parsing && (
        <p className="bg-card/90 text-muted-foreground absolute top-3 left-1/2 z-10 flex -translate-x-1/2 items-center gap-1.5 rounded-full border border-border px-3 py-1 text-xs shadow-sm backdrop-blur">
          <Loader2 className="size-3.5 animate-spin" />
          Updating…
        </p>
      )}
    </div>
  );
}
