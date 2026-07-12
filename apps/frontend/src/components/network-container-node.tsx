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
 * levels are styled distinctly so the containment reads at a glance — a vnet is a
 * bold solid outer frame (network hue), a subnet a lighter dashed inner frame —
 * with resource cards laid out inside via React Flow subflows (vnet ⊃ subnet ⊃
 * components).
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
        "relative h-full w-full transition-opacity",
        isVnet
          ? "border-cat-network/40 bg-cat-network/5 rounded-xl border-2"
          : "border-cat-network/30 bg-accent-soft/30 rounded-lg border border-dashed",
        exposed && "ring-exposed ring-2",
        dimmed && "opacity-40",
      )}
    >
      <span
        className={cn(
          "absolute left-3 inline-flex items-center gap-1.5 rounded-md px-2 py-0.5 font-mono text-[10px] leading-none font-medium",
          isVnet
            ? "bg-cat-network/15 text-cat-network -top-3"
            : "bg-canvas text-muted-foreground -top-2.5",
        )}
      >
        <ResourceIcon type={graphNode.type} className={cn("size-3.5 shrink-0", iconClass)} />
        <span className="tracking-[0.14em] uppercase opacity-70">{layer}</span>
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
