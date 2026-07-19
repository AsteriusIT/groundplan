// Shared helpers for the site tests. Tests run against the built site — the
// package test script is `astro build && vitest run` — because what ships is
// dist/, not the .astro sources.
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { expect } from "vitest";
import * as axe from "axe-core";

export const DIST = join(import.meta.dirname, "..", "dist");

export function pageHtml(page: string): string {
  const path = join(DIST, page);
  if (!existsSync(path)) throw new Error(`missing built page: ${page} — run astro build`);
  return readFileSync(path, "utf8");
}

/** Visible text of a built page — tags stripped, whitespace collapsed — so
 * verbatim-copy assertions survive inline markup (<code>, <strong>, links). */
export function pageText(page: string): string {
  return pageHtml(page)
    .replace(/<script[\s\S]*?<\/script>/g, " ")
    .replace(/<style[\s\S]*?<\/style>/g, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&#39;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, "&")
    .replace(/&nbsp;/g, " ")
    .replace(/\s+/g, " ")
    .replace(/\s+([,.;:!?])/g, "$1");
}

export function expectVerbatim(page: string, copy: string): void {
  expect(pageText(page)).toContain(copy.replace(/\s+/g, " ").trim());
}

/** Needs a jsdom test environment (`// @vitest-environment jsdom`). */
export async function expectNoAxeViolations(html: string): Promise<void> {
  document.documentElement.innerHTML = html;
  const results = await axe.run(document.body, {
    // The full document (html lang, title) is asserted via string checks —
    // jsdom only mounts what we hand it, so page-level rules misfire here.
    rules: { region: { enabled: false } },
  });
  expect(results.violations).toEqual([]);
}
