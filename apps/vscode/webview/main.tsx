/**
 * The preview webview (GP-147): a bare React root around the shared canvas.
 * All state arrives by message from the extension host — the webview holds no
 * knowledge of the workspace beyond what it was last told.
 */
import { StrictMode, useEffect, useState } from "react";
import { createRoot } from "react-dom/client";

import { GraphCanvas, type Graph } from "@groundplan/canvas";
import "@groundplan/canvas/styles.css";

import type { HostMessage, WebviewMessage } from "../src/messages";

declare function acquireVsCodeApi(): {
  postMessage(message: WebviewMessage): void;
};

const vscode = acquireVsCodeApi();

function App(): React.JSX.Element {
  const [graph, setGraph] = useState<Graph | null>(null);
  const [folder, setFolder] = useState("");
  const [multiRoot, setMultiRoot] = useState(false);
  const [outOfSync, setOutOfSync] = useState(false);
  const [selectedAddress, setSelectedAddress] = useState<string | null>(null);

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

  if (!graph) {
    return (
      <div className="flex h-screen items-center justify-center bg-background">
        <p className="text-muted-foreground text-sm">Reading Terraform…</p>
      </div>
    );
  }

  return (
    <div className="blueprint-grid relative h-screen w-screen bg-canvas">
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
      <GraphCanvas
        graph={graph}
        variant="docs"
        selectedAddress={selectedAddress}
        onNodeSelect={(node) => {
          // A user selection replaces whatever the cursor had lit.
          setSelectedAddress(node?.id ?? null);
          vscode.postMessage({ type: "nodeSelected", address: node?.id ?? null });
        }}
      />
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
