/// <reference types="vitest/config" />
import { fileURLToPath, URL } from "node:url";

import { defineConfig } from "vitest/config";
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
  // The preview renders no AI prose, but the canvas barrel re-exports
  // AiResponse and Rollup cannot shake a barrel re-export out — so ~350 KB of
  // micromark/mdast/unified rode along in a bundle that never ran it. The
  // stubs throw, so the assumption fails loudly if it ever stops holding.
  // Guarded by src/bundle.test.ts.
  //
  // Note: this alias is a Rollup (bundler) concept only. tsc (the type
  // checker) resolves modules via Node's module resolution and sees the real
  // types in packages/canvas/node_modules, not the stubs. The stubs need not
  // be type-compatible with AiResponse; they only throw at runtime if ever
  // imported, and the preview never imports them.
  resolve: {
    alias: {
      "react-markdown": fileURLToPath(
        new URL("./webview/stubs/react-markdown.ts", import.meta.url),
      ),
      "remark-gfm": fileURLToPath(
        new URL("./webview/stubs/remark-gfm.ts", import.meta.url),
      ),
    },
  },
  // The webview's own tests. `include` is webview-only on purpose: everything
  // under src/ is a node:test file for the extension host, which vitest would
  // pick up and fail on. `pnpm test` runs the two runners in sequence.
  test: {
    environment: "jsdom",
    setupFiles: ["./webview/test-setup.ts"],
    include: ["webview/**/*.test.{ts,tsx}"],
  },
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
