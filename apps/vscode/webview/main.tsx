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
import { StrictMode, useEffect, useMemo, useState } from "react";
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

type View = "infra" | "network" | "iam";

const VIEWS: readonly { key: View; label: string }[] = [
  { key: "infra", label: "Global" },
  { key: "network", label: "Network" },
  { key: "iam", label: "IAM" },
];


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

function App(): React.JSX.Element {
  const [graph, setGraph] = useState<Graph | null>(null);
  const [folder, setFolder] = useState("");
  const [multiRoot, setMultiRoot] = useState(false);
  const [outOfSync, setOutOfSync] = useState(false);
  const [selectedAddress, setSelectedAddress] = useState<string | null>(null);
  const [view, setView] = useState<View>("infra");
  const [diff, setDiff] = useState<DiffState | null>(null);

  useEffect(() => {
    const onMessage = (event: MessageEvent<HostMessage>): void => {
      const message = event.data;
      if (message.type === "snapshot") {
        setGraph(message.snapshot);
        setFolder(message.folder);
        setMultiRoot(message.multiRoot);
      } else if (message.type === "outOfSync") {
        setOutOfSync(message.value);
      } else if (message.type === "select") {
        setSelectedAddress(message.address);
      } else if (message.type === "diffState") {
        setDiff(message.state);
      } else if (message.type === "theme") {
        applyTheme(message.theme);
      }
    };
    window.addEventListener("message", onMessage);
    vscode.postMessage({ type: "ready" });
    return () => window.removeEventListener("message", onMessage);
  }, []);

  /** Optimistic prefs update; the host persists and echoes the new state. */
  const setPrefs = (next: {
    enabled: boolean;
    mode: BaselineMode;
    changedOnly: boolean;
  }): void => {
    setDiff((prev) => ({
      enabled: next.enabled,
      mode: next.mode,
      changedOnly: next.changedOnly,
      available: prev?.available ?? false,
      ref: prev?.ref ?? null,
      reason: prev?.reason ?? null,
      clean: prev?.clean ?? false,
    }));
    vscode.postMessage({ type: "setDiffPrefs", ...next });
  };

  const diffActive = (diff?.enabled ?? false) && (diff?.available ?? false);

  // "Changed only" (GP-154): changed nodes + one hop of context. A clean diff
  // shows the full all-noop graph with its banner, never an empty canvas.
  const displayed = useMemo(() => {
    if (!graph) return null;
    if (view === "infra" && diffActive && diff?.changedOnly && !diff.clean) {
      return changedOnlyFold(graph) as Graph;
    }
    return graph;
  }, [graph, view, diffActive, diff?.changedOnly, diff?.clean]);

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

  const prefs = diff ?? {
    enabled: false,
    mode: "head" as BaselineMode,
    changedOnly: false,
    available: false,
    ref: null,
    reason: null,
    clean: false,
  };

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
            <Pill key={key} active={view === key} onClick={() => setView(key)}>
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
              onClick={() => setPrefs({ ...prefs, enabled: !prefs.enabled })}
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
                    setPrefs({ ...prefs, mode: e.target.value as BaselineMode })
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
                      onChange={() =>
                        setPrefs({ ...prefs, changedOnly: !prefs.changedOnly })
                      }
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

      {view !== "iam" && prefs.enabled && !prefs.available && (
        <div className="bg-warning-soft text-warning absolute left-1/2 top-14 z-20 -translate-x-1/2 rounded-sm px-3 py-1 font-mono text-xs">
          Diff unavailable — {prefs.reason ?? "no baseline"}. Showing the live view.
        </div>
      )}
      {view !== "iam" && diffActive && prefs.clean && (
        <div className="border-border-strong bg-panel text-muted-foreground absolute left-1/2 top-14 z-20 -translate-x-1/2 rounded-sm border px-3 py-1 font-mono text-xs">
          No changes vs {prefs.ref}
        </div>
      )}

      {view === "iam" ? (
        <IamTable
          graph={graph}
          variant="docs"
          onViewInPlanImpact={(node) => {
            // "View on canvas": back to the diagram with that node selected.
            setView("infra");
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
          Code diff vs {prefs.ref} — not a plan: no state, no count/for_each
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
