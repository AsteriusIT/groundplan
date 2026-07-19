// Security & trust page (GP-161): §8 table as-is, §4 AI-containment facts,
// nav position 2, nothing from the §13 forbidden list.
import { describe, it, expect } from "vitest";
import { pageHtml, pageText, expectVerbatim } from "./test-helpers.js";

const PAGE = "security/index.html";

describe("security page (GP-161)", () => {
  it("leads with the §8 headline", () => {
    expectVerbatim(PAGE, "Your cloud credentials never leave your cloud");
  });

  it("renders every §8 claim → proof row", () => {
    for (const cell of [
      "We ingest data, not access",
      "no cloud SDK credentials, no state backends, no terraform/helm/kustomize execution anywhere in the codebase",
      "Secrets are write-only",
      "encrypted at rest (AES-256-GCM), masked as *** in every response, never logged — clone URLs are token-redacted in errors",
      "Tokens compared safely",
      "constant-time comparison; invite tokens stored as SHA-256 hashes",
      "Tenants are isolated",
      "Org-scope guard returns 404 (never 403) across tenants — no existence leaks",
      "The AI is contained",
      "Key = flag, off by default; model sees deterministic briefs only; output treated as untrusted; failures never cached",
      "Kubernetes reads are minimal",
      "LIST-only client; Secret values never fetched, stored or diffed",
      "Public sharing is bounded",
      "Tokenized, revocable, rate-limited (240/min/IP), AI content excluded",
      "The supply chain is checked",
      "Release images are Trivy-scanned in CI; fixable CRITICAL CVEs block the release",
      "Hard boundaries elsewhere",
      "Path traversal blocked on file reads; https-only repo URLs; 10 MB ingestion cap; per-target generation locks",
    ]) {
      expectVerbatim(PAGE, cell);
    }
  });

  it("carries the §4 AI-containment facts", () => {
    expectVerbatim(PAGE, "AI_API_KEY is the feature flag");
    expectVerbatim(
      PAGE,
      "The model never sees raw plan JSON or HCL from your repos — only a deterministic Markdown brief built from Groundplan's own outputs.",
    );
    expectVerbatim(
      PAGE,
      "Model output is treated as untrusted input: rendered as Markdown (never HTML), hallucinated anchors dropped, non-JSON responses rejected and never cached.",
    );
  });

  it("sits in nav position 2", () => {
    const nav = pageHtml("index.html").match(/<nav aria-label="Main">[\s\S]*?<\/nav>/)?.[0] ?? "";
    const links = [...nav.matchAll(/href="([^"]+)"/g)].map((m) => m[1]);
    expect(links[1]).toBe("/security/");
  });

  it("claims nothing from the §13 forbidden list", () => {
    const text = pageText(PAGE);
    for (const forbidden of [
      /cost estimation/i,
      /SOC ?2/i,
      /ISO ?27001/i,
      /HIPAA/i,
      /whitepaper/i,
    ]) {
      expect(text).not.toMatch(forbidden);
    }
  });
});
