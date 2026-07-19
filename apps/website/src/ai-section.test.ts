// AI + Infrastructure Studio section (GP-162).
import { describe, it, expect } from "vitest";
import { pageHtml, expectVerbatim } from "./test-helpers.js";

function aiSection(): string {
  const html = pageHtml("index.html");
  const start = html.indexOf('<section id="ai"');
  expect(start).toBeGreaterThan(-1);
  return html.slice(start, html.indexOf("</section>", start));
}

describe("AI section (GP-162)", () => {
  it("carries the honest-AI positioning verbatim", () => {
    expectVerbatim(
      "index.html",
      "Groundplan's AI never replaces the deterministic view — it sits beside it. And it never reads your plan files: every generation is grounded in a brief rendered from Groundplan's own deterministic outputs. No API key configured? The AI layer doesn't exist — no surfaces, no calls, no surprises.",
    );
  });

  it("carries the Studio copy verbatim", () => {
    expectVerbatim(
      "index.html",
      "Describe the infrastructure you want in plain English; watch the Terraform being written and the architecture appear, node by node, on the canvas. Inspect any resource's generated HCL, get instant best-practice findings, and download the project as a zip — then run terraform plan yourself, because you stay in control.",
    );
  });

  it("labels Experimental and Azure-focused in the section itself", () => {
    const section = aiSection();
    expect(section).toContain("Experimental");
    expect(section).toContain("Azure-focused");
  });

  it("states the AI_API_KEY-unset rule explicitly", () => {
    const section = aiSection();
    expect(section).toContain("AI_API_KEY");
    expect(section).toContain("the AI layer doesn't exist");
  });

  it("shows the Studio screenshot with the Experimental badge in-shot", () => {
    expect(aiSection()).toContain("/images/studio.png");
    expect(aiSection()).toMatch(/alt="[^"]*Experimental badge[^"]*"/);
  });
});
