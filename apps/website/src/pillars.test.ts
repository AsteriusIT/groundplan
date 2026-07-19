// Three pillars (GP-160): copy verbatim, every shown fact traces to a GP
// story number, screenshots are the real checked-in captures.
import { describe, it, expect } from "vitest";
import { pageHtml, pageText, expectVerbatim } from "./test-helpers.js";

describe("three pillars (GP-160)", () => {
  it("carries the See copy verbatim", () => {
    expectVerbatim(
      "index.html",
      "Open a PR, get a diagram. Groundplan parses the terraform plan JSON your CI already produces and draws the change: green for created, amber for updated, red (dashed, struck through) for destroyed — and violet for the resources you didn't touch but that depend on what you did. The unchanged estate is ghosted so the change dominates the canvas.",
    );
  });

  it("carries the Understand copy verbatim", () => {
    expectVerbatim(
      "index.html",
      "Merge to main and the documentation redraws itself. Groundplan statically parses your HCL — no plan, no apply needed — and keeps a versioned diagram of your default branch. Then look at the same estate through the lens that matches your question: the network, the permissions, the C4 big picture.",
    );
  });

  it("carries the Shape copy verbatim", () => {
    expectVerbatim(
      "index.html",
      "A generated diagram knows what exists; only your team knows what it means. Groundplan lets you group resources into systems, rename them in human language, hide the noise, draw the logical connections and pin notes — without ever editing the generated model. Your annotations survive regeneration: when a resource disappears, its annotations are flagged for review, never silently deleted.",
    );
  });

  it("shows one real screenshot per pillar", () => {
    const html = pageHtml("index.html");
    for (const img of ["pillar-see.png", "pillar-understand.png", "pillar-shape.png"]) {
      expect(html).toContain(`/images/${img}`);
    }
  });

  it("traces every fact to a GP story number", () => {
    const text = pageText("index.html");
    // Spot-check the load-bearing claims and their stories.
    for (const [claim, story] of [
      ["framing the true blast radius", "GP-22"],
      ["Deterministic change summary", "GP-36"],
      ["one idempotent comment per plan snapshot", "GP-38"],
      ["auto-regenerated on merge", "GP-15"],
      ["vnet ⊃ subnet ⊃ resource containment", "GP-42"],
      ["principal → role → scope table", "GP-47"],
      ["Server-rendered SVG/PNG export", "GP-37"],
      ["Five annotation types", "GP-56"],
      ["Orphan reconciliation", "GP-57"],
      ["review inbox, never on the canvas", "GP-75"],
    ] as const) {
      expect(text).toContain(claim);
      expect(text).toContain(story);
    }
  });
});
