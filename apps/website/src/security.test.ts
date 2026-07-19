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
      "One organisation can never see — or even probe for — another's data; a cross-tenant request reveals nothing, not even that something exists",
      "The AI is contained",
      "Off by default; the model sees only briefs built from Groundplan's own outputs, never your files; its output is treated as untrusted",
      "Kubernetes reads are minimal",
      "LIST-only client; Secret values never fetched, stored or diffed",
      "Public sharing is bounded",
      "Tokenized, revocable, rate-limited (240/min/IP), AI content excluded",
      "The supply chain is checked",
      "Release images are Trivy-scanned in CI; fixable CRITICAL CVEs block the release",
      "Hard boundaries elsewhere",
      "File reads can never escape the repository; only https repository URLs are accepted; uploads are capped at 10 MB",
    ]) {
      expectVerbatim(PAGE, cell);
    }
  });

  it("carries the AI-containment facts in customer language", () => {
    expectVerbatim(
      PAGE,
      "AI is off by default. Without an AI key configured, the AI layer doesn't exist — no buttons, no background calls, nothing.",
    );
    // Config internals stay out of customer-facing copy.
    expect(pageText(PAGE)).not.toContain("AI_API_KEY");
    expectVerbatim(
      PAGE,
      "The model never sees raw plan JSON or HCL from your repos — only a deterministic Markdown brief built from Groundplan's own outputs.",
    );
    expectVerbatim(
      PAGE,
      "Model output is treated as untrusted input: rendered as Markdown (never HTML), hallucinated anchors dropped, non-JSON responses rejected and never cached.",
    );
  });

  it("stays the objection-killer: in the nav, the hero CTA and the closing CTA", () => {
    const html = pageHtml("index.html");
    const nav = html.match(/<nav aria-label="Main"[\s\S]*?<\/nav>/)?.[0] ?? "";
    expect(nav).toContain('href="/security/"');
    // The hero's secondary CTA and the closing CTA both open the security story.
    expect((html.match(/href="\/security\/"/g) ?? []).length).toBeGreaterThanOrEqual(3);
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
