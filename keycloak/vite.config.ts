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
      // The account theme is a full multi-page React theme (account-v1 based),
      // styled with the same carbon primitives as login.
      accountThemeImplementation: "Multi-Page",
      // Build a single jar for our Keycloak image (26.7.0, matching prod), with a
      // stable filename. The Multi-Page account theme bundles account-v1, whose
      // templates are version-ranged — 26.2-and-above covers 26.7.
      keycloakVersionTargets: {
        "21-and-below": false,
        "23": false,
        "24": false,
        "25": false,
        "26.0-to-26.1": false,
        "26.2-and-above": "keycloak-theme-groundplan.jar",
      },
    }),
  ],
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
    },
  },
});
