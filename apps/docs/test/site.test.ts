import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { SIDEBAR } from "../src/sidebar.js";
import { DIST, pages, sources, text } from "./helpers.js";

/** Every CSS the build emitted, concatenated — the identity lives in there. */
function builtCss(): string {
  const dir = join(DIST, "_astro");
  return readdirSync(dir)
    .filter((f) => f.endsWith(".css"))
    .map((f) => readFileSync(join(dir, f), "utf8"))
    .join("\n");
}

/** Flatten the declared sidebar into the links it promises. */
function sidebarLinks(): { label: string; link: string }[] {
  const out: { label: string; link: string }[] = [];
  for (const group of SIDEBAR ?? []) {
    if (typeof group === "string" || !("items" in group)) continue;
    for (const item of group.items) {
      if (typeof item === "object" && "link" in item && item.link) {
        out.push({ label: String(item.label), link: item.link });
      }
    }
  }
  return out;
}

describe("scaffold (GP-213)", () => {
  it("renders with the product fonts and the carbon palette", () => {
    const css = builtCss();
    for (const token of [
      "Space Grotesk",
      "Inter Variable",
      "IBM Plex Mono",
      "#0c0d10", // --background
      "#4c8dff", // --primary
    ]) {
      expect(css).toContain(token);
    }
  });

  it("stays out of every index until the trademark gate clears (GP-166)", () => {
    for (const page of pages()) {
      expect(page.html, page.file).toContain(
        'name="robots" content="noindex, nofollow"',
      );
    }
    expect(readFileSync(join(DIST, "robots.txt"), "utf8")).toContain("Disallow: /");
  });

  it("declares a language and a title on every page", () => {
    for (const page of pages()) {
      expect(page.html, page.file).toContain('<html lang="en"');
      expect(page.html, page.file).toMatch(/<title>[^<]+<\/title>/);
    }
  });

  it("ships the client-side search index", () => {
    expect(existsSync(join(DIST, "pagefind", "pagefind.js"))).toBe(true);
  });

  it("builds every page the sidebar promises", () => {
    const built = new Set(pages().map((p) => `/${p.id === "/" ? "" : `${p.id}/`}`));
    const missing = sidebarLinks()
      .map((l) => l.link)
      .filter((link) => !built.has(link));
    expect(missing).toEqual([]);
  });

  it("puts every page in the sidebar", () => {
    // A page nobody can navigate to is a page nobody reads. 404 is Starlight's.
    const promised = new Set(
      sidebarLinks().map((l) => l.link.replace(/^\/|\/$/g, "")),
    );
    const orphans = pages()
      .map((p) => (p.id === "/" ? "" : p.id))
      .filter((id) => id !== "404" && !promised.has(id));
    expect(orphans).toEqual([]);
  });
});

describe("editorial rules (GP-214)", () => {
  it("gives every page a title and a description", () => {
    for (const { file, body } of sources()) {
      const frontmatter = body.split(/^---$/m)[1] ?? "";
      expect(frontmatter, file).toMatch(/^title: .+$/m);
      expect(frontmatter, file).toMatch(/^description: .+$/m);
    }
  });

  it("opens every page with a sentence saying who it is for", () => {
    // The first paragraph, not a heading and not a component: a reader who
    // landed from search decides in one line whether this page is theirs.
    for (const { file, body } of sources()) {
      const afterFrontmatter = body.split(/^---$/m)[2] ?? "";
      const firstLine = afterFrontmatter
        .split("\n")
        .map((l) => l.trim())
        .filter((l) => l !== "" && !l.startsWith("import ") && !l.startsWith("#"))
        .at(0);
      expect(firstLine ?? "", file).not.toBe("");
      expect((firstLine ?? "").length, file).toBeGreaterThan(40);
    }
  });
});

describe("links", () => {
  /**
   * Dead-link check, internal half (GP-213). Runs offline against the built
   * file tree, so it is deterministic and cannot be flaky; the external half is
   * lychee in `.github/workflows/docs.yml`, where the network lives.
   */
  it("has no dead internal link", () => {
    const broken: string[] = [];
    for (const page of pages()) {
      const hrefs = [...page.html.matchAll(/href="([^"]+)"/g)].map((m) => m[1]!);
      for (const href of hrefs) {
        if (!href.startsWith("/") || href.startsWith("//")) continue;
        const [path] = href.split("#");
        const clean = (path ?? "").replace(/^\/|\/$/g, "");
        const candidates = [
          join(DIST, clean),
          join(DIST, `${clean}.html`),
          join(DIST, clean, "index.html"),
        ];
        if (!candidates.some(existsSync)) broken.push(`${page.file} → ${href}`);
      }
    }
    expect(broken).toEqual([]);
  });

  it("links out over https only", () => {
    const insecure: string[] = [];
    for (const page of pages()) {
      for (const m of page.html.matchAll(/href="(http:\/\/[^"]+)"/g)) {
        // Example hosts inside code samples are illustrative, not links.
        if (!m[1]!.includes("localhost") && !m[1]!.includes("example"))
          insecure.push(`${page.file} → ${m[1]}`);
      }
    }
    expect(insecure).toEqual([]);
  });
});

describe("product name (GP-166)", () => {
  it("leaves no unsubstituted placeholder in the output", () => {
    for (const page of pages()) {
      expect(text(page.html), page.file).not.toContain("%PRODUCT%");
    }
  });
});
