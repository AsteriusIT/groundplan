import assert from "node:assert/strict";
import { test } from "node:test";

import { buildWebviewHtml, makeNonce } from "./webview-html";

const html = buildWebviewHtml({
  cspSource: "vscode-resource://test",
  nonce: "NONCE123",
  baseHref: "vscode-resource://test/dist/webview",
});

test("the webview loads only bundled assets — CSP allows no remote origin", () => {
  const csp = /http-equiv="Content-Security-Policy" content="([^"]+)"/.exec(html);
  assert.ok(csp, "a CSP meta tag is present");
  const policy = csp[1] ?? "";
  assert.match(policy, /default-src 'none'/);
  // Nothing in the policy permits an http(s) origin — the offline principle.
  assert.ok(!/https?:/.test(policy), `no http(s) source in CSP: ${policy}`);
  assert.match(policy, /script-src 'nonce-NONCE123'/);
  assert.match(policy, /img-src vscode-resource:\/\/test data:/);
  assert.match(policy, /style-src vscode-resource:\/\/test 'unsafe-inline'/);
  assert.match(policy, /font-src vscode-resource:\/\/test/);
});

test("relative bundle assets resolve through a <base> tag", () => {
  assert.match(html, /<base href="vscode-resource:\/\/test\/dist\/webview\/"\/>/);
  assert.match(html, /<script type="module" nonce="NONCE123" src="webview\.js">/);
  assert.match(html, /<link rel="stylesheet" href="webview\.css"\/>/);
});

test("nonces are fresh and URL-safe", () => {
  const a = makeNonce();
  const b = makeNonce();
  assert.notEqual(a, b);
  assert.match(a, /^[A-Za-z0-9_-]{16,}$/);
});
