/**
 * The preview's bundle must carry no Markdown renderer. `AiResponse` reaches
 * it only through the `@groundplan/canvas` barrel — which Rollup cannot shake
 * out — and drags ~350 KB of micromark/mdast/unified into a webview that is
 * offline and renders no AI prose. vite.config.ts aliases it away; this is the
 * guard that says so.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const bundle = fileURLToPath(
  new URL("../dist/webview/webview.js", import.meta.url),
);

// `pnpm test` must stay runnable without a prior `pnpm build`.
test(
  "the webview bundle carries no Markdown renderer",
  { skip: existsSync(bundle) ? false : "no dist/webview — run pnpm build first" },
  () => {
    const js = readFileSync(bundle, "utf8");
    assert.ok(
      js.includes("bundles no Markdown renderer"),
      "the react-markdown stub did not replace the real renderer",
    );
    assert.ok(
      !js.includes("micromark"),
      "micromark leaked into the webview bundle — check the vite.config alias",
    );
  },
);
