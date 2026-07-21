/**
 * Golden tests for the Markdown → Confluence storage-format converter (GP-180).
 * The converter is deliberately minimal: it covers exactly what our own
 * deterministic summary builders emit (headings, lists, bold, inline code,
 * links, paragraphs) — never a general-purpose Markdown engine.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  DIAGRAM_FILENAME,
  docsPageStorage,
  markdownToStorage,
} from "./confluence-content.js";

test("headings, paragraphs, bold, code, links and nested lists convert to storage format", () => {
  const markdown = [
    "# Title",
    "",
    "Hello **world** with `code` and [link](https://example.test).",
    "",
    "## Section",
    "- a — `x`",
    "  - b",
    "- d",
  ].join("\n");

  assert.equal(
    markdownToStorage(markdown),
    [
      "<h1>Title</h1>",
      '<p>Hello <strong>world</strong> with <code>code</code> and <a href="https://example.test">link</a>.</p>',
      "<h2>Section</h2>",
      "<ul><li>a — <code>x</code><ul><li>b</li></ul></li><li>d</li></ul>",
    ].join("\n"),
  );
});

test("XML is escaped everywhere — storage format is XHTML, and model text is data", () => {
  assert.equal(
    markdownToStorage("a < b & c > d"),
    "<p>a &lt; b &amp; c &gt; d</p>",
  );
  // Inside a code span nothing but escaping happens: no bold, no links.
  assert.equal(
    markdownToStorage("`<tag> & **not bold**`"),
    "<p><code>&lt;tag&gt; &amp; **not bold**</code></p>",
  );
  // An attribute value is escaped too.
  assert.equal(
    markdownToStorage('[x](https://e.test/?a=1&b="2")'),
    '<p><a href="https://e.test/?a=1&amp;b=&quot;2&quot;">x</a></p>',
  );
});

test("consecutive plain lines fold into one paragraph", () => {
  assert.equal(
    markdownToStorage("one\ntwo\n\nthree"),
    "<p>one two</p>\n<p>three</p>",
  );
});

test("the docs page embeds the diagram attachment, the summary and the link back", () => {
  const storage = docsPageStorage({
    repoLabel: "acme/infra",
    ref: "main",
    commitSha: "abcdef1234567890",
    generatedAt: new Date("2026-07-21T10:00:00Z"),
    summaryMd: "# Infrastructure documentation\n\n- Resources: 2",
    appUrl: "https://app.test/projects/p1/repos/r1/docs",
  });

  // The diagram is the attachment we upload, referenced by filename — updating
  // the attachment in place updates the picture with no page edit.
  assert.ok(storage.includes(`<ri:attachment ri:filename="${DIAGRAM_FILENAME}" />`));
  assert.ok(storage.includes("<ac:image"));
  // Header facts: repo, short sha, ref.
  assert.ok(storage.includes("acme/infra"));
  assert.ok(storage.includes("abcdef12"));
  assert.ok(storage.includes("main"));
  // The converted summary.
  assert.ok(storage.includes("<h1>Infrastructure documentation</h1>"));
  assert.ok(storage.includes("<li>Resources: 2</li>"));
  // The link back to Groundplan.
  assert.ok(
    storage.includes('<a href="https://app.test/projects/p1/repos/r1/docs">'),
  );
  // The page says it is generated — edits over there do not survive a publish.
  assert.ok(storage.toLowerCase().includes("groundplan"));
});

test("without a public base URL there is no link back — never a broken one", () => {
  const storage = docsPageStorage({
    repoLabel: "acme/infra",
    ref: "main",
    commitSha: "abcdef1234567890",
    generatedAt: new Date("2026-07-21T10:00:00Z"),
    summaryMd: "hello",
    appUrl: null,
  });
  assert.ok(!storage.includes("<a href"));
});
