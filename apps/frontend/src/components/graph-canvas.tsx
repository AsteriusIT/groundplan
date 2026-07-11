import { useEffect, useMemo, useState } from "react";
import {
  Background,
  Controls,
  Handle,
  Position,
  ReactFlow,
  type Node as FlowNode,
  type NodeProps,
} from "@xyflow/react";
import ELK from "elkjs/lib/elk.bundled.js";
import { Eye, Loader2 } from "lucide-react";

import "@xyflow/react/dist/style.css";

import type { Graph, GraphNode } from "@/api/types";
import {
  changeClasses,
  elkToFlow,
  toElkGraph,
  type ElkGraphNode,
  type GraphNodeData,
} from "@/lib/graph-layout";
import { cn } from "@/lib/utils";
import { GraphLegend } from "@/components/graph-legend";
import { NodeDetailsPanel } from "@/components/node-details-panel";

const elk = new ELK();

function ResourceNode({ data }: NodeProps<FlowNode<GraphNodeData>>) {
  const { graphNode, dimmed } = data;
  return (
    <div
      className={cn(
        "flex h-full w-full flex-col justify-center rounded-md border px-3 py-1.5 shadow-sm transition-opacity",
        changeClasses(graphNode.change),
        dimmed && "opacity-30",
      )}
    >
      <Handle type="target" position={Position.Left} className="!opacity-0" />
      <p
        className={cn(
          "truncate font-mono text-xs font-medium",
          graphNode.change === "delete" && "line-through",
        )}
      >
        {graphNode.name}
      </p>
      <p className="truncate font-mono text-[10px] opacity-70">{graphNode.type}</p>
      <Handle type="source" position={Position.Right} className="!opacity-0" />
    </div>
  );
}

function ModuleNode({ data }: NodeProps<FlowNode<GraphNodeData>>) {
  return (
    <div className="border-primary/40 bg-primary/5 h-full w-full rounded-md border border-dashed">
      <div className="border-primary/20 border-b px-2 py-1">
        <span className="text-primary/80 font-mono text-[10px] font-medium">
          module.{data.graphNode.name}
        </span>
      </div>
    </div>
  );
}

const NODE_TYPES = { resource: ResourceNode, module: ModuleNode };

function ChangesOnlyToggle({
  checked,
  onChange,
}: {
  checked: boolean;
  onChange: (next: boolean) => void;
}) {
  return (
    <button
      type="button"
      aria-pressed={checked}
      onClick={() => onChange(!checked)}
      className={cn(
        "bg-card/90 inline-flex items-center gap-1.5 rounded-md border px-2.5 py-1.5 text-xs backdrop-blur transition-colors",
        checked
          ? "border-primary text-primary"
          : "border-border text-muted-foreground hover:text-foreground",
      )}
    >
      <Eye className="size-3.5" />
      Changes only
    </button>
  );
}

/**
 * Shared graph canvas (GP-17 / GP-18): renders a GraphSnapshot as an ELK-laid-out
 * React Flow diagram with module nesting and depends_on edges. `variant="docs"`
 * hides the change legend/filter (docs snapshots are all neutral).
 */
export function GraphCanvas({
  graph,
  variant = "plan",
}: {
  graph: Graph;
  variant?: "plan" | "docs";
}) {
  const [layout, setLayout] = useState<ElkGraphNode | null>(null);
  const [laying, setLaying] = useState(true);
  const [changesOnly, setChangesOnly] = useState(false);
  const [selected, setSelected] = useState<GraphNode | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLaying(true);
    setSelected(null);
    elk
      .layout(toElkGraph(graph))
      .then((result) => {
        if (!cancelled) {
          setLayout(result as ElkGraphNode);
          setLaying(false);
        }
      })
      .catch(() => {
        if (!cancelled) setLaying(false);
      });
    return () => {
      cancelled = true;
    };
  }, [graph]);

  const elements = useMemo(
    () => (layout ? elkToFlow(layout, graph, { changesOnly }) : { nodes: [], edges: [] }),
    [layout, graph, changesOnly],
  );

  return (
    <div className="relative h-full w-full">
      <ReactFlow
        nodes={elements.nodes}
        edges={elements.edges}
        nodeTypes={NODE_TYPES}
        onNodeClick={(_, node) =>
          setSelected((node.data as GraphNodeData).graphNode)
        }
        onPaneClick={() => setSelected(null)}
        nodesDraggable={false}
        nodesConnectable={false}
        minZoom={0.1}
        fitView
        proOptions={{ hideAttribution: true }}
      >
        <Background />
        <Controls showInteractive={false} />
      </ReactFlow>

      {laying && (
        <div
          className="bg-background/60 absolute inset-0 z-20 grid place-items-center"
          aria-busy="true"
        >
          <span className="text-muted-foreground inline-flex items-center gap-2 text-sm">
            <Loader2 className="size-4 animate-spin" />
            Laying out diagram…
          </span>
        </div>
      )}

      {variant === "plan" && (
        <div className="absolute top-3 left-3 z-10 flex items-start gap-2">
          <GraphLegend />
          <ChangesOnlyToggle checked={changesOnly} onChange={setChangesOnly} />
        </div>
      )}

      {selected && (
        <NodeDetailsPanel
          node={selected}
          onClose={() => setSelected(null)}
          showChange={variant === "plan"}
        />
      )}
    </div>
  );
}
