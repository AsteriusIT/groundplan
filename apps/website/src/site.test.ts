// @vitest-environment jsdom
//
// Site-level guards (GP-158): fonts + palette, noindex, language/title, axe.
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, it, expect } from "vitest";
import { DIST, pageHtml, expectNoAxeViolations } from "./test-helpers.js";

const PAGES = ["index.html", "security/index.html"];

describe("scaffold (GP-158)", () => {
  it("builds every page", () => {
    for (const page of PAGES) expect(pageHtml(page)).toContain("<!DOCTYPE html>");
  });

  it("renders with the groundplan fonts and the carbon palette", () => {
    const assets = join(DIST, "_astro");
    const css = readdirSync(assets)
      .filter((f) => f.endsWith(".css"))
      .map((f) => readFileSync(join(assets, f), "utf8"))
      .join("\n");
    for (const token of [
      "Space Grotesk",
      "Inter Variable",
      "IBM Plex Mono",
      "--background:#0c0d10",
      "--primary:#4c8dff",
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
