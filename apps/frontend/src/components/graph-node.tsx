/**
 * Node design v3 (GP-30) — the "beautiful node". A white card with the resource
 * icon (GP-29), a type-first bold label and a faint name, plus the status
 * treatment from the mockup: soft fill + 1.5px status border + a 3.5px status
 * bar on the left and a circular +/~/− badge top-right. Deletes are dashed +
 * struck through; impacted (unchanged) nodes get a violet dashed outer ring and
 * a violet ! badge; the selected node gets an accent ring; hover lifts on shadow
 * only (no re-layout).
 *
 * `NodeCard` is the presentational card (no React Flow context needed — the
 * /styleguide route renders it directly); `ResourceFlowNode` is the memoized
 * React Flow node that wraps it with connection handles.
 */
import { memo } from "react";
import {
  Handle,
  Position,
  type Node as FlowNode,
  type NodeProps,
} from "@xyflow/react";

import type { GraphNode } from "@/api/types";
import { changeClasses } from "@/lib/graph-layout";
import { STATUS_META, statusOf } from "@/lib/status";
import { categorize, CATEGORY_META, shortType } from "@/lib/resource-category";
import type { GraphNodeData } from "@/lib/graph-layout";
import { cn } from "@/lib/utils";
import { ResourceIcon } from "@/components/resource-icon";
import { StatusBadge } from "@/components/ui/status-badge";

export function NodeCard({
  graphNode,
  selected = false,
  dimmed = false,
}: {
  graphNode: GraphNode;
  selected?: boolean;
  dimmed?: boolean;
}) {
  const status = statusOf(graphNode.change); // create | update | delete | null
  const impacted = graphNode.impacted === true;
  const isDelete = graphNode.change === "delete";
  const iconClass = CATEGORY_META[categorize(graphNode.type)].className;

  return (
    <div
      title={graphNode.type}
      className={cn(
        // No overflow-hidden here: the status badge intentionally overhangs the
        // top-right corner and must not be clipped (GP-30).
        "relative flex h-full w-full items-center gap-2 rounded-[7px] border-[1.5px] py-1.5 pr-3 pl-4 shadow-sm transition-shadow hover:shadow-md",
        changeClasses(graphNode.change),
        selected && "ring-primary ring-offset-background ring-2 ring-offset-1",
        impacted &&
          !selected &&
          "outline-impacted outline-2 outline-offset-2 outline-dashed",
        dimmed && "opacity-20",
      )}
    >
      {status && (
        <span
          aria-hidden="true"
          className={cn(
            "absolute top-1.5 bottom-1.5 left-1 w-[3.5px] rounded-full",
            STATUS_META[status].bg,
          )}
        />
      )}

      <ResourceIcon
        type={graphNode.type}
        className={cn("size-4 shrink-0", iconClass)}
      />

      <div className="min-w-0">
        <p
          className={cn(
            "text-ink truncate font-mono text-xs font-semibold",
            isDelete && "line-through",
          )}
        >
          {shortType(graphNode.type)}
        </p>
        <p className="text-faint truncate font-mono text-[10px]">
          {graphNode.name}
        </p>
      </div>

      {status ? (
        <StatusBadge kind={status} size="sm" className="absolute -top-2 -right-2" />
      ) : impacted ? (
        <StatusBadge
          kind="impacted"
          size="sm"
          className="absolute -top-2 -right-2"
        />
      ) : null}
    </div>
  );
}

/** React Flow node: the card plus (invisible) left/right connection handles. */
export const ResourceFlowNode = memo(function ResourceFlowNode({
  data,
}: NodeProps<FlowNode<GraphNodeData>>) {
  return (
    <div className="h-full w-full">
      <Handle type="target" position={Position.Left} className="!opacity-0" />
      <NodeCard
        graphNode={data.graphNode}
        selected={data.selected === true}
        dimmed={data.dimmed}
      />
      <Handle type="source" position={Position.Right} className="!opacity-0" />
    </div>
  );
});
