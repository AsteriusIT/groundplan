// Hero + problem strip (GP-159). Copy must match the [copy] blocks of
// docs/website-presentation.md verbatim; the hero visual must be the real
// GP-37 export, not a mockup.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it, expect } from "vitest";
import { pageHtml, pageText, expectVerbatim } from "./test-helpers.js";

describe("hero + problem strip (GP-159)", () => {
  it("carries the tagline and the one-liner verbatim", () => {
    expectVerbatim("index.html", "See your infrastructure. Review it. Shape it.");
    expectVerbatim(
      "index.html",
      "Groundplan turns Terraform and Kubernetes into living, interactive architecture diagrams — so teams review infrastructure changes visually, keep documentation permanently in sync with code, and see their cloud the way they think about it: as networks, permissions and systems, not thousands of lines of HCL.",
    );
  });

  it("carries the trust-model one-liner verbatim", () => {
    expectVerbatim(
      "index.html",
      "We ingest data, not access. Groundplan reads the plan JSON and rendered manifests your own CI produces. It never holds cloud credentials, never reads your Terraform state, never runs terraform, helm or kustomize. Adoption is one pipeline step.",
    );
  });

  it("names the four problems, one line each", () => {
    expectVerbatim(
      "index.html",
      "Infra review is text review — reviewers approve plans nobody can picture.",
    );
    expectVerbatim("index.html", "Architecture documentation is dead the day it's drawn.");
    expectVerbatim(
      "index.html",
      "The blast radius of a change is invisible until it detonates.",
    );
    expectVerbatim(
      "index.html",
      "Existing visualisers demand read access to your cloud or your state.",
    );
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

  it("points the primary CTA at the security story (playground not public yet)", () => {
    expect(pageText("index.html")).toContain("One pipeline step away from seeing your infrastructure.");
    expect(pageHtml("index.html")).toMatch(/href="\/security\/"/);
  });
});
