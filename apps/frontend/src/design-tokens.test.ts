/**
 * GP-28 acceptance guard: no hardcoded colours in the design-v3 component
 * surface. Every colour must flow from a token declared in `index.css` — no hex
 * literals, no raw Tailwind palette classes (`bg-emerald-500`, `text-violet-600`
 * …). This is the "grep check in CI" the ticket asks for; it runs with the suite.
 *
 * Scope is the token-governed set below (the primitives + the diagram surface).
 * Widening it to the whole app (connection status, PR-state chips, sidebar) is
 * tracked as follow-up; those aren't part of the design-v3 epic.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

/** Hex colour literal, e.g. #2e6be6 / #fff. */
const HEX = /#[0-9a-fA-F]{3,8}\b/;

/** A raw Tailwind palette utility, e.g. `bg-emerald-500`, `text-rose-600/40`. */
const PALETTE =
  /\b(?:bg|text|border|outline|ring|fill|stroke|from|to|via|decoration|accent|caret|divide|shadow)-(?:slate|gray|zinc|neutral|stone|red|orange|amber|yellow|lime|green|emerald|teal|cyan|sky|blue|indigo|violet|purple|fuchsia|pink|rose)-\d{2,3}\b/;

const GOVERNED = [
  "components/ui/chip.tsx",
  "components/ui/status-badge.tsx",
  "components/ui/side-panel.tsx",
  "components/change-chips.tsx",
  "components/node-details-panel.tsx",
  "lib/status.ts",
  "lib/graph-layout.ts",
  "lib/resource-category.ts",
];

// Vitest runs from the frontend package dir; sources live under ./src.
const SRC_DIR = resolve(process.cwd(), "src");
const read = (rel: string): string =>
  readFileSync(resolve(SRC_DIR, rel), "utf8");

describe("design tokens (GP-28)", () => {
  it("design-v3 components carry no hardcoded colours", () => {
    const violations: string[] = [];
    for (const rel of GOVERNED) {
      const src = read(rel);
      const hex = HEX.exec(src);
      if (hex) violations.push(`${rel}: hex literal ${hex[0]}`);
      const palette = PALETTE.exec(src);
      if (palette) violations.push(`${rel}: raw palette class ${palette[0]}`);
    }
    expect(violations, violations.join("\n")).toEqual([]);
  });

  it("index.css declares the mockup status + surface tokens", () => {
    const css = read("index.css");
    for (const token of [
      "--create",
      "--create-soft",
      "--update",
      "--delete",
      "--impacted",
      "--impacted-soft",
      "--canvas",
      "--faint",
      "--edge",
      "--grid-strong",
    ]) {
      expect(css, `index.css must declare ${token}`).toContain(`${token}:`);
    }
  });
});
