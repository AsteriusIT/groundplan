/**
 * Markdown → Confluence storage format (GP-180). Deliberately minimal: it
 * covers exactly what our deterministic summary builders emit — headings,
 * (nested) unordered lists, bold, inline code, links, paragraphs — and nothing
 * more. No general-purpose Markdown engine: what we did not write, we do not
 * convert, so the output stays predictable.
 *
 * Storage format is XHTML, so every piece of text is escaped on the way in —
 * the summary quotes user-authored context and annotations, which are data,
 * never markup.
 */

/** The one attachment filename — updating it in place is what "no duplicate
 * attachments" means (Confluence versions attachments by filename). */
export const DIAGRAM_FILENAME = "diagram.png";

function escapeXml(text: string): string {
  return text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

/**
 * Inline constructs: code spans first (they are opaque — nothing inside a
 * backtick pair is markup), then bold, then links, all on escaped text.
 */
function inline(text: string): string {
  return text
    .split(/(`[^`]*`)/)
    .map((part) => {
      if (part.length >= 2 && part.startsWith("`") && part.endsWith("`")) {
        return `<code>${escapeXml(part.slice(1, -1))}</code>`;
      }
      return escapeXml(part)
        .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
        .replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, '<a href="$2">$1</a>');
    })
    .join("");
}

type ListItem = { depth: number; text: string };

/** Nested `<ul>` from a run of `- ` items (2 spaces of indent = one level). */
function renderList(items: ListItem[]): string {
  let pos = 0;
  function build(depth: number): string {
    let html = "<ul>";
    while (pos < items.length && items[pos]!.depth >= depth) {
      const item = items[pos]!;
      pos += 1;
      let body = inline(item.text);
      if (pos < items.length && items[pos]!.depth > depth) {
        body += build(depth + 1);
      }
      html += `<li>${body}</li>`;
    }
    return `${html}</ul>`;
  }
  return build(items[0]?.depth ?? 0);
}

export function markdownToStorage(markdown: string): string {
  const lines = markdown.split("\n");
  const blocks: string[] = [];
  let paragraph: string[] = [];

  const flushParagraph = () => {
    if (paragraph.length > 0) {
      blocks.push(`<p>${inline(paragraph.join(" "))}</p>`);
      paragraph = [];
    }
  };

  let i = 0;
  while (i < lines.length) {
    const line = lines[i]!;
    const heading = /^(#{1,6})\s+(.*)$/.exec(line);
    if (line.trim() === "") {
      flushParagraph();
      i += 1;
    } else if (heading) {
      flushParagraph();
      const level = heading[1]!.length;
      blocks.push(`<h${level}>${inline(heading[2]!)}</h${level}>`);
      i += 1;
    } else if (/^\s*-\s+/.test(line)) {
      flushParagraph();
      const items: ListItem[] = [];
      while (i < lines.length) {
        const item = /^(\s*)-\s+(.*)$/.exec(lines[i]!);
        if (!item) break;
        items.push({ depth: Math.floor(item[1]!.length / 2), text: item[2]! });
        i += 1;
      }
      blocks.push(renderList(items));
    } else {
      paragraph.push(line.trim());
      i += 1;
    }
  }
  flushParagraph();
  return blocks.join("\n");
}

export type DocsPageInput = {
  /** `owner/repo`, also the page title. */
  repoLabel: string;
  ref: string;
  commitSha: string;
  /** When the snapshot was generated (the snapshot's, not the publish's, clock). */
  generatedAt: Date;
  /** The deterministic docs summary, as Markdown. */
  summaryMd: string;
  /** Absolute Groundplan docs-page URL, or null when PUBLIC_BASE_URL is unset. */
  appUrl: string | null;
};

/**
 * The whole page body: header facts, the diagram (an attachment reference —
 * GP-180 uploads the PNG under `DIAGRAM_FILENAME`), the converted summary and
 * the link back to Groundplan. Deterministic given its input.
 */
export function docsPageStorage(input: DocsPageInput): string {
  const parts = [
    `<p><strong>${escapeXml(input.repoLabel)}</strong> · <code>${escapeXml(
      input.commitSha.slice(0, 8),
    )}</code> · <code>${escapeXml(input.ref)}</code> · ${escapeXml(
      input.generatedAt.toISOString().slice(0, 10),
    )}</p>`,
    `<ac:image ac:width="1200"><ri:attachment ri:filename="${DIAGRAM_FILENAME}" /></ac:image>`,
    markdownToStorage(input.summaryMd),
  ];
  if (input.appUrl) {
    parts.push(
      `<p><a href="${escapeXml(input.appUrl)}">View the interactive diagram in Groundplan</a></p>`,
    );
  }
  parts.push(
    "<p><em>Published by Groundplan. This page is regenerated on every publish — edits made here will be overwritten.</em></p>",
  );
  return parts.join("\n");
}
