import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";

// Guard (mirrors the frontend's design-tokens.test.ts): components must use the
// semantic carbon tokens, never a hardcoded colour. `index.css` is the single
// source of colour truth and is a .css file, so it is naturally excluded — this
// only scans the .ts/.tsx that make up the theme.

const srcDir = join(dirname(fileURLToPath(import.meta.url)));

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...walk(full));
    } else if (/\.tsx?$/.test(entry.name)) {
      out.push(full);
    }
  }
  return out;
}

const IGNORED = new Set(["kc.gen.tsx", "vite-env.d.ts"]);

const files = walk(srcDir).filter((f) => {
  const base = f.split("/").pop() ?? "";
  return !IGNORED.has(base) && !/\.test\.tsx?$/.test(base);
});

// Raw Tailwind palette utilities (bg-emerald-500, text-red-600, …). The theme
// uses semantic utilities (bg-create, text-delete, …) instead.
const RAW_PALETTE =
  /\b(?:bg|text|border|ring|fill|stroke|from|to|via)-(?:slate|gray|zinc|neutral|stone|red|orange|amber|yellow|lime|green|emerald|teal|cyan|sky|blue|indigo|violet|purple|fuchsia|pink|rose)-\d{2,3}\b/;

const HEX = /#[0-9a-fA-F]{3,8}\b/;

describe("design tokens", () => {
  it("no component hardcodes a hex colour", () => {
    const offenders: string[] = [];
    for (const file of files) {
      const text = readFileSync(file, "utf8");
      if (HEX.test(text)) offenders.push(file.replace(srcDir, "src"));
    }
    expect(offenders, `hardcoded hex in: ${offenders.join(", ")}`).toEqual([]);
  });

  it("no component uses a raw Tailwind palette colour", () => {
    const offenders: string[] = [];
    for (const file of files) {
      const text = readFileSync(file, "utf8");
      if (RAW_PALETTE.test(text)) offenders.push(file.replace(srcDir, "src"));
    }
    expect(offenders, `raw palette utility in: ${offenders.join(", ")}`).toEqual(
      [],
    );
  });

  it("index.css pins the carbon palette (background + primary)", () => {
    const css = readFileSync(join(srcDir, "index.css"), "utf8");
    expect(css).toContain("#0c0d10"); // carbon background
    expect(css).toContain("#4c8dff"); // carbon primary (blue)
  });
});
