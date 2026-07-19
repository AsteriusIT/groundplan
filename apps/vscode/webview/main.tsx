/**
 * The preview webview (GP-147): a bare React root around the shared canvas.
 * All state arrives by message from the extension host — the webview holds no
 * knowledge of the workspace beyond what it was last told.
 *
 * Three lenses, mirroring the web app's playground: Global (the raw diagram),
 * Network (the networkProjection fold — containers, stacks, chips) and IAM
 * (the table). Pure client-side folds of the same snapshot; switching never
 * re-parses.
 */
import { StrictMode, useEffect, useMemo, useState } from "react";
import { createRoot } from "react-dom/client";

import {
  cn,
  GraphCanvas,
  IamTable,
  networkProjection,
  type Graph,
} from "@groundplan/canvas";
import "@groundplan/canvas/styles.css";

import type { HostMessage, WebviewMessage } from "../src/messages";

declare function acquireVsCodeApi(): {
  postMessage(message: WebviewMessage): void;
};

const vscode = acquireVsCodeApi();

type View = "infra" | "network" | "iam";

const VIEWS: readonly { key: View; label: string }[] = [
  { key: "infra", label: "Global" },
  { key: "network", label: "Network" },
  { key: "iam", label: "IAM" },
];

function App(): React.JSX.Element {
  const [graph, setGraph] = useState<Graph | null>(null);
  const [folder, setFolder] = useState("");
  const [multiRoot, setMultiRoot] = useState(false);
  const [outOfSync, setOutOfSync] = useState(false);
  const [selectedAddress, setSelectedAddress] = useState<string | null>(null);
  const [view, setView] = useState<View>("infra");

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
      }
    };
    window.addEventListener("message", onMessage);
    vscode.postMessage({ type: "ready" });
    return () => window.removeEventListener("message", onMessage);
  }, []);

  // The network fold is cheap but not free — only computed while looked at.
  const network = useMemo(
    () => (graph && view === "network" ? networkProjection(graph) : null),
    [graph, view],
  );

  if (!graph) {
    return (
      <div className="flex h-screen items-center justify-center bg-background">
        <p className="text-muted-foreground text-sm">Reading Terraform…</p>
      </div>
    );
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

      <div className="border-border-strong bg-panel absolute left-1/2 top-3 z-20 flex -translate-x-1/2 overflow-hidden rounded-sm border">
        {VIEWS.map(({ key, label }) => (
          <button
            key={key}
            type="button"
            onClick={() => setView(key)}
            aria-pressed={view === key}
            className={cn(
              "px-2.5 py-1 font-mono text-xs uppercase tracking-wide",
              view === key
                ? "bg-accent-soft text-primary"
                : "text-muted-foreground hover:text-foreground",
            )}
          >
            {label}
          </button>
        ))}
      </div>

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
          graph={network ? network.graph : graph}
          variant="docs"
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
