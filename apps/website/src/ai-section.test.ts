// AI section — commercial pass. Honesty stays structural: Experimental and
// Azure-focused live in the section itself, the no-key-no-AI rule is stated
// in the body, and the screenshot shows the badge in-product.
import { describe, it, expect } from "vitest";
import { pageHtml, expectVerbatim } from "./test-helpers.js";

function aiSection(): string {
  const html = pageHtml("index.html");
  const start = html.indexOf('<section id="ai"');
  expect(start).toBeGreaterThan(-1);
  return html.slice(start, html.indexOf("</section>", start));
}

describe("AI section", () => {
  it("positions AI as optional prose beside a deterministic product", () => {
    expectVerbatim(
      "index.html",
      "Your diagrams are deterministic: same input, same picture, every time.",
    );
    expectVerbatim(
      "index.html",
      "Don't want AI? Don't configure it — without an API key, the AI layer simply doesn't exist.",
    );
  });

  it("never lets the AI read raw plan files — stated in the body", () => {
    expectVerbatim(
      "index.html",
      "it never reads your raw plan files: every generation is grounded in Groundplan's own deterministic outputs",
    );
  });

  it("labels Experimental and Azure-focused in the section itself", () => {
    const section = aiSection();
    expect(section).toContain("Experimental");
    expect(section).toContain("Azure-focused");
  });

  it("keeps the Studio promise in the user's hands", () => {
    expectVerbatim(
      "index.html",
      "Download the project as a zip and run the plan yourself. Nothing is deployed, nothing is stored.",
    );
  });

  it("shows the Studio screenshot with the Experimental badge in-shot", () => {
    expect(aiSection()).toContain("/images/studio.png");
    expect(aiSection()).toMatch(/alt="[^"]*Experimental badge[^"]*"/);
  });
});
