import { fileURLToPath, URL } from "node:url";

import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { keycloakify } from "keycloakify/vite-plugin";

// https://vite.dev/config/
export default defineConfig({
  plugins: [
    react(),
    tailwindcss(),
    keycloakify({
      // The Keycloak theme name (login/account/email are all served under it).
      themeName: "groundplan",
      // Login is the first phase; account is enabled in a later phase.
      accountThemeImplementation: "none",
      // Build a single jar targeting Keycloak 26 (our docker-compose image), with
      // a stable filename so docker-compose can mount it directly.
      keycloakVersionTargets: {
        "22-to-25": false,
        "all-other-versions": "keycloak-theme-groundplan.jar",
      },
    }),
  ],
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
    },
  },
});
