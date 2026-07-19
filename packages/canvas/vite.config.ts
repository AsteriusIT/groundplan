/// <reference types="vitest/config" />
import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

// Dev server + build serve the sandbox page (webview-readiness proof, GP-146);
// the package itself ships as source and needs no build. The script is named
// `sandbox`, not `dev`, so the root `pnpm dev` never starts it — and the port
// is pinned away from the app's 5173 so it cannot shadow it either way.
export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    port: 5273,
    strictPort: true,
  },
  test: {
    environment: "jsdom",
    setupFiles: ["./src/test-setup.ts"],
  },
});
