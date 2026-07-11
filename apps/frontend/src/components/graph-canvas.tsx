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
import { Loader2 } from "lucide-react";

import "@xyflow/react/dist/style.css";

import type { Graph, GraphNode } from "@/api/types";
import {
  ALL_FILTERS,
  changeClasses,
  elkToFlow,
  toElkGraph,
  type ElkGraphNode,
  type FilterKey,
  type GraphNodeData,
} from "@/lib/graph-layout";
import { categorize, CATEGORY_META, shortType } from "@/lib/resource-category";
import { cn } from "@/lib/utils";
import { NodeDetailsPanel } from "@/components/node-details-panel";

const elk = new ELK();

function ResourceNode({ data }: NodeProps<FlowNode<GraphNodeData>>) {
  const { graphNode, dimmed } = data;
  const category = categorize(graphNode.type);
  const { icon: Icon, className: iconClass } = CATEGORY_META[category];
  return (
    <div
      title={graphNode.type}
      className={cn(
        "flex h-full w-full flex-col justify-center rounded-md border px-3 py-1.5 shadow-sm transition-opacity",
        changeClasses(graphNode.change),
        graphNode.impacted &&
          "outline-2 outline-offset-2 outline-dashed outline-violet-500",
        dimmed && "opacity-20",
      )}
    >
      <Handle type="target" position={Position.Left} className="!opacity-0" />
      <div className="flex items-center gap-1.5">
        <Icon className={cn("size-3.5 shrink-0", iconClass)} />
        <p
          className={cn(
            "truncate font-mono text-xs font-semibold",
            graphNode.change === "delete" && "line-through",
          )}
        >
          {shortType(graphNode.type)}
        </p>
      </div>
      <p className="truncate pl-5 font-mono text-[10px] opacity-70">
        {graphNode.name}
      </p>
      <Handle type="source" position={Position.Right} className="!opacity-0" />
    </div>
  );
}

function ModuleNode({ data }: NodeProps<FlowNode<GraphNodeData>>) {
  return (
    <div
      className={cn(
        "border-primary/40 bg-primary/5 h-full w-full rounded-md border border-dashed transition-opacity",
        data.dimmed && "opacity-30",
      )}
    >
      <div className="border-primary/20 border-b px-2 py-1">
        <span className="text-primary/80 font-mono text-[10px] font-medium">
          module.{data.graphNode.name}
        </span>
      </div>
    </div>
  );
}

const NODE_TYPES = { resource: ResourceNode, module: ModuleNode };

const FILTER_LABELS: Record<FilterKey, string> = {
  create: "Create",
  update: "Update",
  delete: "Delete",
  noop: "No change",
  impacted: "Impacted",
};

const FILTER_SWATCH: Record<FilterKey, string> = {
  create: "bg-emerald-400",
  update: "bg-amber-400",
  delete: "bg-destructive/70",
  noop: "bg-border",
  impacted: "bg-violet-500",
};

/** Change/impact filter checkboxes — doubles as the colour legend (GP-24). */
function ChangeFilters({
  active,
  onToggle,
}: {
  active: ReadonlySet<FilterKey>;
  onToggle: (key: FilterKey) => void;
}) {
  return (
    <div className="bg-card/90 rounded-md border border-border px-3 py-2 backdrop-blur">
      <p className="text-muted-foreground mb-1.5 font-mono text-[10px] tracking-wide uppercase">
        Filter
      </p>
      <ul className="space-y-0.5">
        {ALL_FILTERS.map((key) => (
          <li key={key}>
            <label className="flex cursor-pointer items-center gap-1.5 text-xs">
              <input
                type="checkbox"
                checked={active.has(key)}
                onChange={() => onToggle(key)}
                className="accent-primary size-3.5"
              />
              <span className={cn("size-2.5 rounded-xs", FILTER_SWATCH[key])} />
              {FILTER_LABELS[key]}
            </label>
          </li>
        ))}
      </ul>
    </div>
  );
}

/**
 * Shared graph canvas (GP-17 / GP-24): an ELK-laid-out React Flow diagram with
 * type-first labels, category icons, module nesting, change coloring, impact
 * highlighting, filters and a selection neighbourhood highlight. `variant="docs"`
 * hides the change filters (docs snapshots have no change data).
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
  const [activeFilters, setActiveFilters] = useState<Set<FilterKey>>(
    () => new Set(ALL_FILTERS),
  );
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
    () =>
      layout
        ? elkToFlow(layout, graph, {
            activeFilters,
            selectedId: selected?.id ?? null,
          })
        : { nodes: [], edges: [] },
    [layout, graph, activeFilters, selected],
  );

  const toggleFilter = (key: FilterKey) =>
    setActiveFilters((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });

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
        <div className="absolute top-3 left-3 z-10">
          <ChangeFilters active={activeFilters} onToggle={toggleFilter} />
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
