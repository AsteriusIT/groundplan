import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Background,
  Controls,
  Handle,
  Position,
  ReactFlow,
  type Node as FlowNode,
  type NodeProps,
  type ReactFlowInstance,
} from "@xyflow/react";
import ELK from "elkjs/lib/elk.bundled.js";
import { Loader2, RotateCcw, Search } from "lucide-react";

import "@xyflow/react/dist/style.css";

import type { Graph, GraphNode } from "@/api/types";
import {
  ALL_FILTERS,
  categoryOptions,
  changeClasses,
  elkToFlow,
  moduleOptions,
  toElkGraph,
  type ElkGraphNode,
  type FilterKey,
  type GraphNodeData,
} from "@/lib/graph-layout";
import { searchNodes } from "@/lib/graph-search";
import {
  categorize,
  CATEGORY_META,
  shortType,
  type Category,
} from "@/lib/resource-category";
import { cn } from "@/lib/utils";
import { NodeDetailsPanel } from "@/components/node-details-panel";

const elk = new ELK();

function ResourceNode({ data }: NodeProps<FlowNode<GraphNodeData>>) {
  const { graphNode, dimmed } = data;
  const { icon: Icon, className: iconClass } = CATEGORY_META[categorize(graphNode.type)];
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

function CheckRow({
  checked,
  onToggle,
  children,
}: {
  checked: boolean;
  onToggle: () => void;
  children: React.ReactNode;
}) {
  return (
    <label className="flex cursor-pointer items-center gap-1.5 text-xs">
      <input
        type="checkbox"
        checked={checked}
        onChange={onToggle}
        className="accent-primary size-3.5"
      />
      {children}
    </label>
  );
}

function toggle<T>(set: Set<T>, key: T): Set<T> {
  const next = new Set(set);
  if (next.has(key)) next.delete(key);
  else next.add(key);
  return next;
}

/**
 * Shared graph canvas (GP-17 / GP-24 / GP-25): an ELK-laid-out React Flow diagram
 * with type-first labels, category icons, module nesting, change/impact colouring,
 * search (fly-to), change/category/module filters and a selection highlight.
 * `variant="docs"` hides the change filters (docs snapshots have no change data).
 */
export function GraphCanvas({
  graph,
  variant = "plan",
}: {
  graph: Graph;
  variant?: "plan" | "docs";
}) {
  const categoryOpts = useMemo(() => categoryOptions(graph), [graph]);
  const moduleOpts = useMemo(() => moduleOptions(graph), [graph]);

  const [layout, setLayout] = useState<ElkGraphNode | null>(null);
  const [laying, setLaying] = useState(true);
  const [activeFilters, setActiveFilters] = useState(() => new Set(ALL_FILTERS));
  const [activeCategories, setActiveCategories] = useState(() => new Set(categoryOpts));
  const [activeModules, setActiveModules] = useState(() => new Set(moduleOpts));
  const [selected, setSelected] = useState<GraphNode | null>(null);
  const [query, setQuery] = useState("");

  const rfRef = useRef<ReactFlowInstance<FlowNode<GraphNodeData>> | null>(null);
  const searchRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    let cancelled = false;
    setLaying(true);
    setSelected(null);
    setQuery("");
    setActiveFilters(new Set(ALL_FILTERS));
    setActiveCategories(new Set(categoryOptions(graph)));
    setActiveModules(new Set(moduleOptions(graph)));
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

  // `/` focuses the search box (unless already typing in a field).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement | null;
      const typing = el && /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName);
      if (e.key === "/" && !typing) {
        e.preventDefault();
        searchRef.current?.focus();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const elements = useMemo(
    () =>
      layout
        ? elkToFlow(layout, graph, {
            activeFilters,
            activeCategories,
            activeModules,
            selectedId: selected?.id ?? null,
          })
        : { nodes: [], edges: [] },
    [layout, graph, activeFilters, activeCategories, activeModules, selected],
  );

  const resourceNodes = elements.nodes.filter((n) => n.type === "resource");
  const shown = resourceNodes.filter((n) => !n.data.dimmed).length;

  const flyTo = useCallback((node: GraphNode) => {
    setSelected(node);
    setQuery(""); // close the results dropdown once a result is chosen
    void rfRef.current?.fitView({ nodes: [{ id: node.id }], duration: 500, maxZoom: 1.5 });
  }, []);

  const results = useMemo(() => searchNodes(graph.nodes, query, 10), [graph, query]);

  const reset = () => {
    setActiveFilters(new Set(ALL_FILTERS));
    setActiveCategories(new Set(categoryOpts));
    setActiveModules(new Set(moduleOpts));
    setSelected(null);
    setQuery("");
  };

  return (
    <div className="relative h-full w-full">
      <ReactFlow
        nodes={elements.nodes}
        edges={elements.edges}
        nodeTypes={NODE_TYPES}
        onInit={(instance) => {
          rfRef.current = instance;
        }}
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

      {/* Search box + results (top centre). */}
      <div className="absolute top-3 left-1/2 z-10 w-72 -translate-x-1/2">
        <div className="bg-card/95 flex items-center gap-2 rounded-md border border-border px-2.5 py-1.5 shadow-sm backdrop-blur">
          <Search className="text-muted-foreground size-3.5 shrink-0" />
          <input
            ref={searchRef}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && results[0]) flyTo(results[0]);
              if (e.key === "Escape") setQuery("");
            }}
            placeholder="Search resources…  ( / )"
            aria-label="Search resources"
            className="placeholder:text-muted-foreground min-w-0 flex-1 bg-transparent text-xs outline-none"
          />
        </div>
        {query && results.length > 0 && (
          <ul className="bg-card mt-1 max-h-64 overflow-auto rounded-md border border-border shadow-lg">
            {results.map((node) => (
              <li key={node.id}>
                <button
                  type="button"
                  onClick={() => flyTo(node)}
                  className="hover:bg-accent flex w-full flex-col items-start px-2.5 py-1.5 text-left"
                >
                  <span className="font-mono text-xs font-medium">
                    {shortType(node.type)}
                  </span>
                  <span className="text-muted-foreground truncate font-mono text-[10px]">
                    {node.id}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>

      {/* Filters + counter (top left). */}
      <div className="bg-card/90 absolute top-3 left-3 z-10 max-h-[calc(100%-1.5rem)] w-44 overflow-auto rounded-md border border-border p-3 backdrop-blur">
        {variant === "plan" && (
          <FilterSection title="Change">
            {ALL_FILTERS.map((key) => (
              <CheckRow
                key={key}
                checked={activeFilters.has(key)}
                onToggle={() => setActiveFilters((s) => toggle(s, key))}
              >
                <span className={cn("size-2.5 rounded-xs", FILTER_SWATCH[key])} />
                {FILTER_LABELS[key]}
              </CheckRow>
            ))}
          </FilterSection>
        )}

        {categoryOpts.length > 0 && (
          <FilterSection title="Category">
            {categoryOpts.map((cat) => {
              const meta = CATEGORY_META[cat];
              return (
                <CheckRow
                  key={cat}
                  checked={activeCategories.has(cat)}
                  onToggle={() =>
                    setActiveCategories((s) => toggle<Category>(s, cat))
                  }
                >
                  <meta.icon className={cn("size-3", meta.className)} />
                  {meta.label}
                </CheckRow>
              );
            })}
          </FilterSection>
        )}

        {moduleOpts.length > 0 && (
          <FilterSection title="Module">
            {moduleOpts.map((mod) => (
              <CheckRow
                key={mod}
                checked={activeModules.has(mod)}
                onToggle={() => setActiveModules((s) => toggle(s, mod))}
              >
                <span className="truncate">{mod}</span>
              </CheckRow>
            ))}
          </FilterSection>
        )}

        <div className="mt-3 flex items-center justify-between border-t border-border pt-2">
          <span className="text-muted-foreground font-mono text-[10px]">
            {shown} of {resourceNodes.length} shown
          </span>
          <button
            type="button"
            onClick={reset}
            className="text-muted-foreground hover:text-foreground inline-flex items-center gap-1 text-[10px]"
          >
            <RotateCcw className="size-3" />
            Reset
          </button>
        </div>
      </div>

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

function FilterSection({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  return (
    <div className="mb-2 last:mb-0">
      <p className="text-muted-foreground mb-1 font-mono text-[10px] tracking-wide uppercase">
        {title}
      </p>
      <ul className="space-y-0.5">{children}</ul>
    </div>
  );
}
