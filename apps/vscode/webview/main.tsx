/**
 * The webview entry point: mount the panel. Everything with a decision in it
 * lives in `app.tsx`, which is why this file has none.
 */
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

import { App } from "./app";

const rootElement = document.getElementById("root");
if (!rootElement) throw new Error("Root element #root not found");
createRoot(rootElement).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
