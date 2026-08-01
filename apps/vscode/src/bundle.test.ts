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
const skip = existsSync(bundle)
  ? false
  : "no dist/webview — run pnpm build first";

test("the webview bundle carries no Markdown renderer", { skip }, () => {
  const js = readFileSync(bundle, "utf8");
  assert.ok(
    js.includes("bundles no Markdown renderer"),
    "the react-markdown stub did not replace the real renderer",
  );
  assert.ok(
    !js.includes("micromark"),
    "micromark leaked into the webview bundle — check the vite.config alias",
  );
});

/**
 * The webview runs under a strict CSP: `script-src 'nonce-…'` and no
 * `'unsafe-eval'`. Anything that builds a function from source at runtime —
 * a JSON Schema compiler, a template engine, a sandboxed evaluator — throws
 * the moment it is *used*, and if that use is at module scope the whole
 * bundle fails to evaluate. The panel then renders nothing at all, and the
 * console blames a file with none of our code in the stack.
 *
 * This is not hypothetical: importing `computeGraphStats` from
 * `@groundplan/graph-parser` pulled Ajv in, which compiled the graph schema
 * on import and blanked the preview. Ajv is now lazy, but the honest guard is
 * that the code generator has no business being in this bundle at all.
 */
test("the webview bundle carries no runtime code generator", { skip }, () => {
  const js = readFileSync(bundle, "utf8");
  // `new Function` is the exact construct the CSP refuses, and Ajv's own error
  // string is what shows up in the console when it happens. Matching on
  // library names instead would miss the next library that does the same
  // thing — elkjs, for one, ships the string "nonNegativeInteger" from its
  // XML-Schema heritage and generates nothing at all.
  for (const marker of ["new Function", "Error compiling schema"]) {
    assert.ok(
      !js.includes(marker),
      `runtime code generation leaked into the webview bundle (found ` +
        `"${marker}"). The panel's CSP is script-src 'nonce-…' with no ` +
        `'unsafe-eval', so this throws at module evaluation and the whole ` +
        `panel renders blank — with none of our code in the stack trace.`,
    );
  }
});
