import { useState } from "react";
import { Loader2 } from "lucide-react";

import { GraphCanvas } from "@/components/graph-canvas";
import type { GraphNode } from "@/api/types";
import { cn } from "@/lib/utils";
import { StudioCodePanel, type CodeTarget } from "./studio-code-panel";
import type { StudioSession } from "./use-studio-session";

/**
 * The studio's right-hand region (GP-142/GP-143): the generated
 * infrastructure on the shared canvas — the exact renderer the docs view
 * uses, so the studio's diagram and a committed repository's diagram are the
 * same picture — with the read-only code panel split in beside it on demand.
 *
 * Nodes new since the previous turn ride `highlightIds` (presentation only);
 * lint findings ride `lint` (badge + detail-panel section). On a parse
 * failure this region simply keeps rendering the last good snapshot — the
 * failure itself is the chat's story.
 */
export function StudioWorkspace({
  session,
  codeOpen,
}: Readonly<{
  session: StudioSession;
  /** The code split, toggled from the studio header (GP-143). */
  codeOpen: boolean;
}>) {
  // GP-143's node→code contract: a clicked node aims the code panel at its
  // source block (Producer B kept file + line range on every docs-flow node).
  const [codeTarget, setCodeTarget] = useState<CodeTarget | null>(null);

  function onNodeSelect(node: GraphNode | null) {
    if (!node?.source) return;
    setCodeTarget({
      file: node.source.file,
      range: {
        start: node.source.start_line,
        end: node.source.end_line,
      },
    });
  }

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
    <div className="flex h-full min-h-0">
      <div className="blueprint-grid relative min-h-0 min-w-0 flex-1">
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
      {/* The code split (GP-143): read-only viewer beside the canvas; always
          the current session files, so a regen never shows stale code. */}
      <div
        className={cn(
          "border-border min-h-0 shrink-0 border-l",
          codeOpen ? "w-[44%] min-w-[380px]" : "hidden",
        )}
      >
        <StudioCodePanel files={session.files} target={codeTarget} />
      </div>
    </div>
  );
}
