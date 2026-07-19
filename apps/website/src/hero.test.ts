// Hero + problem strip — commercial pass. The tagline survives, the visual
// stays the real GP-37 export (never a mockup), and the conversion journey
// is dual-CTA: product tour first, security story second.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it, expect } from "vitest";
import { pageHtml, pageText, expectVerbatim } from "./test-helpers.js";

describe("hero + problem strip", () => {
  it("keeps the tagline and leads with the benefit, not the mechanics", () => {
    expectVerbatim("index.html", "See your infrastructure. Review it. Shape it.");
    expectVerbatim(
      "index.html",
      "Groundplan turns your infrastructure code into living, interactive diagrams. Every pull request becomes a picture of what changes — and your architecture docs redraw themselves on every merge.",
    );
  });

  it("offers a dual CTA: product tour primary, security story secondary", () => {
    const html = pageHtml("index.html");
    expect(html).toMatch(/href="#product"[^>]*>\s*See it in action/);
    expect(html).toMatch(/href="\/security\/"/);
    expect(pageText("index.html")).toContain("How we keep your cloud safe");
  });

  it("states the four trust chips under the CTAs", () => {
    const text = pageText("index.html");
    for (const chip of [
      "No cloud credentials",
      "No state access",
      "One line in your CI",
      "Self-host or SaaS",
    ]) {
      expect(text).toContain(chip);
    }
  });

  it("names the four pains in plain language", () => {
    const text = pageText("index.html");
    for (const pain of [
      "Approved blind",
      "Docs that lie",
      "Surprise blast radius",
      "Tools that want the keys",
    ]) {
      expect(text).toContain(pain);
    }
  });

  it("uses the real GP-37 export as the hero visual", () => {
    expect(pageHtml("index.html")).toContain("/images/hero-pr-diagram.svg");
    const svg = readFileSync(
      join(import.meta.dirname, "..", "public", "images", "hero-pr-diagram.svg"),
      "utf8",
    );
    // Signatures of the server renderer (graph/svg.ts): the title block wordmark
    // and the per-relationship arrow markers.
    expect(svg).toContain(">groundplan</text>");
    expect(svg).toContain('id="arrow-');
    expect(svg).toContain("asteriusit/groundplan-example");
  });

  it("closes with the pipeline-step promise", () => {
    expect(pageText("index.html")).toContain(
      "One pipeline step away from seeing your infrastructure.",
    );
  });
});
