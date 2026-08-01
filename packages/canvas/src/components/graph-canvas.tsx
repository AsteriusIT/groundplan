import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from "react";
import {
  Background,
  BackgroundVariant,
  Handle,
  Position,
  ReactFlow,
  SelectionMode,
  type Edge as FlowEdge,
  type Node as FlowNode,
  type NodeChange,
  type NodeProps,
  type ReactFlowInstance,
} from "@xyflow/react";
import ELK from "elkjs/lib/elk.bundled.js";
import {
  ChevronDown,
  EyeOff,
  Group,
  Link2,
  Loader2,
  Maximize2,
  Minus,
  MousePointer2,
  Plus,
  RotateCcw,
  Search,
  SlidersHorizontal,
  Trash2,
  Type,
  Waypoints,
  X,
} from "lucide-react";

import "@xyflow/react/dist/style.css";

import type {
  Annotation,
  AttributeDiffRow,
  CreateAnnotationInput,
  Graph,
  GraphNode,
  LintFinding,
  UpdateAnnotationInput,
} from "../types";
import {
  absoluteNodeBoxes,
  annotationLinkEdges,
  groupFrames,
  groupFrameNodeId,
  hiddenNodeIds,
  notedNodeIds,
  notesForNode,
  renamedLabels,
  renderableAnnotations,
} from "../lib/annotations";
import {
  INITIAL_TOOL,
  isMultiSelectTool,
  linkIsReady,
  reduceTool,
  renameIsReady,
  type AnnotateTool,
} from "../lib/annotate-tool";
import { NotePanel } from "../components/note-editor";
import { COACH_MARK_GUTTER, TourSpotlight } from "../components/tour-spotlight";
import type { TourChrome } from "../components/tour-chrome";
import type { TourStyle } from "../types";
import { changedFocusIds, isNodeOnScreen, planCamera } from "../lib/camera";
import {
  ALL_FILTERS,
  categoryCounts,
  categoryOptions,
  changeCounts,
  elkToFlow,
  moduleCounts,
  moduleOptions,
  reanchorStackEdges,
  toElkGraph,
  type ElkGraphNode,
  type FilterKey,
  type GraphNodeData,
} from "../lib/graph-layout";
import { buildLegendModel, FILTER_LABELS, FILTER_SWATCH } from "../lib/legend";
import { searchNodes } from "../lib/graph-search";
import { detectHubs } from "../lib/hub";
import {
  CATEGORY_META,
  shortType,
  type Category,
} from "../lib/resource-category";
import { cn } from "../lib/utils";
import { NodeDetailsPanel } from "../components/node-details-panel";
import { ResourceIcon } from "../components/resource-icon";
import { ResourceFlowNode } from "../components/graph-node";
import { NetworkContainerNode } from "../components/network-container-node";
import { GroupContainerNode } from "../components/group-container-node";
import { AiBadge } from "../components/ui/ai-badge";
import { EdgeArrowMarkers, RelationshipEdge } from "../components/graph-edge";

const elk = new ELK();

/**
 * A placeholder graphNode for annotation overlay nodes (group frames / note
 * pins), which carry their own `data` (label / count / nodeId) and never read
 * `graphNode`. Satisfies the shared GraphNodeData shape without a real node.
 */
/** The note pin's rendered size (`size-4`), declared so it is never re-measured. */
const NOTE_PIN_SIZE = 16;

const OVERLAY_STUB = {
  id: "",
  name: "",
  type: "",
  provider: null,
  module_path: [],
  change: null,
} as GraphNode;

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

/**
 * A group annotation (GP-58): a soft accent-toned frame with a floating label,
 * drawn behind its members. The frame itself is `pointer-events-none` so it never
 * steals clicks from the resources it surrounds — it is decoration, not an ELK
 * container. Only its *label* is clickable, and only while the link tool is live:
 * that is how you draw an edge from a whole group (GP-73).
 */
function AnnotationGroupNode({ data }: NodeProps<FlowNode<GraphNodeData>>) {
  const pickable = Boolean(data.pickable);
  const picked = Boolean(data.picked);
  return (
    <div
      className={cn(
        "pointer-events-none h-full w-full rounded-xl border border-dashed",
        picked ? "border-primary bg-primary/10" : "border-primary/50 bg-primary/5",
      )}
    >
      {/* Handles let a group→group logical edge attach to the frame (GP-73). */}
      <Handle type="target" position={Position.Left} className="!opacity-0" />
      <Handle type="source" position={Position.Right} className="!opacity-0" />
      <span
        className={cn(
          "bg-canvas text-primary absolute -top-2.5 left-3 px-1.5 font-mono text-[10px] font-medium tracking-wide",
          pickable && "pointer-events-auto cursor-pointer underline underline-offset-2",
        )}
      >
        {String(data.label ?? "group")}
      </span>
    </div>
  );
}

/** A note indicator pinned to a resource's corner (GP-58). */
function AnnotationNotePin({ data }: NodeProps<FlowNode<GraphNodeData>>) {
  return (
    <div
      title="Has a note"
      className="bg-primary text-primary-foreground grid size-4 place-items-center rounded-full text-[9px] shadow-sm"
    >
      {String(data.count ?? 1)}
    </div>
  );
}

const NODE_TYPES = {
  resource: ResourceFlowNode,
  module: ModuleNode,
  container: NetworkContainerNode,
  // A container the projection injected from a `group` annotation (GP-74) — a
  // different thing from `annotationGroup`, which is the overlay frame drawn on
  // the *raw* canvas without entering the layout at all.
  groupContainer: GroupContainerNode,
  annotationGroup: AnnotationGroupNode,
  annotationNote: AnnotationNotePin,
};
const EDGE_TYPES = { relationship: RelationshipEdge };

/**
 * The viewport before the first layout lands. Once ELK positions exist the
 * canvas frames the whole graph (`fitView`, GP-130) — on the first render and
 * again on every relayout — so a Visualize never opens on empty canvas. A
 * manual pan/zoom is only ever overridden by a *graph change*, never by a
 * re-render of the same snapshot.
 */
const DEFAULT_VIEWPORT = { x: 220, y: 72, zoom: 1 } as const;

const FIT_VIEW_PADDING = 0.1;
/** GP-156: framing the blast radius leaves it room and never over-zooms —
 * a single changed node must not fill the screen. */
const BLAST_FIT_PADDING = 0.2;
const BLAST_FIT_MAX_ZOOM = 1.5;

function CheckRow({
  checked,
  onToggle,
  count,
  children,
}: Readonly<{
  checked: boolean;
  onToggle: () => void;
  /** How many resources this option covers — what unticking it will cost you. */
  count?: number;
  children: React.ReactNode;
}>) {
  return (
    <label className="flex cursor-pointer items-center gap-1.5 text-xs">
      <input
        type="checkbox"
        checked={checked}
        onChange={onToggle}
        className="accent-primary size-3.5"
      />
      <span className="flex min-w-0 flex-1 items-center gap-1.5">{children}</span>
      {count !== undefined && (
        <span className="text-muted-foreground shrink-0 font-mono text-[10px] tabular-nums">
          {count}
        </span>
      )}
    </label>
  );
}

/**
 * What a line means. Dashed vs solid already carried a real distinction — an
 * expression-inferred reference vs an explicit `depends_on` (GP-20) — but nothing
 * on screen said so, which turns a deterministic encoding into a guess.
 */
function EdgeLegend({
  graph,
  variant,
}: Readonly<{
  graph: Graph;
  variant: "plan" | "docs";
}>) {
  // `presentOnly: false` — the canvas legend has always listed every change
  // state under variant="plan", and this is not the place to change that.
  // Filtering to what is on screen is the VS Code panel's opt-in.
  const model = buildLegendModel(graph, { variant, presentOnly: false });
  return (
    <div className="bg-card/90 text-muted-foreground absolute bottom-3 left-3 z-10 flex flex-wrap items-center gap-x-3 gap-y-1 rounded-md border border-border px-3 py-1.5 shadow-sm backdrop-blur">
      {model.changes.map(({ key, label, swatch }) => (
        <span
          key={key}
          className="inline-flex items-center gap-1.5 font-mono text-[10px]"
        >
          <span className={cn("size-2 rounded-full", swatch)} />
          {label}
        </span>
      ))}
      {model.notes.map(({ key, label }) => (
        <span
          key={key}
          className="inline-flex items-center gap-1.5 font-mono text-[10px]"
        >
          <span className="bg-muted border-border size-2 rounded-full border" />
          {label}
        </span>
      ))}
      {model.edges.map(({ key, label, dashed }) => (
        <span
          key={key}
          className="inline-flex items-center gap-1.5 font-mono text-[10px]"
        >
          <svg width="18" height="6" aria-hidden="true">
            <line
              x1="0"
              y1="3"
              x2="18"
              y2="3"
              strokeWidth="1.5"
              strokeDasharray={dashed ? "4 3" : undefined}
              className={dashed ? "stroke-edge-inferred" : "stroke-edge"}
            />
          </svg>
          {label}
        </span>
      ))}
    </div>
  );
}

/** The badge shows one colour: the node's worst finding wins. */
function worstLintSeverity(
  findings: LintFinding[] | undefined,
): LintFinding["severity"] | undefined {
  if (!findings || findings.length === 0) return undefined;
  if (findings.some((f) => f.severity === "high")) return "high";
  if (findings.some((f) => f.severity === "warn")) return "warn";
  return "info";
}

function toggle<T>(set: ReadonlySet<T>, key: T): Set<T> {
  const next = new Set(set);
  if (next.has(key)) next.delete(key);
  else next.add(key);
  return next;
}

/** Invert an attachment map (anchor id → attached nodes) to attached id → anchor
 * id, keeping the first anchor for a node listed under several (GP-87/89). */
function attachAnchors(
  groups?: ReadonlyMap<string, GraphNode[]>,
): Map<string, string> {
  const map = new Map<string, string>();
  for (const [anchorId, nodes] of groups ?? []) {
    for (const node of nodes) if (!map.has(node.id)) map.set(node.id, anchorId);
  }
  return map;
}


/**
 * Which built-in chrome the canvas draws. Every field defaults to true, so a
 * consumer that says nothing gets exactly what the canvas has always drawn.
 *
 * `zoom` covers the +/−/fit cluster and the zoom-% chip together: they are one
 * idea to a reader, even though the code places them as two blocks.
 */
export type CanvasChrome = {
  search?: boolean;
  filters?: boolean;
  legend?: boolean;
  zoom?: boolean;
};

/** The filter state, when a consumer wants to own it (and draw it itself). */
export type CanvasFilters = {
  change: ReadonlySet<FilterKey>;
  categories: ReadonlySet<Category>;
  modules: ReadonlySet<string>;
  hubEdges: boolean;
};

/**
 * The camera, for a consumer that hid `chrome.zoom` and draws its own controls.
 * Imperative because that is what a camera is: "frame these" is an event, not a
 * value the canvas could derive from props without fighting the user's pan.
 */
export type CanvasCamera = {
  zoomIn(): void;
  zoomOut(): void;
  /** Frame these nodes. No ids — or none present — frames the whole graph. */
  fit(nodeIds?: readonly string[]): void;
  reveal(nodeId: string): void;
};

/**
 * The filters, owned here or by the caller.
 *
 * Uncontrolled is the default and the existing behaviour: four sets living in
 * this component, reset when the graph changes. Controlled hands them out, so
 * a consumer drawing its own filter chrome can render the same truth the
 * diagram is dimmed by — two sources for "which filters are on" is how a chip
 * ends up claiming a filter the graph is not actually under.
 */
function useCanvasFilters({
  filters,
  onFiltersChange,
  categoryOpts,
  moduleOpts,
}: {
  filters?: CanvasFilters;
  onFiltersChange?: (next: CanvasFilters) => void;
  categoryOpts: Category[];
  moduleOpts: string[];
}): {
  filters: CanvasFilters;
  set: (next: CanvasFilters) => void;
  controlled: boolean;
} {
  const [own, setOwn] = useState<CanvasFilters>(() => ({
    change: new Set(ALL_FILTERS),
    categories: new Set(categoryOpts),
    modules: new Set(moduleOpts),
    hubEdges: false,
  }));
  const controlled = filters !== undefined;
  return {
    filters: filters ?? own,
    set: (next) => {
      if (controlled) onFiltersChange?.(next);
      else setOwn(next);
    },
    controlled,
  };
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
  diffEmphasis = false,
  focusNodeId,
  selectedAddress,
  revealSelection = "always",
  onNodeSelect,
  detailsPanel = true,
  chrome,
  filters,
  onFiltersChange,
  cameraRef,
  containerIds,
  stacks,
  chips,
  annotations,
  annotate = false,
  onCreateAnnotation,
  onUpdateAnnotation,
  onDeleteAnnotation,
  onExpandGroup,
  highlightIds,
  lint,
  findingsLabel,
  drift,
  driftRows,
  tour,
}: Readonly<{
  graph: Graph;
  variant?: "plan" | "docs";
  /**
   * GP-155: diff-mode visual hierarchy — recede the unchanged estate so the
   * changed + impacted set dominates. On for the diff views only (the PR
   * view's DIFF ref, the VS Code extension's diff mode); off leaves every
   * node at equal weight, exactly as before.
   */
  diffEmphasis?: boolean;
  /** When set/changed, select that node and fly to it (GP-40 compare lists). */
  focusNodeId?: string | null;
  /**
   * GP-146: controlled external selection (the VS Code webview's cursor→node
   * lane, GP-149). Set = select that node, open its panel and reveal it; null =
   * clear; undefined = uncontrolled. Unlike `focusNodeId`, it can clear — and a
   * selection it caused is never echoed back through `onNodeSelect`.
   */
  selectedAddress?: string | null;
  /**
   * Whether an external `selectedAddress` always recentres the camera.
   *
   * `"always"` (the default, and every existing caller) flies to the node on
   * every change. `"offscreen"` flies only when the node is not already
   * visible — which is what a cursor-following consumer wants: recentring on a
   * card the reader is already looking at makes panning feel broken, because
   * the view snaps back on the next keystroke.
   */
  revealSelection?: "always" | "offscreen";
  /**
   * GP-146: selection reported out — the clicked node, or null when the user
   * clears the selection. Fired for user interactions only, never for a
   * selection `selectedAddress` drove in (no feedback loops, GP-149).
   */
  onNodeSelect?: (node: GraphNode | null) => void;
  /**
   * Render the details side panel for the selected node (default). The VS
   * Code webview turns it off: clicking a node there opens the HCL block in
   * the editor beside the diagram, and a panel repeating that code would just
   * cover the canvas. Selection, highlight and `onNodeSelect` still work.
   */
  detailsPanel?: boolean;
  /**
   * Which built-in chrome to draw. Omitted — or any field omitted — leaves it
   * on, so this changes nothing for a consumer that does not ask.
   *
   * The VS Code panel turns all four off: it draws a toolbar, a legend popover
   * and a zoom overlay of its own, and a second set underneath is exactly the
   * crowding this exists to remove.
   */
  chrome?: CanvasChrome;
  /** Controlled filter state. Absent = the canvas owns it, exactly as today. */
  filters?: CanvasFilters;
  onFiltersChange?: (next: CanvasFilters) => void;
  /**
   * Filled with the camera once React Flow is ready, cleared on unmount. For a
   * consumer that hid `chrome.zoom` and needs a way to drive the view.
   */
  cameraRef?: React.RefObject<CanvasCamera | null>;
  /** vnet/subnet ids to render as containers even when empty (GP-44 network view). */
  containerIds?: ReadonlySet<string>;
  /** GP-87: host id → its stacked satellite children (network view only). Their
   * cards render as rows inside the host; ELK never lays them out. */
  stacks?: ReadonlyMap<string, GraphNode[]>;
  /** GP-89: subnet id → the NSG / route-table chips on its header (network view). */
  chips?: ReadonlyMap<string, GraphNode[]>;
  /** GP-58: the annotation layer. Rendered as an overlay in every mode; when
   * absent the canvas behaves exactly as before (no annotate affordances). */
  annotations?: Annotation[];
  /** GP-58: enable editing (tools + note editor). Off = read-only overlay. */
  annotate?: boolean;
  onCreateAnnotation?: (input: CreateAnnotationInput) => void;
  onUpdateAnnotation?: (id: string, input: UpdateAnnotationInput) => void;
  onDeleteAnnotation?: (id: string) => void;
  /**
   * GP-77: clicking a group node in C4 drills into it. Given the *annotation* id
   * (not the node id), so the caller can ask the server to expand that one group
   * and leave the rest collapsed. Absent outside C4, where a group is a container
   * you can already see into.
   */
  onExpandGroup?: (annotationId: string) => void;
  /**
   * GP-76: nodes to light up from outside the canvas — hovering a proposal in the
   * review inbox flashes the resources it is about. It reuses the picked
   * treatment, because that is exactly what it means: these are the nodes in
   * question. Transient, and never anything the user has committed to.
   */
  highlightIds?: ReadonlySet<string>;
  /**
   * GP-142: best-practices findings by node id (the studio's lint pass). A
   * node with findings wears a severity badge; its detail panel grows a
   * "Best practices" section. Absent = the canvas behaves exactly as before.
   */
  lint?: ReadonlyMap<string, LintFinding[]>;
  /**
   * What those findings are called here. The badge mechanic is shared: the
   * studio calls them best practices, the policy engine calls them violations
   * (GP-202), and the canvas does not care which — it only draws them.
   */
  findingsLabel?: string;
  /**
   * GP-207: node id → what drifted about it, for the resources a
   * `terraform plan -refresh-only` found had changed outside Terraform. Those
   * nodes wear the drift mark in every lens, because a resource somebody edited
   * in the portal is that resource whichever way you are looking at it.
   *
   * A map of labels rather than a set of ids, so the mark can say *what* moved
   * without the canvas knowing anything about drift reports.
   */
  drift?: ReadonlyMap<string, string>;
  /**
   * GP-207: node id → the masked before→after rows for what drifted, shown in
   * the node's detail panel. Separate from `drift` because the mark is cheap and
   * the rows are not: a lens that only needs badges passes the first alone.
   */
  driftRows?: ReadonlyMap<string, AttributeDiffRow[]>;
  /**
   * GP-79: the tour stop currently being narrated, if one is. The canvas is what a
   * tour *does* — it flies the camera to the stop's anchors and pushes everything
   * else back — so it takes the stop, not the whole tour: it has no idea how many
   * steps there are or where they came from, and it cannot advance one.
   *
   * `chrome: "spotlight"` additionally pins the card to the nodes in question,
   * which has to happen in here because only a child of `<ReactFlow>` can. The
   * guide rail lives outside the canvas and asks for nothing but the camera.
   */
  tour?: (TourChrome & { chrome: TourStyle }) | null;
}>) {
  const categoryOpts = useMemo(() => categoryOptions(graph), [graph]);
  const moduleOpts = useMemo(() => moduleOptions(graph), [graph]);
  // What each filter option covers, so a checkbox says what unticking it costs.
  const changeCount = useMemo(() => changeCounts(graph), [graph]);
  const categoryCount = useMemo(() => categoryCounts(graph), [graph]);
  const moduleCount = useMemo(() => moduleCounts(graph), [graph]);

  const [layout, setLayout] = useState<ElkGraphNode | null>(null);
  const [laying, setLaying] = useState(true);
  const {
    filters: activeFilterState,
    set: setFilterState,
    controlled: filtersControlled,
  } = useCanvasFilters({ filters, onFiltersChange, categoryOpts, moduleOpts });
  const activeFilters = activeFilterState.change;
  const activeCategories = activeFilterState.categories;
  const activeModules = activeFilterState.modules;
  const showHubEdges = activeFilterState.hubEdges;
  const [selected, setSelected] = useState<GraphNode | null>(null);
  const [hoveredId, setHoveredId] = useState<string | null>(null);
  // Which host each stacked child belongs to (GP-87), which subnet each chip
  // belongs to (GP-89), and — for edge re-anchoring / hub detection — both at once.
  const childToHost = useMemo(() => attachAnchors(stacks), [stacks]);
  const chipToAnchor = useMemo(() => attachAnchors(chips), [chips]);
  // GP-87/89: the attached node (a stacked row or a chip) whose ring is lit —
  // exactly the current selection, when the selection *is* an attached node.
  // Derived, never stored: the ring follows the selection and cannot go stale
  // on a chip after you select something else or click the pane.
  const highlightedChild =
    selected && childToHost.has(selected.id) ? selected.id : null;
  const highlightedChip =
    selected && chipToAnchor.has(selected.id) ? selected.id : null;
  const anchorOf = useMemo(() => {
    const map = new Map(childToHost);
    for (const [id, subnet] of chipToAnchor) if (!map.has(id)) map.set(id, subnet);
    return map;
  }, [childToHost, chipToAnchor]);

  // Selecting an attached node (row / chip click) opens its own detail panel and
  // lights it — the camera stays put, since it is already on screen on its host.
  const selectStackChild = useCallback((child: GraphNode) => {
    setSelected(child);
  }, []);
  const selectChip = useCallback((node: GraphNode) => {
    setSelected(node);
  }, []);

  // GP-88: hub detection and the layout run on the *drawn* edge set — edges
  // re-anchored onto host cards / subnet containers and merged. Merging collapses
  // an attachment's fan of lines into one, which can drop a node below the hub
  // threshold, so degrees are counted on what is actually drawn.
  const hubGraph = useMemo(
    () =>
      anchorOf.size > 0
        ? { ...graph, edges: reanchorStackEdges(graph.edges, anchorOf).edges }
        : graph,
    [graph, anchorOf],
  );
  const hubs = useMemo(() => detectHubs(hubGraph), [hubGraph]);

  const [filtersOpen, setFiltersOpen] = useState(false);
  // Everything on unless a consumer says otherwise.
  const showSearch = chrome?.search ?? true;
  const showFilters = chrome?.filters ?? true;
  const showLegend = chrome?.legend ?? true;
  const showZoom = chrome?.zoom ?? true;
  const [query, setQuery] = useState("");
  const [zoom, setZoom] = useState(1);

  const rfRef = useRef<ReactFlowInstance<FlowNode<GraphNodeData>> | null>(null);
  /** The drawing area, so "is this node visible" has something to be inside. */
  const containerRef = useRef<HTMLDivElement>(null);
  // Flips once onInit hands over the instance, so the fit-after-layout effect
  // can wait for whichever of {instance, layout} arrives last (GP-130).
  const [rfReady, setRfReady] = useState(false);
  const searchRef = useRef<HTMLInputElement>(null);

  // Camera memory (GP-156): whether this view instance has framed itself yet,
  // the previous snapshot's change set (a refresh only re-frames when it
  // *introduces* changes), and the selection alive when a refresh started.
  const firstFitRef = useRef(true);
  const prevFocusIdsRef = useRef<readonly string[] | null>(null);
  const prevSelectedIdRef = useRef<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLaying(true);
    // Remember what was selected when this refresh started (GP-156): if the
    // node survives, the camera corrects onto it after the new layout lands.
    setSelected((prev) => {
      prevSelectedIdRef.current = prev?.id ?? null;
      return null;
    });
    setHoveredId(null);
    setQuery("");
    // A new graph has new modules and new categories, so the old sets no
    // longer mean anything. Only when the canvas owns them: a controlled
    // consumer decides for itself what a new snapshot does to its filters,
    // and resetting through the callback would fight it every layout.
    if (!filtersControlled) {
      setFilterState({
        change: new Set(ALL_FILTERS),
        categories: new Set(categoryOptions(graph)),
        modules: new Set(moduleOptions(graph)),
        hubEdges: false,
      });
    }
    elk
      .layout(toElkGraph(graph, hubs, containerIds, stacks, chips))
      .then((result) => {
        if (!cancelled) {
          setLayout(result as ElkGraphNode);
          setLaying(false);
        }
      })
      .catch((err: unknown) => {
        // A swallowed layout failure renders as a stale, scattered diagram
        // with no clue why — say what happened, at least to the console.
        console.error("ELK layout failed; keeping the previous layout", err);
        if (!cancelled) setLaying(false);
      });
    return () => {
      cancelled = true;
    };
  }, [graph, containerIds, stacks, chips, hubs]);

  // The camera, once positions exist (GP-130/GP-156). The whole-graph fit
  // happens exactly once per view instance; a refresh either frames the blast
  // radius (when it introduces changes), re-centers a surviving selection, or
  // — most often — leaves the viewport exactly where the user put it. Runs
  // after the commit that handed ReactFlow the laid-out nodes, so fitView
  // measures real geometry. Deps are {layout, rfReady} on purpose: `graph` is
  // read from the same render that delivered its layout — running on a graph
  // change alone would plan the camera against stale positions.
  useEffect(() => {
    if (!layout || !rfReady) return;
    const rf = rfRef.current;
    if (!rf) return;
    const plan = planCamera({
      first: firstFitRef.current,
      graph,
      prevFocusIds: prevFocusIdsRef.current,
      prevSelectedId: prevSelectedIdRef.current,
    });
    firstFitRef.current = false;
    prevFocusIdsRef.current = changedFocusIds(graph);

    if (plan.kind === "fit-all") {
      void rf.fitView({ padding: FIT_VIEW_PADDING }).then(() => {
        setZoom(rf.getZoom());
      });
    } else if (plan.kind === "fit-changed") {
      void rf
        .fitView({
          nodes: plan.ids.map((id) => ({ id })),
          padding: BLAST_FIT_PADDING,
          maxZoom: BLAST_FIT_MAX_ZOOM,
          duration: 500,
        })
        .then(() => {
          setZoom(rf.getZoom());
        });
    } else if (plan.kind === "recenter") {
      // Deterministic layout means the node usually hasn't moved — this is a
      // correction for layout shifts, at the zoom the user chose.
      const box = boxesRef.current.get(plan.id);
      if (box) {
        void rf.setCenter(box.x + box.width / 2, box.y + box.height / 2, {
          zoom: rf.getZoom(),
          duration: 300,
        });
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [layout, rfReady]);

  // `/` focuses the search box (unless already typing in a field). Not bound
  // when this canvas is not the one drawing that box: the key would swallow
  // itself focusing an input nobody rendered, and the consumer's own search
  // would never hear it.
  useEffect(() => {
    if (!showSearch) return;
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
  }, [showSearch]);

  // The stop's anchors, as a set, and only the ones this graph actually has. The
  // backend already dropped stops it could not fly to, but the canvas may be
  // showing a *filtered* or otherwise different graph than the one validated, and
  // dimming everything because an anchor is missing would black out the diagram.
  const tourAnchors = useMemo(() => {
    if (!tour) return null;
    const present = tour.step.anchors.filter((id) =>
      graph.nodes.some((n) => n.id === id),
    );
    return new Set(present);
  }, [tour, graph]);

  const elements = useMemo(
    () =>
      layout
        ? elkToFlow(layout, graph, {
            activeFilters,
            activeCategories,
            activeModules,
            selectedId: selected?.id ?? null,
            hoveredId,
            hubs,
            showHubEdges,
            containerIds,
            stacks,
            chips,
            tourAnchors,
            diffEmphasis,
          })
        : { nodes: [], edges: [] },
    [layout, graph, activeFilters, activeCategories, activeModules, selected, hoveredId, hubs, showHubEdges, containerIds, stacks, chips, tourAnchors, diffEmphasis],
  );

  const resourceNodes = elements.nodes.filter((n) => n.type === "resource");
  const shown = resourceNodes.filter((n) => !n.data.dimmed).length;

  // GP-155: in diff mode the headline is the change set, not the filter count.
  // Falls back to the plain counter when the diff carries no signal at all.
  const changedTotal =
    (changeCount.get("create") ?? 0) +
    (changeCount.get("update") ?? 0) +
    (changeCount.get("delete") ?? 0);
  const impactedTotal = changeCount.get("impacted") ?? 0;
  const diffHeadline = diffEmphasis && changedTotal + impactedTotal > 0;

  // --- Annotation overlay (GP-58) -------------------------------------------
  const [tool, dispatchTool] = useReducer(reduceTool, INITIAL_TOOL);
  const [labelDraft, setLabelDraft] = useState("");

  const anns = useMemo(() => annotations ?? [], [annotations]);
  const nodeIds = useMemo(() => new Set(graph.nodes.map((n) => n.id)), [graph]);
  const renderableAnns = useMemo(
    () => renderableAnnotations(anns, nodeIds),
    [anns, nodeIds],
  );
  const notedIds = useMemo(() => notedNodeIds(renderableAnns), [renderableAnns]);

  // Leaving annotate mode drops any half-finished tool interaction.
  useEffect(() => {
    if (!annotate) {
      dispatchTool({ type: "setTool", tool: "select" });
      setLabelDraft("");
    }
  }, [annotate]);

  // Overlay geometry is derived from the *laid-out* nodes and never fed back to
  // ELK — so the generated layout is identical with and without annotations.
  const boxes = useMemo(() => absoluteNodeBoxes(elements.nodes), [elements.nodes]);
  // Read by the camera effect (GP-156) without being one of its deps: it runs
  // on layout changes only, and render-order guarantees this ref is current.
  const boxesRef = useRef(boxes);
  boxesRef.current = boxes;
  const frames = useMemo(
    () => groupFrames(renderableAnns, boxes),
    [renderableAnns, boxes],
  );

  // While the link tool is live a group is a legal endpoint, so its frame label
  // becomes clickable (GP-73) — that is how you say "this whole group talks to
  // that one" rather than picking one resource inside it and meaning the group.
  const groupsPickable = annotate && tool.tool === "link";

  const overlayNodes = useMemo<FlowNode<GraphNodeData>[]>(() => {
    const out: FlowNode<GraphNodeData>[] = [];
    // Group frames first so they paint behind the resources they surround.
    for (const f of frames) {
      out.push({
        id: groupFrameNodeId(f.id),
        type: "annotationGroup",
        position: { x: f.x, y: f.y },
        data: {
          graphNode: OVERLAY_STUB,
          dimmed: false,
          label: f.label,
          annotationId: f.id,
          pickable: groupsPickable,
          picked: tool.picks.includes(f.id),
        },
        // Declared, like every other node: an overlay React Flow has to measure
        // is an overlay that vanishes for a frame on every rebuild.
        width: f.width,
        height: f.height,
        measured: { width: f.width, height: f.height },
        style: { width: f.width, height: f.height },
        selectable: false,
        draggable: false,
        zIndex: 0,
      });
    }
    return out;
  }, [frames, groupsPickable, tool.picks]);

  const notePins = useMemo<FlowNode<GraphNodeData>[]>(() => {
    const out: FlowNode<GraphNodeData>[] = [];
    for (const [id, box] of boxes) {
      if (!notedIds.has(id)) continue;
      out.push({
        id: `ann-note-${id}`,
        type: "annotationNote",
        position: { x: box.x + box.width - 10, y: box.y - 8 },
        data: {
          graphNode: OVERLAY_STUB,
          dimmed: false,
          nodeId: id,
          count: notesForNode(renderableAnns, id).length,
        },
        width: NOTE_PIN_SIZE,
        height: NOTE_PIN_SIZE,
        measured: { width: NOTE_PIN_SIZE, height: NOTE_PIN_SIZE },
        draggable: false,
        zIndex: 5,
      });
    }
    return out;
  }, [boxes, notedIds, renderableAnns]);

  const annEdges = useMemo<FlowEdge[]>(
    () =>
      annotationLinkEdges(renderableAnns).map((e) => ({
        id: `ann-link-${e.id}`,
        source: e.source,
        target: e.target,
        type: "relationship",
        data: { annotation: true, label: e.label },
        selectable: false,
        zIndex: 1,
      })),
    [renderableAnns],
  );

  // Nodes picked as link endpoints / group / hide members (annotate mode).
  const pickedSet = useMemo(() => new Set(tool.picks), [tool.picks]);
  // The group *and* hide tools build a membership set by marquee drag.
  const marqueeSelecting = annotate && isMultiSelectTool(tool.tool);

  // What the adapted view (GP-74) will do to these nodes. Shown here, on the raw
  // canvas, because you edit annotations here: a resource you have marked hidden
  // should look marked, or you will mark it twice and wonder why nothing changed.
  const hidden = useMemo(() => hiddenNodeIds(renderableAnns), [renderableAnns]);
  const renamed = useMemo(() => renamedLabels(renderableAnns), [renderableAnns]);

  const flowNodes = useMemo(() => {
    // Colour picked resources and, for the multi-select tools, make them
    // box-selectable (rubber-band drag). Overlay/module/container nodes never are.
    const mapped = elements.nodes.map((node) => {
      if (node.type !== "resource") {
        // A subnet container carries its NSG / route-table chips (GP-89): wire
        // chip selection + the pulse a search fly-to leaves on a chip.
        if (node.type === "container") {
          return {
            ...node,
            selectable: false,
            data: {
              ...node.data,
              onSelectChip: selectChip,
              highlightedChipId:
                highlightedChip && chipToAnchor.get(highlightedChip) === node.id
                  ? highlightedChip
                  : undefined,
            },
          };
        }
        return { ...node, selectable: false };
      }
      const chosen = pickedSet.has(node.id);
      // A proposal being hovered in the inbox lights its anchors the same way a
      // picked node lights: "these are the resources in question" is one idea.
      const previewed = highlightIds?.has(node.id) === true;
      return {
        ...node,
        selectable: marqueeSelecting,
        selected: marqueeSelecting ? chosen : false,
        data: {
          ...node.data,
          picked: chosen || previewed,
          hiddenByAnnotation: hidden.has(node.id),
          renameLabel: renamed.get(node.id),
          // GP-87: clicking a stacked child row selects that child; a child the
          // search flew to pulses on its host card.
          onSelectStackChild: selectStackChild,
          highlightedChildId:
            highlightedChild && childToHost.get(highlightedChild) === node.id
              ? highlightedChild
              : undefined,
          // A resource card can carry attachment chips too (avset on its VM):
          // same wiring as the subnet container's chip row.
          onSelectChip: selectChip,
          highlightedChipId:
            highlightedChip && chipToAnchor.get(highlightedChip) === node.id
              ? highlightedChip
              : undefined,
          // GP-142: the badge wears the node's worst finding.
          lintSeverity: worstLintSeverity(lint?.get(node.id)),
          ...(findingsLabel ? { findingsLabel } : {}),
          // GP-207: the drift mark, in its own hue and its own corner.
          ...(drift?.has(node.id)
            ? { drifted: true, driftLabel: drift.get(node.id) }
            : {}),
        },
      };
    });
    return [...overlayNodes, ...mapped, ...notePins];
  }, [
    overlayNodes,
    elements.nodes,
    notePins,
    pickedSet,
    marqueeSelecting,
    hidden,
    renamed,
    highlightIds,
    highlightedChild,
    childToHost,
    selectStackChild,
    highlightedChip,
    chipToAnchor,
    selectChip,
    lint,
    findingsLabel,
    drift,
  ]);
  const flowEdges = useMemo(
    () => [...elements.edges, ...annEdges],
    [elements.edges, annEdges],
  );

  const selectedNotes = useMemo(
    () => (selected ? notesForNode(renderableAnns, selected.id) : []),
    [selected, renderableAnns],
  );

  const setTool = (t: AnnotateTool) => dispatchTool({ type: "setTool", tool: t });
  const resetTool = () => {
    setLabelDraft("");
    dispatchTool({ type: "reset" });
  };
  const createLink = () => {
    const label = labelDraft.trim();
    onCreateAnnotation?.({
      type: "link",
      anchors: tool.picks,
      // Optional (GP-71): drawing *that* two things are related is worth doing
      // even before you have settled on a word for the relationship.
      ...(label ? { label } : {}),
    });
    resetTool();
  };
  const createGroup = () => {
    if (!labelDraft.trim()) return;
    onCreateAnnotation?.({ type: "group", anchors: tool.picks, label: labelDraft.trim() });
    resetTool();
  };
  const createRename = () => {
    const anchor = tool.picks[0];
    if (!anchor || !labelDraft.trim()) return;
    onCreateAnnotation?.({ type: "rename", anchors: [anchor], label: labelDraft.trim() });
    resetTool();
  };
  /**
   * One `hide` per picked resource, rather than one hide holding them all. Each
   * node then orphans on its own terms: if one of the three you hid disappears
   * from the repo, the other two stay hidden instead of the whole instruction
   * falling over.
   */
  const createHides = () => {
    for (const anchor of tool.picks) {
      onCreateAnnotation?.({ type: "hide", anchors: [anchor] });
    }
    resetTool();
  };

  const resourceNodeIds = useMemo(
    () => new Set(resourceNodes.map((n) => n.id)),
    [resourceNodes],
  );

  const handleNodeClick = useCallback(
    (_: unknown, node: FlowNode<GraphNodeData>) => {
      // While a tour is running the canvas is being narrated, and a click that
      // opens a detail panel over the stop is the diagram interrupting the guide.
      // Exploring is what you do *after* the tour; Esc is always one key away.
      if (tour) return;
      // A note pin selects its underlying resource (opens the panel + notes).
      if (node.type === "annotationNote") {
        const target = graph.nodes.find((n) => n.id === (node.data.nodeId as string));
        if (target) setSelected(target);
        return;
      }
      // A group frame is a legal endpoint for a logical edge — clicking it picks
      // the *group*, not any resource inside it (GP-73).
      if (node.type === "annotationGroup") {
        const annotationId = node.data.annotationId as string | undefined;
        if (groupsPickable && annotationId) {
          dispatchTool({ type: "pick", id: annotationId });
        }
        return;
      }
      // A group *container* in C4: clicking it opens it (GP-77). The node id is
      // `group:<annotation id>`; the caller thinks in annotations, so unwrap it.
      if (node.type === "groupContainer" && onExpandGroup) {
        onExpandGroup(node.id.replace(/^group:/, ""));
        return;
      }
      const graphNode = node.data.graphNode;
      if (!graphNode) return;
      // The link and rename tools pick nodes on click. The multi-select tools
      // (group/hide) use React Flow's box/shift selection instead (see
      // onNodesChange), so a plain click there is the selection layer's business.
      if (annotate && (tool.tool === "link" || tool.tool === "rename")) {
        dispatchTool({ type: "pick", id: graphNode.id });
        return;
      }
      if (marqueeSelecting) return;
      setSelected(graphNode);
    },
    [annotate, tool.tool, marqueeSelecting, groupsPickable, graph, onExpandGroup, tour],
  );

  // Rubber-band / shift-click selection drives the group and hide tools' picks.
  // Only real resource selections matter — overlay/module nodes are ignored.
  const handleNodesChange = useCallback(
    (changes: NodeChange[]) => {
      if (!marqueeSelecting) return;
      const selections = changes.flatMap((c) =>
        c.type === "select" && resourceNodeIds.has(c.id)
          ? [{ id: c.id, selected: c.selected }]
          : [],
      );
      if (selections.length > 0) {
        dispatchTool({ type: "applySelection", changes: selections });
      }
    },
    [marqueeSelecting, resourceNodeIds],
  );

  const flyTo = useCallback(
    (node: GraphNode) => {
      setSelected(node);
      setQuery(""); // close the results dropdown once a result is chosen
      // An attached node (a stacked child, GP-87, or a chip, GP-89) has no node
      // of its own on the canvas: fly to the host / anchor that carries it. The
      // row / chip lights up by being the selection — no separate pulse state.
      const hostId = childToHost.get(node.id);
      const subnetId = chipToAnchor.get(node.id);
      void rfRef.current?.fitView({
        nodes: [{ id: hostId ?? subnetId ?? node.id }],
        duration: 500,
        maxZoom: 1.5,
      });
    },
    [childToHost, chipToAnchor],
  );

  /**
   * Is the node already visible? Answered from the laid-out box, the current
   * transform and the measured container — no DOM query per node.
   */
  const isSelectionOnScreen = useCallback((id: string): boolean => {
    const rf = rfRef.current;
    const box = boxesRef.current.get(id);
    const el = containerRef.current;
    if (!rf || !box || !el) return false;
    return isNodeOnScreen(box, rf.getViewport(), {
      width: el.clientWidth,
      height: el.clientHeight,
    });
  }, []);

  // The camera handle, for a consumer drawing its own zoom controls. Filled
  // once React Flow exists, cleared on unmount so a stale handle cannot drive
  // a canvas that is gone.
  useEffect(() => {
    if (!cameraRef) return;
    cameraRef.current = {
      zoomIn: () => rfRef.current?.zoomIn(),
      zoomOut: () => rfRef.current?.zoomOut(),
      fit: (nodeIds) => {
        // Fit-to-changes on a diff that changed nothing asks to frame an
        // empty set; React Flow would happily land nowhere, so fall through
        // to the whole graph — which is the honest answer to "show me the
        // changes" when there are none.
        const present = (nodeIds ?? []).filter((id) =>
          graph.nodes.some((n) => n.id === id),
        );
        void rfRef.current?.fitView(
          present.length > 0
            ? {
                nodes: present.map((id) => ({ id })),
                padding: BLAST_FIT_PADDING,
                maxZoom: BLAST_FIT_MAX_ZOOM,
                duration: 300,
              }
            : { padding: FIT_VIEW_PADDING, duration: 300 },
        );
      },
      reveal: (nodeId) => {
        const node = graph.nodes.find((n) => n.id === nodeId);
        if (node) flyTo(node);
      },
    };
    return () => {
      cameraRef.current = null;
    };
  }, [cameraRef, graph, flyTo]);

  // Fly to a node requested from outside (GP-40 compare summary lists).
  useEffect(() => {
    if (!focusNodeId) return;
    const node = graph.nodes.find((n) => n.id === focusNodeId);
    if (node) flyTo(node);
  }, [focusNodeId, graph, flyTo]);

  // Controlled external selection (GP-146/GP-149): the host says what is
  // selected, the canvas shows it — panel open, node revealed. `undefined`
  // keeps the canvas uncontrolled (every existing caller).
  useEffect(() => {
    if (selectedAddress === undefined) return;
    if (selectedAddress === null) {
      setSelected(null);
      return;
    }
    const node = graph.nodes.find((n) => n.id === selectedAddress);
    if (!node) return;
    // `"offscreen"`: a node the reader can already see does not need the
    // camera moved onto it. Following a cursor with an unconditional fly
    // means the diagram snaps back on every keystroke, and panning while
    // editing becomes impossible.
    if (revealSelection === "offscreen" && isSelectionOnScreen(node.id)) {
      setSelected(node);
      return;
    }
    flyTo(node);
  }, [selectedAddress, graph, flyTo, revealSelection, isSelectionOnScreen]);

  // Report selection out (GP-146) — user interactions only. A change that
  // merely lands on what `selectedAddress` already asked for is the echo of an
  // external selection, and echoing it back is how loops start (GP-149).
  const onNodeSelectRef = useRef(onNodeSelect);
  onNodeSelectRef.current = onNodeSelect;
  const lastNotifiedRef = useRef<string | null>(null);
  useEffect(() => {
    const id = selected?.id ?? null;
    if (lastNotifiedRef.current === id) return;
    lastNotifiedRef.current = id;
    if (id !== null && id === selectedAddress) return;
    onNodeSelectRef.current?.(selected);
  }, [selected, selectedAddress]);

  // The tour camera (GP-79). A stop with anchors frames exactly them — `fitView`
  // takes a set, so a stop about three things frames all three, which is the whole
  // reason a stop may name more than one. A stop with none frames the diagram: it
  // is the opener or the closer, and it is talking about the change as a whole.
  //
  // Gated on `layout` because the coordinates do not exist until ELK has run —
  // flying before then is a fitView over an empty graph, which lands nowhere.
  const tourIndex = tour?.index ?? null;
  const tourChrome = tour?.chrome ?? null;
  useEffect(() => {
    if (!layout || !tourAnchors) return;

    // In the spotlight, the card sits to the right of the stop — so the camera
    // leaves it a lane rather than framing the stop dead-centre and letting the
    // card fall off the edge of the canvas. `NodeToolbar` does not flip; framing
    // is the camera's job anyway.
    const padding =
      tourChrome === "spotlight"
        ? { top: "12%" as const, bottom: "12%" as const, left: "12%" as const, right: `${COACH_MARK_GUTTER}px` as const }
        : 0.3;

    const nodes = [...tourAnchors].map((id) => ({ id }));
    void rfRef.current?.fitView(
      nodes.length > 0
        ? { nodes, duration: 600, maxZoom: 1.4, padding }
        : { duration: 600 },
    );
    // A tour is a narration: the side panel from a click you made three stops ago
    // has no business hanging over the thing you are being shown now.
    setSelected(null);
  }, [layout, tourIndex, tourAnchors, tourChrome]);

  const results = useMemo(() => searchNodes(graph.nodes, query, 10), [graph, query]);

  const reset = () => {
    setFilterState({
      change: new Set(ALL_FILTERS),
      categories: new Set(categoryOpts),
      modules: new Set(moduleOpts),
      hubEdges: false,
    });
    setSelected(null);
    setQuery("");
  };

  return (
    <div ref={containerRef} className="bg-canvas relative h-full w-full">
      <EdgeArrowMarkers />
      <ReactFlow
        nodes={flowNodes}
        edges={flowEdges}
        nodeTypes={NODE_TYPES}
        edgeTypes={EDGE_TYPES}
        onInit={(instance) => {
          rfRef.current = instance;
          setRfReady(true);
          setZoom(instance.getZoom());
        }}
        onMove={(_, viewport) => setZoom(viewport.zoom)}
        onNodeClick={handleNodeClick}
        // Pointing at a node lights its relationships and pushes the rest back.
        // Only real resources focus — an overlay pin or a container frame would
        // dim the whole diagram for nothing.
        onNodeMouseEnter={(_, node) =>
          setHoveredId(node.type === "resource" ? node.id : null)
        }
        onNodeMouseLeave={() => setHoveredId(null)}
        onNodesChange={handleNodesChange}
        onPaneClick={() => setSelected(null)}
        nodesDraggable={false}
        nodesConnectable={false}
        // Group/hide tools: left-drag draws a selection box; middle/right-drag pans.
        // Otherwise the canvas pans on left-drag as usual and nothing is selectable.
        elementsSelectable={marqueeSelecting}
        selectionOnDrag={marqueeSelecting}
        selectionMode={SelectionMode.Partial}
        panOnDrag={marqueeSelecting ? [1, 2] : true}
        minZoom={0.1}
        defaultViewport={DEFAULT_VIEWPORT}
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

        {/* The spotlight's coach mark. In here because only a child of
            `<ReactFlow>` can pin itself to a node; the guide rail wants no such
            thing and lives outside the canvas entirely. */}
        {tour?.chrome === "spotlight" ? <TourSpotlight tour={tour} /> : null}
      </ReactFlow>

      {/* Floating zoom toolbar (top-right). */}
      {showZoom && (
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
      )}

      {/* Zoom % + interaction hints (bottom-right). */}
      {showZoom && (
      <div className="bg-card/90 text-muted-foreground absolute right-3 bottom-3 z-10 flex items-center gap-2 rounded-md border border-border px-2.5 py-1 shadow-sm backdrop-blur">
        <span className="text-ink font-mono text-xs tabular-nums">
          {Math.round(zoom * 100)}%
        </span>
        <span className="text-faint hidden text-[10px] sm:inline">
          scroll to zoom · drag to pan
        </span>
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

      {/* One left rail: search, then filters. The search box used to float in
          the middle of the canvas, anchored to nothing; the filter panel used to
          hold canvas space open all session for something you touch once. */}
      {(showSearch || showFilters) && (
      <div className="absolute top-3 left-3 z-10 flex max-h-[calc(100%-1.5rem)] w-64 flex-col gap-2">
        {showSearch && (
        <div className="shrink-0">
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
                    className="hover:bg-accent flex w-full items-center gap-2 px-2.5 py-1.5 text-left"
                  >
                    <ResourceIcon
                      type={node.type}
                      className="text-muted-foreground size-4 shrink-0"
                    />
                    <span className="flex min-w-0 flex-col">
                      <span className="font-mono text-xs font-medium">
                        {shortType(node.type)}
                      </span>
                      <span className="text-muted-foreground truncate font-mono text-[10px]">
                        {node.id}
                      </span>
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
        )}

        {showFilters && (
        <div className="bg-card/90 flex min-h-0 flex-col overflow-hidden rounded-md border border-border shadow-sm backdrop-blur">
          <div className="flex items-center justify-between gap-2 px-3 py-2">
            <button
              type="button"
              aria-expanded={filtersOpen}
              onClick={() => setFiltersOpen((v) => !v)}
              className="text-muted-foreground hover:text-foreground inline-flex items-center gap-1.5 font-mono text-[10px] tracking-wide uppercase"
            >
              <SlidersHorizontal className="size-3" />
              Filters
              <ChevronDown
                className={cn("size-3 transition-transform", filtersOpen && "rotate-180")}
              />
            </button>
            <span className="text-muted-foreground font-mono text-[10px]">
              {diffHeadline
                ? `${resourceNodes.length} resources · ${changedTotal} changed · ${impactedTotal} impacted`
                : `${shown} of ${resourceNodes.length} shown`}
            </span>
          </div>

          {filtersOpen && (
            <div className="min-h-0 overflow-auto border-t border-border px-3 pb-3">
              {variant === "plan" && (
                <FilterSection title="Change">
                  {ALL_FILTERS.map((key) => (
                    <CheckRow
                      key={key}
                      checked={activeFilters.has(key)}
                      count={changeCount.get(key) ?? 0}
                      onToggle={() =>
                        setFilterState({
                          ...activeFilterState,
                          change: toggle(activeFilters, key),
                        })
                      }
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
                        count={categoryCount.get(cat) ?? 0}
                        onToggle={() =>
                          setFilterState({
                            ...activeFilterState,
                            categories: toggle<Category>(activeCategories, cat),
                          })
                        }
                      >
                        <meta.icon className={cn("size-3", meta.className)} />
                        {meta.label}
                      </CheckRow>
                    );
                  })}
                </FilterSection>
              )}

              {/* One option is not a choice: a lone "root" box would only ever
                  hide the entire diagram. A Kubernetes graph is always this (a
                  manifest has no modules), and so is a Terraform repository that
                  never wrote one — but `activeModules` still covers them, or the
                  dim pass would hide what no checkbox could bring back. */}
              {moduleOpts.length > 1 && (
                <FilterSection title="Module">
                  {moduleOpts.map((mod) => (
                    <CheckRow
                      key={mod}
                      checked={activeModules.has(mod)}
                      count={moduleCount.get(mod) ?? 0}
                      onToggle={() =>
                        setFilterState({
                          ...activeFilterState,
                          modules: toggle(activeModules, mod),
                        })
                      }
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
                    onToggle={() =>
                      setFilterState({
                        ...activeFilterState,
                        hubEdges: !showHubEdges,
                      })
                    }
                  >
                    <Waypoints className="text-muted-foreground size-3" />
                    Show hub connections
                  </CheckRow>
                </FilterSection>
              )}

              <button
                type="button"
                onClick={reset}
                className="text-muted-foreground hover:text-foreground mt-3 inline-flex items-center gap-1 border-t border-border pt-2 text-[10px]"
              >
                <RotateCcw className="size-3" />
                Reset
              </button>
            </div>
          )}
        </div>
        )}
      </div>
      )}

      {/* What the lines mean. An undocumented encoding is a guess the reader has
          to make — and this diagram is supposed to be trustworthy. */}
      {showLegend && <EdgeLegend graph={graph} variant={variant} />}

      {detailsPanel && selected && (
        <NodeDetailsPanel
          graph={graph}
          node={selected}
          onClose={() => setSelected(null)}
          onSelect={flyTo}
          showChange={variant === "plan"}
          lintFindings={lint?.get(selected.id)}
          {...(findingsLabel ? { findingsLabel } : {})}
          {...(driftRows?.get(selected.id)
            ? { driftRows: driftRows.get(selected.id) }
            : {})}
          footer={
            annotations !== undefined && (annotate || selectedNotes.length > 0) ? (
              <NotePanel
                notes={selectedNotes}
                readOnly={!annotate}
                onCreate={(body) =>
                  onCreateAnnotation?.({ type: "note", anchors: [selected.id], body })
                }
                onUpdate={(id, body) => onUpdateAnnotation?.(id, { body })}
                onDelete={(id) => onDeleteAnnotation?.(id)}
              />
            ) : undefined
          }
        />
      )}

      {/* Annotate tools (GP-58): view ⇄ annotate is toggled in the docs toolbar;
          here we only render the tool palette + contextual actions. */}
      {annotate && (
        <div className="bg-card/95 absolute bottom-3 left-1/2 z-10 flex -translate-x-1/2 items-center gap-2 rounded-md border border-border px-2 py-1.5 shadow-sm backdrop-blur">
          <fieldset aria-label="Annotate tools" className="flex items-center gap-1">
            <ToolButton label="Select" active={tool.tool === "select"} onClick={() => setTool("select")}>
              <MousePointer2 className="size-4" />
            </ToolButton>
            <ToolButton label="Link" active={tool.tool === "link"} onClick={() => setTool("link")}>
              <Link2 className="size-4" />
            </ToolButton>
            <ToolButton label="Group" active={tool.tool === "group"} onClick={() => setTool("group")}>
              <Group className="size-4" />
            </ToolButton>
            <ToolButton label="Rename" active={tool.tool === "rename"} onClick={() => setTool("rename")}>
              <Type className="size-4" />
            </ToolButton>
            <ToolButton label="Hide" active={tool.tool === "hide"} onClick={() => setTool("hide")}>
              <EyeOff className="size-4" />
            </ToolButton>
          </fieldset>

          {tool.tool === "select" && (
            <span className="text-muted-foreground px-1 text-xs">
              Click a resource to note it
            </span>
          )}

          {tool.tool === "link" &&
            (linkIsReady(tool) ? (
              <LabelForm
                label="Link label"
                submitLabel="Add link"
                optional
                value={labelDraft}
                onChange={setLabelDraft}
                onSubmit={createLink}
                onCancel={resetTool}
              />
            ) : (
              <span className="text-muted-foreground px-1 text-xs">
                {tool.picks.length === 0
                  ? "Click the source resource or group"
                  : "Click the target resource or group"}
              </span>
            ))}

          {tool.tool === "group" && (
            <div className="flex items-center gap-2">
              <span className="text-muted-foreground px-1 text-xs">
                {tool.picks.length === 0
                  ? "Drag a box (or shift-click) to select resources"
                  : `${tool.picks.length} selected`}
              </span>
              {tool.picks.length >= 1 && (
                <LabelForm
                  label="Group label"
                  submitLabel="Create group"
                  value={labelDraft}
                  onChange={setLabelDraft}
                  onSubmit={createGroup}
                  onCancel={resetTool}
                />
              )}
            </div>
          )}

          {tool.tool === "rename" &&
            (renameIsReady(tool) ? (
              <LabelForm
                label="New label"
                submitLabel="Apply rename"
                value={labelDraft}
                onChange={setLabelDraft}
                onSubmit={createRename}
                onCancel={resetTool}
              />
            ) : (
              <span className="text-muted-foreground px-1 text-xs">
                Click the resource to rename
              </span>
            ))}

          {tool.tool === "hide" && (
            <div className="flex items-center gap-2">
              <span className="text-muted-foreground px-1 text-xs">
                {tool.picks.length === 0
                  ? "Drag a box (or shift-click) to select what to hide"
                  : `${tool.picks.length} selected`}
              </span>
              {tool.picks.length >= 1 && (
                <>
                  <button
                    type="button"
                    onClick={createHides}
                    className="bg-primary text-primary-foreground rounded px-2 py-1 text-xs font-medium"
                  >
                    Hide {tool.picks.length}
                  </button>
                  <button
                    type="button"
                    onClick={resetTool}
                    className="text-muted-foreground hover:text-foreground px-1 text-xs"
                  >
                    Cancel
                  </button>
                </>
              )}
            </div>
          )}
        </div>
      )}

      {/* The annotation list (GP-58, five types as of GP-73): relabel or delete.
          Notes are managed on their node via the details panel. */}
      {annotate && renderableAnns.some((a) => a.type !== "note") && (
        <div className="bg-card/95 absolute top-14 right-3 z-10 max-h-[calc(100%-8rem)] w-56 overflow-auto rounded-md border border-border p-2 shadow-sm backdrop-blur">
          <p className="text-muted-foreground mb-1.5 font-mono text-[10px] tracking-wide uppercase">
            Annotations
          </p>
          <ul className="space-y-1">
            {renderableAnns
              .filter((a) => a.type !== "note")
              .map((a) => (
                <AnnotationRow
                  key={a.id}
                  annotation={a}
                  onRelabel={(label) => onUpdateAnnotation?.(a.id, { label })}
                  onDelete={() => onDeleteAnnotation?.(a.id)}
                />
              ))}
          </ul>
        </div>
      )}
    </div>
  );
}

function ToolButton({
  label,
  active,
  onClick,
  children,
}: Readonly<{
  label: string;
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}>) {
  return (
    <button
      type="button"
      aria-label={label}
      aria-pressed={active}
      title={label}
      onClick={onClick}
      className={cn(
        "grid size-8 place-items-center rounded transition-colors",
        active
          ? "bg-primary text-primary-foreground"
          : "text-muted-foreground hover:bg-accent hover:text-foreground",
      )}
    >
      {children}
    </button>
  );
}

function LabelForm({
  label,
  submitLabel,
  value,
  optional = false,
  onChange,
  onSubmit,
  onCancel,
}: Readonly<{
  label: string;
  submitLabel: string;
  value: string;
  /** A logical edge may be drawn without a name for the relationship (GP-71). */
  optional?: boolean;
  onChange: (v: string) => void;
  onSubmit: () => void;
  onCancel: () => void;
}>) {
  return (
    <div className="flex items-center gap-1">
      <input
        aria-label={label}
        value={value}
        autoFocus
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") onSubmit();
          if (e.key === "Escape") onCancel();
        }}
        placeholder={optional ? `${label} (optional)` : `${label}…`}
        className="border-border w-32 rounded border bg-transparent px-1.5 py-0.5 text-xs outline-none"
      />
      <button
        type="button"
        onClick={onSubmit}
        disabled={!optional && !value.trim()}
        className="bg-primary text-primary-foreground rounded px-2 py-0.5 text-xs disabled:opacity-40"
      >
        {submitLabel}
      </button>
      <button
        type="button"
        aria-label="Cancel"
        onClick={onCancel}
        className="text-muted-foreground hover:text-foreground grid size-6 place-items-center rounded"
      >
        <X className="size-3.5" />
      </button>
    </div>
  );
}

const ROW_ICON: Partial<Record<Annotation["type"], typeof Group>> = {
  link: Link2,
  group: Group,
  hide: EyeOff,
  rename: Type,
};

function AnnotationRow({
  annotation,
  onRelabel,
  onDelete,
}: Readonly<{
  annotation: Annotation;
  onRelabel: (label: string) => void;
  onDelete: () => void;
}>) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(annotation.label ?? "");
  const Icon = ROW_ICON[annotation.type] ?? Group;

  if (editing) {
    return (
      <li className="flex items-center gap-1">
        <input
          aria-label="Edit label"
          value={draft}
          autoFocus
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && draft.trim()) {
              onRelabel(draft.trim());
              setEditing(false);
            }
            if (e.key === "Escape") setEditing(false);
          }}
          className="border-border min-w-0 flex-1 rounded border bg-transparent px-1.5 py-0.5 text-xs outline-none"
        />
        <button
          type="button"
          aria-label="Save label"
          onClick={() => {
            if (draft.trim()) onRelabel(draft.trim());
            setEditing(false);
          }}
          className="text-muted-foreground hover:text-foreground grid size-6 place-items-center rounded"
        >
          <Plus className="size-3.5 rotate-45" />
        </button>
      </li>
    );
  }

  return (
    <li className="group hover:bg-accent flex items-center gap-1.5 rounded px-1 py-0.5">
      <Icon className="text-primary size-3.5 shrink-0" />
      <button
        type="button"
        onClick={() => {
          setDraft(annotation.label ?? "");
          setEditing(true);
        }}
        className="text-ink min-w-0 flex-1 truncate text-left text-xs"
        title="Rename"
      >
        {annotation.label || (annotation.type === "hide" ? "Hidden" : "(untitled)")}
      </button>
      {/* The badge outlives the review (GP-76): accepting a suggestion means
          agreeing with it, not laundering where it came from. */}
      {annotation.provenance === "ai" && <AiBadge className="shrink-0" />}
      <button
        type="button"
        aria-label="Delete annotation"
        onClick={onDelete}
        className="text-muted-foreground hover:text-destructive grid size-6 shrink-0 place-items-center rounded"
      >
        <Trash2 className="size-3.5" />
      </button>
    </li>
  );
}

function FilterSection({
  title,
  children,
}: Readonly<{
  title: string;
  children: React.ReactNode;
}>) {
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
}: Readonly<{
  label: string;
  onClick: () => void;
  className?: string;
  children: React.ReactNode;
}>) {
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
