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
      "Helm and Kustomize output is rendered by your CI and pushed to Groundplan — we never execute them.",
    );
    expectVerbatim(
      "index.html",
      "Live clusters are read-only: kubeconfigs encrypted at rest, and Secret values are never fetched, stored or drawn.",
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

  it("replaces the support matrix with stack chips — key claims intact", () => {
    const dev = section("developers");
    expect(dev).not.toContain("<table");
    const text = pageText("index.html");
    for (const item of [
      "Terraform",
      "Kubernetes manifests",
      "Helm & Kustomize (via your CI)",
      "GitHub",
      "GitLab",
      "Azure DevOps",
      "GitHub Actions",
      "GitLab CI",
      "Azure Pipelines",
      "Any OIDC provider",
      "Keycloak in the box",
      "VS Code",
    ]) {
      expect(text).toContain(item);
    }
  });
});
