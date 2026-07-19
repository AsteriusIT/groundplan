/**
 * Dev-only sandbox (GP-146 AC): render a fixture snapshot with nothing but the
 * package import and its stylesheet — proving a bare webview can do the same.
 * Run with `pnpm --filter @groundplan/canvas dev`.
 */
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

import { GraphCanvas, type Graph } from "../index";
import "../styles.css";

import fixture from "./fixture.graph.json";

const rootElement = document.getElementById("root");
if (!rootElement) throw new Error("Root element #root not found");

createRoot(rootElement).render(
  <StrictMode>
    <div className="blueprint-grid h-screen w-screen bg-canvas">
      <GraphCanvas
        graph={fixture as Graph}
        variant="docs"
        onNodeSelect={(node) => {
          console.log("selected", node?.id ?? null);
        }}
      />
    </div>
  </StrictMode>,
);
