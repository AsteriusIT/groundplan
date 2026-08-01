/**
 * The preview panel (GP-147): a React tree around the shared canvas. All
 * state arrives by message from the extension host — the webview holds no
 * knowledge of the workspace beyond what it was last told.
 *
 * Three lenses, mirroring the web app's playground: Global (the raw diagram),
 * Network (the networkProjection fold — containers, stacks, chips) and IAM
 * (the table). Pure client-side folds of the same snapshot; switching never
 * re-parses.
 *
 * Diff mode (GP-154): the host posts a differ-annotated snapshot instead of
 * the raw one; this side reuses the PR view's visual language (variant="plan":
 * change colours, ghost deletes, impacted rings).
 *
 * The panel is three zones — a toolbar, the diagram, and (from here on) the
 * space below it — rather than one plane with chrome floating over the
 * drawing. What used to hover permanently over the canvas now lives in the
 * toolbar or behind it: the change counts are on the Diff button, and the
 * "this is not a plan" caveat is in the popover instead of pinned to the
 * corner on every render. A caveat that is always on screen is not read.
 */
import { useEffect, useMemo, useReducer, useRef, useState } from "react";

import { changedOnly as changedOnlyFold } from "@groundplan/graph-differ";
import {
  changedFocusIds,
  cn,
  GraphCanvas,
  IamTable,
  networkProjection,
  type CanvasCamera,
  type Graph,
} from "@groundplan/canvas";
import "@groundplan/canvas/styles.css";

import type { HostMessage, PreviewTheme, WebviewMessage } from "../src/messages";
import { postToHost } from "./vscode-api";
import { AboutDiffPopover, DiffPopover } from "./components/diff-popover";
import { FilterChips } from "./components/filter-chips";
import { FilterButton, filterOptionsFor } from "./components/filter-popover";
import { LegendButton } from "./components/legend-popover";
import { OverflowMenu } from "./components/overflow-menu";
import { SearchField } from "./components/search-field";
import { StatusBar, type SyncState } from "./components/status-bar";
import { Toolbar } from "./components/toolbar";
import { ZoomOverlay } from "./components/zoom-overlay";
import { diffCounts } from "./state/diff-summary";
import {
  INITIAL_PANEL_STATE,
  NO_DIFF_FACTS,
  panelReducer,
  toPanelPrefs,
  type DiffFacts,
  type PanelAction,
} from "./state/panel-state";
import { statusNotice } from "./state/status-notice";
import {
  activeFilterChips,
  toCanvasFilters,
  toExclusions,
} from "./state/filters";

/**
 * Theme (the `groundplan.theme` setting — no in-panel switch): the host bakes
 * the initial value into <html>; this applies a settings change live.
 */
function applyTheme(theme: PreviewTheme): void {
  const root = document.documentElement;
  root.classList.toggle("dark", theme === "carbon");
  if (theme === "carbon") root.dataset.theme = "carbon";
  else delete root.dataset.theme;
}

/** Where the parse looked and how to look elsewhere — never a blank grid. */
function EmptyState({
  folder,
  rootDir,
  outOfSync,
}: Readonly<{
  folder: string;
  rootDir: string;
  outOfSync: boolean;
}>): React.JSX.Element {
  return (
    <div className="flex h-screen flex-col items-center justify-center gap-2 bg-background px-6 text-center">
      <p className="text-foreground text-sm">
        No Terraform found under{" "}
        <span className="font-mono">
          {rootDir ? `${folder}/${rootDir}` : folder}
        </span>
        {outOfSync ? " — the last parse failed (see Problems)" : ""}.
      </p>
      <p className="text-muted-foreground text-xs">
        Focus a <span className="font-mono">.tf</span> file to preview its
        stack, or point the{" "}
        <span className="font-mono">groundplan.rootDir</span> setting at one.
      </p>
    </div>
  );
}

export function App({
  post = postToHost,
}: Readonly<{
  /** How this panel talks to the extension host. Injected in tests. */
  post?: (message: WebviewMessage) => void;
}> = {}): React.JSX.Element {
  const [graph, setGraph] = useState<Graph | null>(null);
  const [folder, setFolder] = useState("");
  const [rootDir, setRootDir] = useState("");
  const [multiRoot, setMultiRoot] = useState(false);
  const [outOfSync, setOutOfSync] = useState(false);
  const [selectedAddress, setSelectedAddress] = useState<string | null>(null);
  const [panel, dispatch] = useReducer(panelReducer, INITIAL_PANEL_STATE);
  const [facts, setFacts] = useState<DiffFacts>(NO_DIFF_FACTS);
  const [diffOptionsOpen, setDiffOptionsOpen] = useState(false);
  const [aboutOpen, setAboutOpen] = useState(false);
  const [sync, setSync] = useState<SyncState>({ value: "synced" });
  const [legendOpen, setLegendOpen] = useState(false);
  const [filtersOpen, setFiltersOpen] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);
  const [overflowOpen, setOverflowOpen] = useState(false);
  const [query, setQuery] = useState("");
  const camera = useRef<CanvasCamera | null>(null);
  const view = panel.lens;
  const prefs = panel.diff;

  useEffect(() => {
    const onMessage = (event: MessageEvent<HostMessage>): void => {
      const message = event.data;
      if (message.type === "snapshot") {
        setGraph(message.snapshot);
        setFolder(message.folder);
        setRootDir(message.rootDir);
        setMultiRoot(message.multiRoot);
      } else if (message.type === "outOfSync") {
        setOutOfSync(message.value);
      } else if (message.type === "select") {
        setSelectedAddress(message.address);
      } else if (message.type === "diffState") {
        // The host owns both halves of this message: the preferences it
        // persisted (echoed back) and the facts it observed about the
        // baseline. They land in different places on this side.
        const { enabled, mode, changedOnly, ...observed } = message.state;
        dispatch({ type: "hostDiffPrefs", prefs: { enabled, mode, changedOnly } });
        setFacts(observed);
      } else if (message.type === "panelPrefs") {
        dispatch({ type: "hostPanelPrefs", prefs: message.prefs });
      } else if (message.type === "openDiffInfo") {
        setAboutOpen(true);
      } else if (message.type === "sync") {
        setSync(
          message.message === undefined
            ? { value: message.value }
            : { value: message.value, message: message.message },
        );
      } else if (message.type === "theme") {
        applyTheme(message.theme);
      }
    };
    window.addEventListener("message", onMessage);
    post({ type: "ready" });
    return () => window.removeEventListener("message", onMessage);
  }, []);

  /**
   * Apply a panel action locally and tell the host when it changed a diff
   * preference. The reducer is pure, so running it here to see whether the
   * preferences moved costs nothing and keeps the "when do we post" rule in
   * one place — including the actions it refuses, which must post nothing.
   */
  const act = (action: PanelAction): void => {
    const next = panelReducer(panel, action);
    dispatch(action);
    // Nothing to say when the reducer refused the action (it returns the same
    // state), and everything to say otherwise: the host stores the document
    // and decides for itself whether the change was one it must re-render for.
    if (next !== panel) post({ type: "setPanelPrefs", prefs: toPanelPrefs(next) });
  };

  const diffActive = prefs.enabled && facts.available;

  // "Changed only" (GP-154): changed nodes + one hop of context. A clean diff
  // shows the full all-noop graph, never an empty canvas.
  const displayed = useMemo(() => {
    if (!graph) return null;
    if (view === "infra" && diffActive && prefs.changedOnly && !facts.clean) {
      return changedOnlyFold(graph) as Graph;
    }
    return graph;
  }, [graph, view, diffActive, prefs.changedOnly, facts.clean]);

  // The network fold is cheap but not free — only computed while looked at.
  const network = useMemo(
    () => (displayed && view === "network" ? networkProjection(displayed) : null),
    [displayed, view],
  );

  // Counted off the whole annotated snapshot, not the "changed only" fold:
  // the question the button answers is what this diff contains, which does
  // not change because the reader chose to look at less of it.
  // The filter vocabulary of the graph on screen, and the panel's exclusions
  // resolved against it (see state/filters for why exclusions).
  const filterOptions = useMemo(
    () => (graph ? filterOptionsFor(graph) : { categories: [], modules: [] }),
    [graph],
  );
  const canvasFilters = useMemo(
    () => toCanvasFilters(panel.filters, filterOptions),
    [panel.filters, filterOptions],
  );
  const chips = useMemo(
    () => activeFilterChips(panel.filters, filterOptions),
    [panel.filters, filterOptions],
  );

  const counts = useMemo(
    () => (graph && diffActive ? diffCounts(graph) : null),
    [graph, diffActive],
  );

  if (!graph || !displayed) {
    return (
      <div className="flex h-screen items-center justify-center bg-background">
        <p className="text-muted-foreground text-sm">Reading Terraform…</p>
      </div>
    );
  }

  // An empty snapshot drew a silent blank grid; say where the parse looked
  // and how to point it elsewhere instead.
  if (graph.nodes.length === 0) {
    return <EmptyState folder={folder} rootDir={rootDir} outOfSync={outOfSync} />;
  }

  return (
    <div className="flex h-screen w-screen flex-col bg-canvas">
      <Toolbar
        lens={view}
        prefs={prefs}
        facts={facts}
        counts={counts}
        optionsOpen={diffOptionsOpen}
        onToggleOptions={() => setDiffOptionsOpen((open) => !open)}
        onAction={act}
        diffPopover={
          <DiffPopover
            open={diffOptionsOpen}
            onClose={() => setDiffOptionsOpen(false)}
            prefs={prefs}
            facts={facts}
            onAction={act}
          />
        }
      >
        <SearchField
          graph={graph}
          open={searchOpen}
          query={query}
          onOpen={() => setSearchOpen(true)}
          onClose={() => {
            setSearchOpen(false);
            setQuery("");
          }}
          onQuery={setQuery}
          onPick={(nodeId) => {
            camera.current?.reveal(nodeId);
            setSelectedAddress(nodeId);
            setSearchOpen(false);
            setQuery("");
          }}
        />
        <FilterButton
          graph={graph}
          variant={diffActive ? "plan" : "docs"}
          options={filterOptions}
          exclusions={panel.filters}
          activeCount={chips.length}
          open={filtersOpen}
          onToggle={() => setFiltersOpen((open) => !open)}
          onClose={() => setFiltersOpen(false)}
          onChange={(filters) => act({ type: "setFilters", filters })}
          onClear={() => act({ type: "clearFilters" })}
        />
        <OverflowMenu
          open={overflowOpen}
          onToggle={() => setOverflowOpen((open) => !open)}
          onClose={() => setOverflowOpen(false)}
          followCursor={panel.followCursor}
          onToggleFollowCursor={() => act({ type: "toggleFollowCursor" })}
        />
      </Toolbar>

      {/* A filter panel you have closed is a filter you have forgotten — and a
          diagram showing less than the workspace holds, with nothing on screen
          saying so. */}
      <FilterChips
        chips={chips}
        onRemove={(chip) =>
          act({ type: "setFilters", filters: chip.without(panel.filters) })
        }
        onClearAll={() => act({ type: "clearFilters" })}
      />

      {/* The diagram owns everything below the bar. Nothing is pinned on top
          of it: what used to float here is on the button or behind it. */}
      <div
        className={cn(
          "relative min-h-0 flex-1",
          view !== "iam" && "blueprint-grid",
        )}
      >
        {view === "iam" ? (
          <IamTable
            graph={graph}
            variant="docs"
            onViewInPlanImpact={(node) => {
              // "View on canvas": back to the diagram with that node selected.
              act({ type: "setLens", lens: "infra" });
              setSelectedAddress(node.id);
            }}
          />
        ) : (
          <GraphCanvas
            // Each view keeps its own camera (GP-156): a fresh instance per
            // lens fits itself once; live re-parses preserve the viewport.
            key={view}
            graph={network ? network.graph : displayed}
            variant={diffActive ? "plan" : "docs"}
            // The panel draws all of this itself, in its own zones. Leaving
            // the canvas to draw a second set is how one diagram ended up
            // under two chromes.
            chrome={{ search: false, filters: false, legend: false, zoom: false }}
            filters={canvasFilters}
            onFiltersChange={(next) =>
              act({ type: "setFilters", filters: toExclusions(next, filterOptions) })
            }
            cameraRef={camera}
            // Following the cursor must not fight the reader's pan: a node
            // already in view needs no camera move.
            revealSelection="offscreen"
            // Diff mode wears the PR view's hierarchy: unchanged recedes (GP-155).
            diffEmphasis={diffActive}
            containerIds={network?.containerIds}
            stacks={network?.stacks}
            chips={network?.chips}
            // No details panel here: clicking a node opens the real HCL in the
            // editor beside the diagram — the panel would only repeat it.
            detailsPanel={false}
            selectedAddress={selectedAddress}
            onNodeSelect={(node) => {
              // A user selection replaces whatever the cursor had lit.
              setSelectedAddress(node?.id ?? null);
              post({ type: "nodeSelected", address: node?.id ?? null });
            }}
          />
        )}

        {view !== "iam" && (
          <ZoomOverlay
            onZoomIn={() => camera.current?.zoomIn()}
            onZoomOut={() => camera.current?.zoomOut()}
            // In diff mode, "fit" means fit the changes: framing the whole
            // estate is the wrong answer to "what moved". With nothing
            // changed the canvas falls back to the full graph.
            onFit={() =>
              camera.current?.fit(diffActive ? changedFocusIds(graph) : undefined)
            }
            fitsChanges={diffActive && !facts.clean}
          />
        )}
      </div>

      {/* Everything a reader asks *about* the diagram rather than of it. The
          notice slot holds one thing at a time — the old panel let a banner,
          a chip and a pill all have the canvas at once. */}
      <StatusBar
        base={
          diffActive ? { ref: facts.ref, sha: facts.sha } : null
        }
        sync={sync}
        notice={statusNotice({
          diffEnabled: prefs.enabled,
          facts,
          outOfSync,
          multiRoot,
          folder,
        })}
        onAbout={() => setAboutOpen((open) => !open)}
      >
        {view !== "iam" && (
          <LegendButton
            graph={network ? network.graph : displayed}
            variant={diffActive ? "plan" : "docs"}
            open={legendOpen}
            onToggle={() => setLegendOpen((open) => !open)}
            onClose={() => setLegendOpen(false)}
          />
        )}
        <AboutDiffPopover open={aboutOpen} onClose={() => setAboutOpen(false)} />
      </StatusBar>
    </div>
  );
}
