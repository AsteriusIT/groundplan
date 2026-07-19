// Kubernetes + developer experience + integration matrix (GP-163).
import { describe, it, expect } from "vitest";
import { pageHtml, pageText, expectVerbatim } from "./test-helpers.js";

function section(id: string): string {
  const html = pageHtml("index.html");
  const start = html.indexOf(`<section id="${id}"`);
  expect(start).toBeGreaterThan(-1);
  return html.slice(start, html.indexOf("</section>", start));
}

describe("Kubernetes + DX sections (GP-163)", () => {
  it("carries the §5 Kubernetes copy verbatim", () => {
    expectVerbatim(
      "index.html",
      "The same review-and-document loop, for Kubernetes. Point Groundplan at a manifests repo and it documents main and reviews PRs by structural diff — no plan file needed. Attach a live cluster (read-only) and draw any namespace on demand.",
    );
  });

  it("states read-only clusters and never-fetched Secret values", () => {
    expectVerbatim(
      "index.html",
      "Live clusters are read-only: kubeconfig encrypted at rest (same rules as PATs), LIST-only API usage, Secret values are never fetched, stored or drawn — even when a manifest hands them over in the clear.",
    );
  });

  it("does not promise annotations/AI/tours/share links on K8s repos", () => {
    expectVerbatim(
      "index.html",
      "deliberately no annotations, AI, tours or share links on Kubernetes repos today",
    );
  });

  it("shows the one-line CLI snippet with a copy button", () => {
    const dev = section("developers");
    expect(dev).toContain("npx @asteriusit/cli push-plan --file plan.json");
    expect(dev).toContain('id="copy-cli"');
  });

  it("carries the §6 CLI and VS Code copy verbatim", () => {
    expectVerbatim(
      "index.html",
      "It detects your branch, SHA and PR number on GitHub Actions, GitLab CI and Azure DevOps, validates the plan locally before any network call, retries transient failures, and fails your CI step loudly when something's wrong.",
    );
    expectVerbatim(
      "index.html",
      "See your Terraform as a live architecture diagram beside your editor, while you type. A new resource block appears in the diagram about a second after you pause — before you even save. Click a node to jump to its HCL; put your cursor in a block to light up its node. Toggle diff mode to see your working tree against git HEAD or your branch's merge-base. Fully offline: no account, no cloud calls, no telemetry — nothing is ever uploaded anywhere.",
    );
  });

  it("states the VS Code limits verbatim per §13", () => {
    expectVerbatim(
      "index.html",
      "first workspace folder only, not tuned for 500+ resource repos, no Helm/plan rendering in-editor",
    );
  });

  it("renders the §11 matrix exactly — all eight rows, no additions", () => {
    const dev = section("developers");
    const tbody = dev.slice(dev.indexOf("<tbody"), dev.indexOf("</tbody>"));
    const rows = tbody.match(/<tr/g) ?? [];
    expect(rows.length).toBe(8);
    const text = pageText("index.html");
    for (const dimension of [
      "IaC",
      "Git hosting",
      "PR comments",
      "CI context auto-detection (CLI)",
      "Icons / visual taxonomy",
      "Identity",
      "IDE",
      "Live infrastructure",
    ]) {
      expect(text).toContain(dimension);
    }
    expectVerbatim(
      "index.html",
      "Terraform (any provider parses; deepest semantics on Azure), Kubernetes manifests (raw YAML; Helm/Kustomize via CI-rendered output)",
    );
    expectVerbatim("index.html", "Any OIDC provider (Keycloak bundled & themed)");
  });
});
