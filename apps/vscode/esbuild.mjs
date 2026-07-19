/**
 * Bundle the extension host (GP-147). One self-contained CommonJS file — the
 * graph parser (a workspace package) is inlined, so the packaged .vsix carries
 * no node_modules. The webview bundle is Vite's job (vite.config.ts): it needs
 * Tailwind and `import.meta.glob` icon assets, which esbuild does not speak.
 */
import { build } from "esbuild";

await build({
  entryPoints: ["src/extension.ts"],
  outfile: "dist/extension.cjs",
  bundle: true,
  format: "cjs",
  platform: "node",
  target: "node20",
  external: ["vscode"],
  sourcemap: true,
});
