/**
 * How much room the toolbar has. Measured on the panel, not the window: the
 * preview opens beside the editor and can be dragged to any width, so a media
 * query would answer a question nobody asked.
 */
import { describe, expect, test } from "vitest";

import { tierFor } from "./tier";

describe("tierFor", () => {
  test("a wide panel shows everything", () => {
    expect(tierFor(900)).toBe("wide");
    expect(tierFor(640)).toBe("wide");
  });

  test("a middling panel keeps the segments but compacts the rest", () => {
    expect(tierFor(639)).toBe("medium");
    expect(tierFor(480)).toBe("medium");
  });

  test("a narrow panel folds controls away rather than truncating them", () => {
    expect(tierFor(479)).toBe("narrow");
    expect(tierFor(360)).toBe("narrow");
  });

  test("an unmeasured panel is assumed wide", () => {
    // Before the first measurement there is no width. Guessing "narrow" would
    // collapse the toolbar for a frame on every open, which reads as a glitch.
    expect(tierFor(0)).toBe("wide");
  });
});
