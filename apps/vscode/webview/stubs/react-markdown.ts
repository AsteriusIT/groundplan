/**
 * The VS Code preview renders no AI prose — it is offline by design, and the
 * webview never mounts `AiResponse`. The canvas barrel re-exports it anyway,
 * dragging ~350 KB of micromark/mdast/unified into a bundle that never runs
 * it, and a barrel re-export is exactly what Rollup cannot shake out.
 *
 * `vite.config.ts` points `react-markdown` here for the VS Code build only.
 * This throws rather than rendering nothing: if the preview ever does grow a
 * reason to render Markdown, it must fail loudly instead of silently blank.
 */
export type Components = Record<string, unknown>;

export default function Markdown(): never {
  throw new Error(
    "groundplan: the VS Code preview bundles no Markdown renderer (offline by design)",
  );
}
