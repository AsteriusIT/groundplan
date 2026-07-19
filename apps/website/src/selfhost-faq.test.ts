// Self-host/SaaS, FAQ, closing CTA, meta & footer — commercial pass. The six
// FAQ answers stay verbatim (they are the pitch, honestly worded); meta, OG
// and robots guards are unchanged from GP-164/166.
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { describe, it, expect } from "vitest";
import { DIST, pageHtml, pageText, expectVerbatim } from "./test-helpers.js";

const META =
  "Groundplan turns Terraform and Kubernetes into living, interactive architecture diagrams. It renders every pull request as a visual change — with blast radius, security exposure and permission risks — and regenerates your documentation on every merge. It reads only the plan JSON and manifests your own CI produces: no cloud credentials, no state access, ever. With network, IAM and C4 lenses, a human annotation layer, an honest opt-in AI, a CLI, a live VS Code preview and one-file self-hosting, it's infrastructure review the way it should have always worked: visible.";

function decodeAttr(value: string): string {
  return value.replace(/&#39;/g, "'").replace(/&quot;/g, '"').replace(/&amp;/g, "&");
}

describe("self-host, FAQ, meta & footer", () => {
  it("sells both deployment modes in plain words", () => {
    expectVerbatim(
      "index.html",
      "One compose file runs everything — proxy with automatic HTTPS, frontend, API, database, identity. Nothing phones home.",
    );
    expectVerbatim("index.html", "Same build, one flag. Any OIDC provider — or the one in the box.");
    expectVerbatim("index.html", "fail-closed, not fail-open");
  });

  it("answers all six FAQ seeds verbatim, as plain <details>", () => {
    const html = pageHtml("index.html");
    expect(html.match(/<details/g) ?? []).toHaveLength(6);
    for (const answer of [
      "No. Groundplan never holds cloud credentials or state. Your CI sends us the plan JSON it already produces.",
      "Never. Rendering happens in your CI; we ingest the output.",
      "A Markdown brief rendered from Groundplan's own deterministic outputs — never your raw plan files. And with no API key configured, the AI layer is entirely absent.",
      "Yes — the whole platform, including the identity provider, from one compose file with automatic HTTPS.",
      "It says so. Partial diagrams carry explicit warnings; we never silently store an empty or misleading graph.",
      "No. It parses locally, works fully offline and contains no telemetry.",
    ]) {
      expectVerbatim("index.html", answer);
    }
  });

  it("closes with the app as the primary CTA, security as the secondary", () => {
    expect(pageText("index.html")).toContain(
      "Groundplan is in private preview — the app is open to try.",
    );
    const html = pageHtml("index.html");
    const cta = html.lastIndexOf('aria-label="Get started"');
    expect(cta).toBeGreaterThan(-1);
    const block = html.slice(cta);
    expect(block).toMatch(/href="https:\/\/app\.groundplan\.qcs\.ovh\/"/);
    expect(block).toMatch(/href="\/security\/"/);
    expect(block.indexOf("app.groundplan")).toBeLessThan(block.indexOf("/security/"));
  });

  it("uses the §14 paragraph as the meta description", () => {
    const html = pageHtml("index.html");
    const meta = html.match(/<meta name="description" content="([^"]+)"/)?.[1];
    expect(meta).toBeDefined();
    expect(decodeAttr(meta!)).toBe(META);
  });

  it("emits a valid OG card: absolute image URL, title, description", () => {
    const html = pageHtml("index.html");
    const og = html.match(/<meta property="og:image" content="([^"]+)"/)?.[1];
    expect(og).toMatch(/^https:\/\/.+\/images\/og-image\.png$/);
    expect(existsSync(join(DIST, "images", "og-image.png"))).toBe(true);
    expect(html).toContain('<meta property="og:title"');
    expect(html).toContain('<meta property="og:description"');
    expect(html).toContain('<meta name="twitter:card" content="summary_large_image"');
  });

  it("ships sitemap + robots, robots still noindex until GP-166 clears", () => {
    const sitemap = readFileSync(join(DIST, "sitemap.xml"), "utf8");
    expect(sitemap).toContain("<loc>https://www.groundplan.qcs.ovh/</loc>");
    expect(sitemap).toContain("<loc>https://www.groundplan.qcs.ovh/security/</loc>");
    expect(readFileSync(join(DIST, "robots.txt"), "utf8")).toContain("Disallow: /");
  });

  it("keeps the footer to legal placeholders only", () => {
    expect(pageHtml("index.html")).toContain("Legal notice and privacy policy to follow");
  });
});
