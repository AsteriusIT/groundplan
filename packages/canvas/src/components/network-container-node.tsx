import { memo } from "react";
import { type Node as FlowNode, type NodeProps } from "@xyflow/react";

import type { GraphNode } from "../types";
import { AttachmentChip } from "../components/attachment-chip";
import { ResourceIcon } from "../components/resource-icon";
import { categorize, CATEGORY_META, shortType } from "../lib/resource-category";
import type { GraphNodeData } from "../lib/graph-layout";
import { cn } from "../lib/utils";

/**
 * A resource-backed container for the network view (GP-44): a vnet or subnet
 * rendered as a nested group frame, labelled with its own identity. The two
 * levels read through neutral elevation, not colour (colour is reserved for the
 * plan diff): a vnet is a bold solid outer frame, a subnet a lighter dashed inner
 * frame — each a shade brighter toward the white resource cards inside. Both
 * levels carry the same neutral label; only the frame weight sets them apart
 * (vnet ⊃ subnet ⊃ components), laid out via React Flow subflows.
 *
 * A subnet also wears its guardians on its header (GP-89): the NSGs and route
 * tables associated with it, as chips, since they attach *to* the subnet rather
 * than sit inside it.
 */
export function NetworkContainer({
  graphNode,
  dimmed = false,
  exposed = false,
  chips,
  highlightedChipId,
  onSelectChip,
}: Readonly<{
  graphNode: GraphNode;
  dimmed?: boolean;
  /** GP-45: this subnet is guarded by an internet-exposed NSG. */
  exposed?: boolean;
  /** GP-89: NSGs / route tables attached to this subnet, rendered as chips. */
  chips?: GraphNode[];
  /** GP-89: a chip to pulse (search fly-to landed on it). */
  highlightedChipId?: string;
  /** GP-89: select a chip's node (opens its detail panel). */
  onSelectChip?: (node: GraphNode) => void;
}>) {
  const isVnet = graphNode.type === "azurerm_virtual_network";
  const iconClass = CATEGORY_META[categorize(graphNode.type)].className;
  const layer = isVnet ? "vnet" : shortType(graphNode.type);
  const hasChips = chips !== undefined && chips.length > 0;
  // The frame's CIDR (v7 attributes), when the producer knew it statically.
  const cidr =
    graphNode.attributes?.["address_prefixes"] ??
    graphNode.attributes?.["address_space"];
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
        {cidr && <span className="text-faint">{cidr}</span>}
      </span>

      {/* GP-89: the subnet's guardians, pinned along the top of its frame. */}
      {hasChips && (
        <div className="absolute top-1.5 right-2 left-3 flex flex-wrap justify-end gap-1">
          {chips.map((node) => (
            <AttachmentChip
              key={node.id}
              node={node}
              highlighted={node.id === highlightedChipId}
              onSelect={onSelectChip}
            />
          ))}
        </div>
      )}
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
      chips={data.chips}
      highlightedChipId={data.highlightedChipId as string | undefined}
      onSelectChip={data.onSelectChip as ((node: GraphNode) => void) | undefined}
    />
  );
});
