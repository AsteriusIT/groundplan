import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Background,
  BackgroundVariant,
  ReactFlow,
  type Node as FlowNode,
  type NodeProps,
  type ReactFlowInstance,
} from "@xyflow/react";
import ELK from "elkjs/lib/elk.bundled.js";
import { Loader2, Maximize2, Minus, Plus, RotateCcw, Search, Waypoints } from "lucide-react";

import "@xyflow/react/dist/style.css";

import type { Graph, GraphNode } from "@/api/types";
import {
  ALL_FILTERS,
  categoryOptions,
  elkToFlow,
  moduleOptions,
  toElkGraph,
  type ElkGraphNode,
  type FilterKey,
  type GraphNodeData,
} from "@/lib/graph-layout";
import { searchNodes } from "@/lib/graph-search";
import { detectHubs } from "@/lib/hub";
import {
  CATEGORY_META,
  shortType,
  type Category,
} from "@/lib/resource-category";
import { cn } from "@/lib/utils";
import { NodeDetailsPanel } from "@/components/node-details-panel";
import { ResourceFlowNode } from "@/components/graph-node";
import { EdgeArrowMarkers, RelationshipEdge } from "@/components/graph-edge";

const elk = new ELK();

function ModuleNode({ data }: NodeProps<FlowNode<GraphNodeData>>) {
  // A near-transparent dashed boundary with a floating mono label, like the
  // mockup's module containers (GP-31).
  return (
    <div
      className={cn(
        "border-border-strong bg-accent-soft/25 relative h-full w-full rounded-lg border border-dashed transition-opacity",
        data.dimmed && "opacity-40",
      )}
    >
      <span className="bg-canvas text-muted-foreground absolute -top-2.5 left-3 px-1.5 font-mono text-[10px] font-medium tracking-wide">
        module.{data.graphNode.name}
      </span>
    </div>
  );
}

const NODE_TYPES = { resource: ResourceFlowNode, module: ModuleNode };
const EDGE_TYPES = { relationship: RelationshipEdge };

const FILTER_LABELS: Record<FilterKey, string> = {
  create: "Create",
  update: "Update",
  delete: "Delete",
  noop: "No change",
  impacted: "Impacted",
};

const FILTER_SWATCH: Record<FilterKey, string> = {
  create: "bg-create",
  update: "bg-update",
  delete: "bg-delete",
  noop: "bg-edge",
  impacted: "bg-impacted",
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
  focusNodeId,
}: {
  graph: Graph;
  variant?: "plan" | "docs";
  /** When set/changed, select that node and fly to it (GP-40 compare lists). */
  focusNodeId?: string | null;
}) {
  const categoryOpts = useMemo(() => categoryOptions(graph), [graph]);
  const moduleOpts = useMemo(() => moduleOptions(graph), [graph]);
  const hubs = useMemo(() => detectHubs(graph), [graph]);

  const [layout, setLayout] = useState<ElkGraphNode | null>(null);
  const [laying, setLaying] = useState(true);
  const [activeFilters, setActiveFilters] = useState(() => new Set(ALL_FILTERS));
  const [activeCategories, setActiveCategories] = useState(() => new Set(categoryOpts));
  const [activeModules, setActiveModules] = useState(() => new Set(moduleOpts));
  const [selected, setSelected] = useState<GraphNode | null>(null);
  const [showHubEdges, setShowHubEdges] = useState(false);
  const [query, setQuery] = useState("");
  const [zoom, setZoom] = useState(1);

  const rfRef = useRef<ReactFlowInstance<FlowNode<GraphNodeData>> | null>(null);
  const searchRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    let cancelled = false;
    setLaying(true);
    setSelected(null);
    setQuery("");
    setShowHubEdges(false);
    setActiveFilters(new Set(ALL_FILTERS));
    setActiveCategories(new Set(categoryOptions(graph)));
    setActiveModules(new Set(moduleOptions(graph)));
    elk
      .layout(toElkGraph(graph, detectHubs(graph)))
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
            hubs,
            showHubEdges,
          })
        : { nodes: [], edges: [] },
    [layout, graph, activeFilters, activeCategories, activeModules, selected, hubs, showHubEdges],
  );

  const resourceNodes = elements.nodes.filter((n) => n.type === "resource");
  const shown = resourceNodes.filter((n) => !n.data.dimmed).length;

  const flyTo = useCallback((node: GraphNode) => {
    setSelected(node);
    setQuery(""); // close the results dropdown once a result is chosen
    void rfRef.current?.fitView({ nodes: [{ id: node.id }], duration: 500, maxZoom: 1.5 });
  }, []);

  // Fly to a node requested from outside (GP-40 compare summary lists).
  useEffect(() => {
    if (!focusNodeId) return;
    const node = graph.nodes.find((n) => n.id === focusNodeId);
    if (node) flyTo(node);
  }, [focusNodeId, graph, flyTo]);

  const results = useMemo(() => searchNodes(graph.nodes, query, 10), [graph, query]);

  const reset = () => {
    setActiveFilters(new Set(ALL_FILTERS));
    setActiveCategories(new Set(categoryOpts));
    setActiveModules(new Set(moduleOpts));
    setSelected(null);
    setShowHubEdges(false);
    setQuery("");
  };

  return (
    <div className="relative h-full w-full">
      <EdgeArrowMarkers />
      <ReactFlow
        nodes={elements.nodes}
        edges={elements.edges}
        nodeTypes={NODE_TYPES}
        edgeTypes={EDGE_TYPES}
        onInit={(instance) => {
          rfRef.current = instance;
          setZoom(instance.getZoom());
        }}
        onMove={(_, viewport) => setZoom(viewport.zoom)}
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
        {/* Blueprint grid: a fine 24px grid with a bold line every 120px. */}
        <Background
          id="fine"
          variant={BackgroundVariant.Lines}
          gap={24}
          lineWidth={1}
          color="var(--grid-line)"
        />
        <Background
          id="bold"
          variant={BackgroundVariant.Lines}
          gap={120}
          lineWidth={1}
          color="var(--grid-strong)"
        />
      </ReactFlow>

      {/* Floating zoom toolbar (top-right). */}
      <div className="bg-card/90 absolute top-3 right-3 z-10 flex flex-col overflow-hidden rounded-md border border-border shadow-sm backdrop-blur">
        <ToolbarButton label="Zoom in" onClick={() => rfRef.current?.zoomIn()}>
          <Plus className="size-4" />
        </ToolbarButton>
        <ToolbarButton
          label="Zoom out"
          onClick={() => rfRef.current?.zoomOut()}
          className="border-t border-border"
        >
          <Minus className="size-4" />
        </ToolbarButton>
        <ToolbarButton
          label="Fit view"
          onClick={() => rfRef.current?.fitView({ duration: 300 })}
          className="border-t border-border"
        >
          <Maximize2 className="size-4" />
        </ToolbarButton>
      </div>

      {/* Zoom % + interaction hints (bottom-right). */}
      <div className="bg-card/90 text-muted-foreground absolute right-3 bottom-3 z-10 flex items-center gap-2 rounded-md border border-border px-2.5 py-1 shadow-sm backdrop-blur">
        <span className="text-ink font-mono text-xs tabular-nums">
          {Math.round(zoom * 100)}%
        </span>
        <span className="text-faint hidden text-[10px] sm:inline">
          scroll to zoom · drag to pan
        </span>
      </div>

      {/* Status legend (bottom-left). */}
      {variant === "plan" && (
        <div className="bg-card/90 absolute bottom-3 left-3 z-10 flex flex-wrap items-center gap-x-3 gap-y-1 rounded-md border border-border px-3 py-1.5 shadow-sm backdrop-blur">
          {ALL_FILTERS.map((key) => (
            <span
              key={key}
              className="text-muted-foreground inline-flex items-center gap-1.5 font-mono text-[10px]"
            >
              <span className={cn("size-2 rounded-full", FILTER_SWATCH[key])} />
              {FILTER_LABELS[key]}
            </span>
          ))}
        </div>
      )}

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

        {/* GP-35: hub edges are hidden by default; this restores them all. */}
        {hubs.size > 0 && (
          <FilterSection title="Connections">
            <CheckRow
              checked={showHubEdges}
              onToggle={() => setShowHubEdges((v) => !v)}
            >
              <Waypoints className="text-muted-foreground size-3" />
              Show hub connections
            </CheckRow>
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
          graph={graph}
          node={selected}
          onClose={() => setSelected(null)}
          onSelect={flyTo}
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

function ToolbarButton({
  label,
  onClick,
  className,
  children,
}: {
  label: string;
  onClick: () => void;
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      onClick={onClick}
      className={cn(
        "text-muted-foreground hover:bg-accent hover:text-foreground grid size-8 place-items-center transition-colors",
        className,
      )}
    >
      {children}
    </button>
  );
}
