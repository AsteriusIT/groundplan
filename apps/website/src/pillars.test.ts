// Product tour (commercial pass): See / Understand / Shape told as benefits.
// Real screenshots only; and the guard that makes the commercial register
// stick — no internal story numbers anywhere in public copy.
import { describe, it, expect } from "vitest";
import { pageHtml, pageText, expectVerbatim } from "./test-helpers.js";

describe("product tour", () => {
  it("keeps the internal changelog out of public copy — no GP story numbers", () => {
    expect(pageText("index.html")).not.toMatch(/GP-\d+/);
  });

  it("sells each stop of the tour with a benefit headline", () => {
    const text = pageText("index.html");
    for (const headline of [
      "Every pull request becomes a picture",
      "Documentation that keeps itself up to date",
      "Add the meaning only your team knows",
    ]) {
      expect(text).toContain(headline);
    }
  });

  it("explains the diff colours in the reader's terms", () => {
    expectVerbatim(
      "index.html",
      "Green for created, amber for changed, red for removed — and violet for the things you didn't touch that depend on what you did.",
    );
  });

  it("names the lenses as chips on the Understand stop", () => {
    const text = pageText("index.html");
    for (const lens of ["Network", "IAM", "C4", "History"]) expect(text).toContain(lens);
  });

  it("keeps the annotation-safety promise", () => {
    expectVerbatim(
      "index.html",
      "Annotations survive regeneration — never silently deleted.",
    );
  });

  it("shows one real screenshot per stop", () => {
    const html = pageHtml("index.html");
    for (const img of ["pillar-see.png", "pillar-understand.png", "pillar-shape.png"]) {
      expect(html).toContain(`/images/${img}`);
    }
  });

  it("walks the visitor in: how-it-works precedes the tour, security band follows it", () => {
    const html = pageHtml("index.html");
    const how = html.indexOf('<section id="how"');
    const product = html.indexOf('id="product"');
    const security = html.indexOf('<section id="security"');
    expect(how).toBeGreaterThan(-1);
    expect(product).toBeGreaterThan(how);
    expect(security).toBeGreaterThan(product);
  });

  it("carries the trust model as its own full-width moment", () => {
    expectVerbatim("index.html", "We ingest data, not access.");
    const text = pageText("index.html");
    for (const proof of ["No cloud credentials", "No state access", "Nothing executed"]) {
      expect(text).toContain(proof);
    }
  });
});
