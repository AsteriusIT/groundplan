/**
 * The preview panel's HTML (GP-147). Built by hand — the bundle has stable
 * entry names (webview.js / webview.css, see vite.config.ts) and everything
 * else resolves relative to the <base> tag, so hashed icon and font assets
 * load through `asWebviewUri` URIs without the host knowing their names.
 *
 * Strict CSP, per the epic's offline principle: no origin but the webview's
 * own resource root is ever allowed, and scripts run only with the nonce.
 */
import { randomBytes } from "node:crypto";

import type { PreviewTheme } from "./messages";

export type WebviewHtmlInput = {
  /** `webview.cspSource` — the only origin assets may come from. */
  cspSource: string;
  /** Per-panel random nonce; the only script allowed to run. */
  nonce: string;
  /** `asWebviewUri(dist/webview)` — the <base> the bundle resolves against. */
  baseHref: string;
  /** Baked into <html> so the panel opens in the right theme, no flash. */
  theme: PreviewTheme;
};

/** A fresh URL-safe nonce for one webview lifetime. */
export function makeNonce(): string {
  return randomBytes(16).toString("base64url");
}

export function buildWebviewHtml({
  cspSource,
  nonce,
  baseHref,
  theme,
}: WebviewHtmlInput): string {
  const csp = [
    "default-src 'none'",
    `img-src ${cspSource} data:`,
    // React Flow positions nodes with inline styles — 'unsafe-inline' for
    // styles is the documented webview trade-off; scripts stay nonce-only.
    `style-src ${cspSource} 'unsafe-inline'`,
    `font-src ${cspSource}`,
    `script-src 'nonce-${nonce}'`,
  ].join("; ");

  // Light is the canvas package's :root default — a bare <html> selects it.
  const themeAttrs = theme === "carbon" ? ' class="dark" data-theme="carbon"' : "";

  return `<!doctype html>
<html lang="en"${themeAttrs}>
<head>
<meta charset="UTF-8"/>
<meta http-equiv="Content-Security-Policy" content="${csp}"/>
<meta name="viewport" content="width=device-width, initial-scale=1.0"/>
<base href="${baseHref}/"/>
<link rel="stylesheet" href="webview.css"/>
<title>Groundplan Preview</title>
</head>
<body>
<div id="root"></div>
<script type="module" nonce="${nonce}" src="webview.js"></script>
</body>
</html>`;
}
