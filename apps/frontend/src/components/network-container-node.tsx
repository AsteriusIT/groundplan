import { memo } from "react";
import { type Node as FlowNode, type NodeProps } from "@xyflow/react";

import type { GraphNode } from "@/api/types";
import { ResourceIcon } from "@/components/resource-icon";
import { categorize, CATEGORY_META, shortType } from "@/lib/resource-category";
import type { GraphNodeData } from "@/lib/graph-layout";
import { cn } from "@/lib/utils";

/**
 * A resource-backed container for the network view (GP-44): a vnet or subnet
 * rendered as a nested group frame, labelled with its own identity. The two
 * levels read through neutral elevation, not colour (colour is reserved for the
 * plan diff): a vnet is a bold solid outer frame, a subnet a lighter dashed inner
 * frame — each a shade brighter toward the white resource cards inside. Both
 * levels carry the same neutral label; only the frame weight sets them apart
 * (vnet ⊃ subnet ⊃ components), laid out via React Flow subflows.
 */
export function NetworkContainer({
  graphNode,
  dimmed = false,
  exposed = false,
}: {
  graphNode: GraphNode;
  dimmed?: boolean;
  /** GP-45: this subnet is guarded by an internet-exposed NSG. */
  exposed?: boolean;
}) {
  const isVnet = graphNode.type === "azurerm_virtual_network";
  const iconClass = CATEGORY_META[categorize(graphNode.type)].className;
  const layer = isVnet ? "vnet" : shortType(graphNode.type);
  return (
    <div
      className={cn(
        // Solid, fully-opaque fills + borders so both levels read clearly on the
        // blueprint grid (no opacity modifiers).
        "relative h-full w-full transition-opacity",
        isVnet
          ? "border-border-strong bg-muted rounded-xl border-2"
          : "border-border-strong bg-background rounded-lg border border-dashed",
        exposed && "ring-exposed ring-2",
        dimmed && "opacity-40",
      )}
    >
      <span
        className={cn(
          "text-muted-foreground border-border bg-canvas absolute left-3 inline-flex items-center gap-1.5 rounded-md border px-2 py-0.5 font-mono text-[10px] leading-none font-medium",
          // Same neutral label at both levels; only the vertical offset differs
          // (the vnet's 2px frame sits its label slightly higher).
          isVnet ? "-top-3" : "-top-2.5",
        )}
      >
        <ResourceIcon
          type={graphNode.type}
          className={cn("size-3.5 shrink-0", iconClass)}
        />
        <span className="tracking-[0.14em] uppercase">{layer}</span>
        <span className="text-ink font-semibold">{graphNode.name}</span>
      </span>
    </div>
  );
}

/** React Flow node wrapper for {@link NetworkContainer}. */
export const NetworkContainerNode = memo(function NetworkContainerNode({
  data,
}: NodeProps<FlowNode<GraphNodeData>>) {
  return (
    <NetworkContainer
      graphNode={data.graphNode}
      dimmed={data.dimmed}
      exposed={data.exposed === true}
    />
  );
});
