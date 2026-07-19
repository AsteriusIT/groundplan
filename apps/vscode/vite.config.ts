import { fileURLToPath, URL } from "node:url";

import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

// The webview bundle (GP-147). Vite, not esbuild, because the canvas package
// leans on Vite features: Tailwind v4 for its stylesheet and import.meta.glob
// for the icon assets. Everything lands under dist/webview with STABLE entry
// names (webview.js / webview.css) — the extension host writes the webview
// HTML by hand and must know what to reference; icon/font assets keep content
// hashes (two providers both ship a kms.svg) and resolve via the <base> tag.
export default defineConfig({
  plugins: [react(), tailwindcss()],
  build: {
    outDir: "dist/webview",
    emptyOutDir: true,
    cssCodeSplit: false,
    rollupOptions: {
      input: fileURLToPath(new URL("./webview/main.tsx", import.meta.url)),
      output: {
        format: "es",
        entryFileNames: "webview.js",
        assetFileNames: (info) =>
          info.names.some((n) => n.endsWith(".css"))
            ? "webview.css"
            : "assets/[name]-[hash][extname]",
      },
    },
  },
});
