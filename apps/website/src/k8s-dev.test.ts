// Kubernetes, how-it-works, developer experience & stack chips — commercial
// pass. The security-critical claims survive rewording; the CLI snippet and
// its copy button move to the adoption path (how-it-works).
import { describe, it, expect } from "vitest";
import { pageHtml, pageText, expectVerbatim } from "./test-helpers.js";

function section(id: string): string {
  const html = pageHtml("index.html");
  const start = html.indexOf(`<section id="${id}"`);
  expect(start).toBeGreaterThan(-1);
  return html.slice(start, html.indexOf("</section>", start));
}

describe("how it works", () => {
  it("walks three verb-led steps", () => {
    const text = pageText("index.html");
    for (const step of [
      "Add one line to your CI",
      "Open a pull request",
      "Merge — the docs update themselves",
    ]) {
      expect(text).toContain(step);
    }
  });

  it("shows the one-line CLI snippet with a copy button", () => {
    const how = section("how");
    expect(how).toContain("npx @asteriusit/cli push-plan --file plan.json");
    expect(how).toContain('id="copy-cli"');
  });
});

describe("Kubernetes section", () => {
  it("keeps the never-execute and read-only-cluster claims", () => {
    expectVerbatim(
      "index.html",
      "Helm and Kustomize rendered by your CI — never executed by us.",
    );
    expectVerbatim(
      "index.html",
      "Clusters read-only; Secret values never fetched, stored or drawn.",
    );
  });

  it("states the honest scope in the section itself", () => {
    expectVerbatim(
      "index.html",
      "Kubernetes snapshots get the diagram and its deterministic summary today",
    );
  });
});

describe("developer experience", () => {
  it("describes the three ways in by where they live", () => {
    const dev = section("developers");
    for (const label of ["In your pipeline", "In your editor", "In your browser"]) {
      expect(dev).toContain(label);
    }
    const text = pageText("index.html");
    for (const name of ["The CLI", "The VS Code extension", "The Playground"]) {
      expect(text).toContain(name);
    }
  });

  it("keeps the VS Code honesty: offline, and stated limits", () => {
    expectVerbatim(
      "index.html",
      "Fully offline: no account, no telemetry, nothing ever leaves your machine.",
    );
    expectVerbatim(
      "index.html",
      "Honest limits: first workspace folder only, and not yet tuned for 500+ resource repos.",
    );
  });
});

describe("stack belt", () => {
  function belt(): string {
    const html = pageHtml("index.html");
    const start = html.indexOf('aria-label="Works with your stack"');
    expect(start).toBeGreaterThan(-1);
    return html.slice(start, html.indexOf("</section>", start));
  }

  it("shows every stack item as an official mark with its name", () => {
    const strip = belt();
    for (const label of [
      "Terraform",
      "Kubernetes",
      "Helm",
      "GitHub",
      "GitLab",
      "Azure DevOps",
      "GitHub Actions",
      "VS Code",
      "Azure",
      "AWS",
      "Google Cloud",
      "OpenID Connect",
    ]) {
      expect(strip).toContain(label);
    }
    // One inline SVG mark per item, per track (real content + aria-hidden dup).
    expect((strip.match(/<svg/g) ?? []).length).toBeGreaterThanOrEqual(12);
    expect(strip).toContain('aria-hidden="true"');
  });

  it("keeps the old support-matrix table gone", () => {
    expect(section("developers")).not.toContain("<table");
  });
});
