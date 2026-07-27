import { readFileSync, readdirSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

/** The built site. Every test reads the real output, never the source. */
export const DIST = fileURLToPath(new URL("../dist", import.meta.url));

/** The Markdown sources, for the tests that are about authoring rather than output. */
export const CONTENT = fileURLToPath(
  new URL("../src/content/docs", import.meta.url),
);

/** The repository root, so tests can read the code the docs describe. */
export const REPO_ROOT = fileURLToPath(new URL("../../..", import.meta.url));

function walk(dir: string, match: (f: string) => boolean): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(full, match));
    else if (match(entry.name)) out.push(full);
  }
  return out;
}

export type Page = {
  /** Route-ish id, e.g. `use/lenses` (the `index.html` is stripped). */
  readonly id: string;
  /** Path relative to `dist`, e.g. `use/lenses/index.html`. */
  readonly file: string;
  readonly html: string;
};

let cached: Page[] | undefined;

/** Every built HTML page, read once. */
export function pages(): Page[] {
  if (!cached) {
    cached = walk(DIST, (f) => f.endsWith(".html")).map((full) => {
      const file = relative(DIST, full);
      return {
        id: file.replace(/(^|\/)index\.html$/, "").replace(/\.html$/, "") || "/",
        file,
        html: readFileSync(full, "utf8"),
      };
    });
  }
  return cached;
}

/** A single page by its route id, e.g. `pageById("use/lenses")`. */
export function pageById(id: string): Page {
  const found = pages().find((p) => p.id === id);
  if (!found) {
    throw new Error(
      `No built page "${id}". Built: ${pages()
        .map((p) => p.id)
        .join(", ")}`,
    );
  }
  return found;
}

/**
 * The visible text of a page — markup and inline scripts stripped. Content
 * assertions run on this: `<meta>` and `class="…"` are not what a reader reads,
 * and matching raw HTML makes every test brittle to a class rename.
 */
export function text(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/g, " ")
    .replace(/<style[\s\S]*?<\/style>/g, " ")
    .replace(/<head[\s\S]*?<\/head>/g, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&#(\d+);/g, (_, code: string) =>
      String.fromCodePoint(Number(code)),
    )
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#x27;|&apos;/g, "'")
    .replace(/&nbsp;/g, " ")
    .replace(/\s+/g, " ");
}

/**
 * The visible text of the page's own content, without the site chrome.
 *
 * Every claim rule has to run on this rather than on the whole document: the
 * sidebar names every page on every page, so "this page mentions the AI Studio"
 * would otherwise be true everywhere and the caveat rules would be unusable.
 */
export function mainText(html: string): string {
  const start = html.indexOf("<main");
  const end = html.lastIndexOf("</main>");
  const main = start === -1 || end === -1 ? html : html.slice(start, end);
  // The previous/next footer names two neighbouring pages, which is navigation
  // rather than a claim this page makes.
  const footer = main.indexOf("<footer");
  return text(footer === -1 ? main : main.slice(0, footer));
}

/** Every Markdown/MDX source file, with its path relative to the content root. */
export function sources(): { file: string; body: string }[] {
  return walk(CONTENT, (f) => f.endsWith(".md") || f.endsWith(".mdx")).map(
    (full) => ({
      file: relative(CONTENT, full),
      body: readFileSync(full, "utf8"),
    }),
  );
}

/** Read a file from the repository, so a doc can be checked against the code. */
export function repoFile(path: string): string {
  return readFileSync(join(REPO_ROOT, path), "utf8");
}
