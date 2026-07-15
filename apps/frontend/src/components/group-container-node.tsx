import { memo } from "react";
import { Handle, Position, type Node as FlowNode, type NodeProps } from "@xyflow/react";
import { Users } from "lucide-react";

import type { GraphNode } from "@/api/types";
import { AiBadge } from "@/components/ui/ai-badge";
import type { GraphNodeData } from "@/lib/graph-layout";
import { cn } from "@/lib/utils";

/**
 * A container injected from a `group` annotation, in the adapted view (GP-74).
 *
 * It must never be mistaken for a module box or a vnet frame, and the difference
 * it carries is not cosmetic: a module is what the code says, a group is what a
 * *human* said about the code. So this frame is the one structural element on the
 * canvas drawn in the accent tone — the same tone every other human-authored mark
 * uses (notes, logical edges) — with a solid border where generated containers
 * are neutral and dashed.
 *
 * In C4 mode (GP-77) the same group arrives collapsed, as a single node with a
 * member count and no children; it renders here too, as a filled card rather than
 * an empty frame — a system you cannot open should not look like a box you forgot
 * to fill.
 */
export function GroupContainer({
  graphNode,
  dimmed = false,
  aiProvenance = false,
}: Readonly<{
  graphNode: GraphNode;
  dimmed?: boolean;
  /** The group came from an accepted AI proposal (GP-76). Said, permanently. */
  aiProvenance?: boolean;
}>) {
  const memberCount = graphNode.member_count;
  const collapsed = memberCount !== undefined;
  const noteCount = graphNode.notes?.length ?? 0;

  return (
    <div
      className={cn(
        "relative h-full w-full rounded-xl border-2 transition-opacity",
        "border-primary/60",
        collapsed ? "bg-accent-soft" : "bg-primary/5",
        dimmed && "opacity-40",
      )}
    >
      <Handle type="target" position={Position.Left} className="!opacity-0" />
      <span className="border-primary/40 bg-canvas absolute -top-3 left-3 inline-flex items-center gap-1.5 rounded-md border px-2 py-0.5 font-mono text-[10px] leading-none font-medium">
        <Users className="text-primary size-3.5 shrink-0" aria-hidden="true" />
        <span className="text-primary tracking-[0.14em] uppercase">group</span>
        <span className="text-ink font-semibold">
          {graphNode.display_label ?? graphNode.name}
        </span>
        {aiProvenance && <AiBadge />}
      </span>

      {/* Collapsed (C4): the frame is the system. Say what is inside it, since
          nobody can see in. */}
      {collapsed && (
        <div className="text-muted-foreground grid h-full place-items-center gap-1 font-mono text-[11px]">
          <span>
            {memberCount} resource{memberCount === 1 ? "" : "s"}
            {noteCount > 0 && ` · ${noteCount} note${noteCount === 1 ? "" : "s"}`}
          </span>
        </div>
      )}
      <Handle type="source" position={Position.Right} className="!opacity-0" />
    </div>
  );
}

/** React Flow node wrapper for {@link GroupContainer}. */
export const GroupContainerNode = memo(function GroupContainerNode({
  data,
}: NodeProps<FlowNode<GraphNodeData>>) {
  return (
    <GroupContainer
      graphNode={data.graphNode}
      dimmed={data.dimmed}
      aiProvenance={data.aiProvenance === true}
    />
  );
});
