// @vitest-environment jsdom
//
// Site-level guards (GP-158). Tests run against the built site — the package
// test script is `astro build && vitest run` — because what ships is dist/,
// not the .astro sources.
import { readFileSync, existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, it, expect } from "vitest";
import * as axe from "axe-core";

const DIST = join(import.meta.dirname, "..", "dist");

export function pageHtml(page: string): string {
  const path = join(DIST, page);
  if (!existsSync(path)) throw new Error(`missing built page: ${page} — run astro build`);
  return readFileSync(path, "utf8");
}

export async function expectNoAxeViolations(html: string): Promise<void> {
  document.documentElement.innerHTML = html;
  const results = await axe.run(document.body, {
    // The full document (html lang, title) is asserted via string checks —
    // jsdom only mounts what we hand it, so page-level rules misfire here.
    rules: { region: { enabled: false } },
  });
  expect(results.violations).toEqual([]);
}

const PAGES = ["index.html", "security/index.html"];

describe("scaffold (GP-158)", () => {
  it("builds every page", () => {
    for (const page of PAGES) expect(pageHtml(page)).toContain("<!DOCTYPE html>");
  });

  it("renders with the blueprint fonts and palette", () => {
    const assets = join(DIST, "_astro");
    const css = readdirSync(assets)
      .filter((f) => f.endsWith(".css"))
      .map((f) => readFileSync(join(assets, f), "utf8"))
      .join("\n");
    for (const token of [
      "Space Grotesk",
      "Inter Variable",
      "IBM Plex Mono",
      "--background:#f4f7fb",
      "--primary:#2e6be6",
    ]) {
      expect(css).toContain(token);
    }
  });

  it("stays out of the index until the trademark gate clears (GP-166)", () => {
    for (const page of PAGES) {
      expect(pageHtml(page)).toContain('<meta name="robots" content="noindex, nofollow">');
    }
    expect(readFileSync(join(DIST, "robots.txt"), "utf8")).toContain("Disallow: /");
  });

  it("declares a language and a title on every page", () => {
    for (const page of PAGES) {
      const html = pageHtml(page);
      expect(html).toContain('<html lang="en"');
      expect(html).toMatch(/<title>[^<]+<\/title>/);
    }
  });

  it("has no axe violations on any page", async () => {
    for (const page of PAGES) await expectNoAxeViolations(pageHtml(page));
  });
});
