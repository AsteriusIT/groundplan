import { expect, it } from "vitest";

import { edgeOpacity } from "./graph-edge";

it("a ghosted edge recedes to background opacity in diff mode (GP-155)", () => {
  expect(edgeOpacity({ ghosted: true }, "neutral")).toBeCloseTo(0.18);
});

it("focus and dimming outrank ghosting", () => {
  // The lit relationship draws fully even between bystanders…
  expect(edgeOpacity({ ghosted: true, active: true }, "neutral")).toBe(1);
  // …and the out-of-neighbourhood dim is stronger than the ghost tier.
  expect(edgeOpacity({ ghosted: true, dimmed: true }, "neutral")).toBeCloseTo(0.06);
});

it("without ghosting the resting opacities are unchanged", () => {
  expect(edgeOpacity({}, "neutral")).toBeCloseTo(0.35);
  expect(edgeOpacity({}, "impact")).toBeCloseTo(0.9);
});
