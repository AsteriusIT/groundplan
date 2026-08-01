/**
 * The preview webview (GP-147): a bare React root around the shared canvas.
 * All state arrives by message from the extension host — the webview holds no
 * knowledge of the workspace beyond what it was last told.
 *
 * Three lenses, mirroring the web app's playground: Global (the raw diagram),
 * Network (the networkProjection fold — containers, stacks, chips) and IAM
 * (the table). Pure client-side folds of the same snapshot; switching never
 * re-parses.
 *
 * Diff mode (GP-154): the host posts a differ-annotated snapshot instead of
 * the raw one; this side reuses the PR view's visual language (variant="plan":
 * change colours, ghost deletes, impacted rings), adds the baseline toolbar,
 * a "changed only" fold, and the honest-framing caption — a code diff is not
 * a plan and never pretends to be.
 */
import { StrictMode, useEffect, useMemo, useReducer, useState } from "react";
import { createRoot } from "react-dom/client";
import { GitCompareArrows } from "lucide-react";

import { changedOnly as changedOnlyFold } from "@groundplan/graph-differ";
import {
  cn,
  GraphCanvas,
  IamTable,
  networkProjection,
  type Graph,
} from "@groundplan/canvas";
import "@groundplan/canvas/styles.css";

import type {
  BaselineMode,
  DiffState,
  HostMessage,
  PreviewTheme,
  WebviewMessage,
} from "../src/messages";
import {
  INITIAL_PANEL_STATE,
  panelReducer,
  type Lens,
  type PanelAction,
} from "./state/panel-state";

declare function acquireVsCodeApi(): {
  postMessage(message: WebviewMessage): void;
};

const vscode = acquireVsCodeApi();

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

const VIEWS: readonly { key: Lens; label: string }[] = [
  { key: "infra", label: "Global" },
  { key: "network", label: "Network" },
  { key: "iam", label: "IAM" },
];

/**
 * What the host reported about the diff, as opposed to what the reader chose
 * (that lives in `PanelState`). Whether a baseline resolved, which ref it is,
 * why it did not and whether the diff came back clean are all facts about the
 * workspace — the panel must never be able to assert one on its own.
 */
type DiffFacts = Pick<DiffState, "available" | "ref" | "reason" | "clean">;

const NO_DIFF_FACTS: DiffFacts = {
  available: false,
  ref: null,
  reason: null,
  clean: false,
};


/** One toolbar pill; the shared look of every control up top. */
function Pill({
  active,
  onClick,
  title,
  children,
}: Readonly<{
  active: boolean;
  onClick: () => void;
  title?: string;
  children: React.ReactNode;
}>): React.JSX.Element {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      title={title}
      className={cn(
        "px-2.5 py-1 font-mono text-xs uppercase tracking-wide",
        active
          ? "bg-accent-soft text-primary"
          : "text-muted-foreground hover:text-foreground",
      )}
    >
      {children}
    </button>
  );
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

function App(): React.JSX.Element {
  const [graph, setGraph] = useState<Graph | null>(null);
  const [folder, setFolder] = useState("");
  const [rootDir, setRootDir] = useState("");
  const [multiRoot, setMultiRoot] = useState(false);
  const [outOfSync, setOutOfSync] = useState(false);
  const [selectedAddress, setSelectedAddress] = useState<string | null>(null);
  const [panel, dispatch] = useReducer(panelReducer, INITIAL_PANEL_STATE);
  const [facts, setFacts] = useState<DiffFacts>(NO_DIFF_FACTS);
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
      } else if (message.type === "theme") {
        applyTheme(message.theme);
      }
    };
    window.addEventListener("message", onMessage);
    vscode.postMessage({ type: "ready" });
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
    if (next.diff !== panel.diff) {
      vscode.postMessage({ type: "setDiffPrefs", ...next.diff });
    }
  };

  const diffActive = prefs.enabled && facts.available;

  // "Changed only" (GP-154): changed nodes + one hop of context. A clean diff
  // shows the full all-noop graph with its banner, never an empty canvas.
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
    <div
      className={cn(
        "relative h-screen w-screen bg-canvas",
        view !== "iam" && "blueprint-grid",
      )}
    >
      {multiRoot && (
        <div className="bg-warning-soft text-warning absolute inset-x-0 top-0 z-20 px-3 py-1 text-center font-mono text-xs">
          Previewing “{folder}” — the first of several workspace folders.
        </div>
      )}
      {outOfSync && (
        <div className="bg-warning-soft text-warning border-warning absolute right-3 top-3 z-20 rounded-sm border px-2 py-1 font-mono text-xs">
          Out of sync — showing the last good parse
        </div>
      )}

      <div className="absolute left-1/2 top-3 z-20 flex -translate-x-1/2 items-start gap-2">
        <div className="border-border-strong bg-panel flex overflow-hidden rounded-sm border">
          {VIEWS.map(({ key, label }) => (
            <Pill
              key={key}
              active={view === key}
              onClick={() => act({ type: "setLens", lens: key })}
            >
              {label}
            </Pill>
          ))}
        </div>

        {/* Diff controls — deliberately NOT the view-pill chrome: switching a
            view and turning a tool on are different ideas, and dressing them
            alike makes the toolbar read as one long view switcher. A labelled
            icon toggle, a "vs <ref>" select and a checkbox say "tool". */}
        {view !== "iam" && (
          <div className="flex items-center gap-1.5">
            <button
              type="button"
              onClick={() => act({ type: "toggleDiff" })}
              aria-pressed={prefs.enabled}
              title="Colour the diagram as changes against a git baseline"
              className={cn(
                "flex items-center gap-1.5 rounded-sm border px-2 py-1 font-mono text-xs shadow-sm",
                prefs.enabled
                  ? "border-primary bg-primary text-primary-foreground"
                  : "border-border-strong bg-panel text-muted-foreground hover:text-foreground",
              )}
            >
              <GitCompareArrows className="size-3.5" />
              Diff
            </button>
            {prefs.enabled && (
              <>
                <select
                  aria-label="Diff baseline"
                  value={prefs.mode}
                  onChange={(e) =>
                    act({ type: "setBase", mode: e.target.value as BaselineMode })
                  }
                  className="border-border-strong bg-panel text-foreground rounded-sm border px-1.5 py-1 font-mono text-xs shadow-sm"
                >
                  <option value="head">vs HEAD</option>
                  <option value="merge-base">vs main</option>
                </select>
                {view === "infra" && (
                  <label
                    title="Show changed nodes and one hop of context"
                    className="border-border-strong bg-panel text-muted-foreground hover:text-foreground flex cursor-pointer items-center gap-1.5 rounded-sm border px-2 py-1 font-mono text-xs shadow-sm"
                  >
                    <input
                      type="checkbox"
                      checked={prefs.changedOnly}
                      onChange={() => act({ type: "toggleChangedOnly" })}
                      className="accent-primary size-3"
                    />
                    Changed only
                  </label>
                )}
              </>
            )}
          </div>
        )}
      </div>

      {view !== "iam" && prefs.enabled && !facts.available && (
        <div className="bg-warning-soft text-warning absolute left-1/2 top-14 z-20 -translate-x-1/2 rounded-sm px-3 py-1 font-mono text-xs">
          Diff unavailable — {facts.reason ?? "no baseline"}. Showing the live view.
        </div>
      )}
      {view !== "iam" && diffActive && facts.clean && (
        <div className="border-border-strong bg-panel text-muted-foreground absolute left-1/2 top-14 z-20 -translate-x-1/2 rounded-sm border px-3 py-1 font-mono text-xs">
          No changes vs {facts.ref}
        </div>
      )}

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
            vscode.postMessage({ type: "nodeSelected", address: node?.id ?? null });
          }}
        />
      )}

      {/* Honest framing, bottom-right above the zoom chip — the bottom-left
          corner belongs to the legend, and a caption sitting on top of it hid
          the very states the legend exists to explain. */}
      {view !== "iam" && diffActive && (
        <div
          className="border-border-strong bg-panel text-muted-foreground absolute right-3 bottom-12 z-20 max-w-xs rounded-sm border px-2.5 py-1 text-right font-mono text-[10px]"
          role="note"
        >
          Code diff vs {facts.ref} — not a plan: no state, no count/for_each
          expansion.
        </div>
      )}
    </div>
  );
}

const rootElement = document.getElementById("root");
if (!rootElement) throw new Error("Root element #root not found");
createRoot(rootElement).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
