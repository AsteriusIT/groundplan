// Hero animation: HCL wall → diagram (GP-165). CSS/SVG only over the same
// static export; reduced motion falls back to the static image; < 200 KB
// added; no layout shift (the wall is absolutely positioned over the box the
// image's width/height already reserve).
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, it, expect } from "vitest";
import { DIST, pageHtml } from "./test-helpers.js";

/** All CSS the page ships: external _astro bundles + Astro-inlined <style>. */
function builtCss(): string {
  const assets = join(DIST, "_astro");
  const external = readdirSync(assets)
    .filter((f) => f.endsWith(".css"))
    .map((f) => readFileSync(join(assets, f), "utf8"))
    .join("\n");
  const inline = (pageHtml("index.html").match(/<style>[\s\S]*?<\/style>/g) ?? []).join("\n");
  return external + "\n" + inline;
}

describe("hero animation (GP-165)", () => {
  it("lays the plan-diff wall over the same static export", () => {
    const html = pageHtml("index.html");
    expect(html).toContain("hcl-wall");
    expect(html).toContain("Plan: 3 to add, 1 to change, 1 to destroy.");
    // The wall content matches the PR-42 plan fixture, not lorem ipsum.
    expect(html).toContain("azurerm_redis_cache.sessions will be created");
    expect(html).toContain("azurerm_storage_account.legacy_sessions will be destroyed");
    // The static export stays in place beneath it.
    expect(html).toContain("/images/hero-pr-diagram.svg");
  });

  it("falls back to the static hero under prefers-reduced-motion", () => {
    const css = builtCss();
    expect(css).toMatch(
      /prefers-reduced-motion:\s*reduce[^{]*\{[^{}]*\.hcl-wall[^{}]*\{[^}]*display:\s*none/,
    );
  });

  it("animates via CSS only and adds well under 200 KB", () => {
    const html = pageHtml("index.html");
    const wallStart = html.indexOf('class="hcl-wall');
    const wallEnd = html.indexOf("</div>", wallStart);
    const wallBytes = Buffer.byteLength(html.slice(wallStart, wallEnd));
    const css = builtCss();
    const animBytes =
      (css.match(/@keyframes[^{]*hcl-[\s\S]*?\}\s*\}/g) ?? []).join("").length;
    expect(wallBytes + animBytes).toBeLessThan(200_000);
    expect(css).toContain("hcl-sweep");
    // No JS drives the animation.
    expect(html.slice(wallStart, wallEnd)).not.toContain("<script");
  });

  it("keeps the wall out of the accessibility tree", () => {
    const html = pageHtml("index.html");
    expect(html).toMatch(/aria-hidden="true"[^>]*>\s*<pre/);
  });
});
