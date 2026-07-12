import { memo } from "react";
import { type Node as FlowNode, type NodeProps } from "@xyflow/react";

import type { GraphNode } from "@/api/types";
import { ResourceIcon } from "@/components/resource-icon";
import { categorize, CATEGORY_META, shortType } from "@/lib/resource-category";
import type { GraphNodeData } from "@/lib/graph-layout";
import { cn } from "@/lib/utils";

/**
 * A resource-backed container for the network view (GP-44): a vnet or subnet
 * rendered as a dashed group frame (like the module container) but labelled with
 * its own identity — icon + type + name — instead of `module.<name>`. Children
 * (subnets, NICs, …) are laid out inside it via React Flow subflows.
 */
export function NetworkContainer({
  graphNode,
  dimmed = false,
}: {
  graphNode: GraphNode;
  dimmed?: boolean;
}) {
  const iconClass = CATEGORY_META[categorize(graphNode.type)].className;
  return (
    <div
      className={cn(
        "border-border-strong bg-accent-soft/20 relative h-full w-full rounded-lg border border-dashed transition-opacity",
        dimmed && "opacity-40",
      )}
    >
      <span className="bg-canvas absolute -top-2.5 left-3 inline-flex items-center gap-1 px-1.5 font-mono text-[10px] font-medium tracking-wide">
        <ResourceIcon type={graphNode.type} className={cn("size-3", iconClass)} />
        <span className="text-muted-foreground">{shortType(graphNode.type)}</span>
        <span className="text-ink">{graphNode.name}</span>
      </span>
    </div>
  );
}

/** React Flow node wrapper for {@link NetworkContainer}. */
export const NetworkContainerNode = memo(function NetworkContainerNode({
  data,
}: NodeProps<FlowNode<GraphNodeData>>) {
  return <NetworkContainer graphNode={data.graphNode} dimmed={data.dimmed} />;
});
