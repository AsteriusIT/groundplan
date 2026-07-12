import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter } from "react-router-dom";

// Self-hosted fonts (no runtime Google Fonts → no FOUT/FOIT). GP-28.
import "@fontsource-variable/inter";
import "@fontsource-variable/space-grotesk";
import "@fontsource/ibm-plex-mono/400.css";
import "@fontsource/ibm-plex-mono/500.css";
import "@fontsource/ibm-plex-mono/600.css";

import { AuthProvider } from "@/auth/auth-provider";
import { loadConfig } from "@/config";
import App from "./App.tsx";
import "./index.css";

const rootElement = document.getElementById("root");
if (!rootElement) {
  throw new Error("Root element #root not found in index.html");
}

// Load runtime config (/config.json) before rendering, so the API client and
// the OIDC UserManager read final values on their first use. (A wrapper rather
// than top-level await — the build target, es2020, doesn't support the latter.)
async function bootstrap(container: HTMLElement): Promise<void> {
  await loadConfig();

  createRoot(container).render(
    <StrictMode>
      <BrowserRouter>
        <AuthProvider>
          <App />
        </AuthProvider>
      </BrowserRouter>
    </StrictMode>,
  );
}

void bootstrap(rootElement); // NOSONAR: top-level await unsupported by es2020 target
