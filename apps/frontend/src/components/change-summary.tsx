/**
 * Renders the deterministic change summary (GP-36) that the backend stores on
 * each snapshot as `summaryMd`. The summary uses a tiny, known Markdown subset
 * — `**bold**`, `` `code` ``, `- ` list items, blank-line-separated blocks — so
 * we render it with a small purpose-built parser rather than pulling in a full
 * Markdown dependency. No `dangerouslySetInnerHTML`: everything is React nodes.
 */
import type { ReactNode } from "react";

import { cn } from "@/lib/utils";

/** Split a line into bold / mono-code / plain runs (non-nesting, left to right). */
function inline(text: string, keyPrefix: string): ReactNode[] {
  const nodes: ReactNode[] = [];
  const pattern = /\*\*(.+?)\*\*|`(.+?)`/g;
  let last = 0;
  let match: RegExpExecArray | null;
  let i = 0;
  while ((match = pattern.exec(text)) !== null) {
    if (match.index > last) nodes.push(text.slice(last, match.index));
    if (match[1] !== undefined) {
      nodes.push(
        <strong key={`${keyPrefix}-b${i}`} className="text-ink font-semibold">
          {match[1]}
        </strong>,
      );
    } else if (match[2] !== undefined) {
      nodes.push(
        <code key={`${keyPrefix}-c${i}`} className="text-ink font-mono text-[11px]">
          {match[2]}
        </code>,
      );
    }
    last = pattern.lastIndex;
    i += 1;
  }
  if (last < text.length) nodes.push(text.slice(last));
  return nodes;
}

/** Render the limited-Markdown summary as headings, list items and paragraphs. */
export function ChangeSummary({
  markdown,
  className,
}: {
  markdown: string;
  className?: string;
}) {
  const lines = markdown.split("\n");
  return (
    <div className={cn("text-muted-foreground space-y-1 text-xs leading-relaxed", className)}>
      {lines.map((line, idx) => {
        const key = `${idx}:${line}`;
        if (line.trim() === "") return <div key={key} className="h-1.5" aria-hidden />;
        // A line that is entirely a bold run is a heading (headline / section).
        const heading = /^\*\*.+\*\*(\s*\(.+\))?$/.test(line) && !line.startsWith("- ");
        if (line.startsWith("- ")) {
          return (
            <div key={key} className="flex gap-1.5 pl-1">
              <span className="text-faint select-none" aria-hidden>
                •
              </span>
              <span className="min-w-0">{inline(line.slice(2), `l${idx}`)}</span>
            </div>
          );
        }
        return (
          <p key={key} className={cn(heading ? "text-ink" : undefined)}>
            {inline(line, `p${idx}`)}
          </p>
        );
      })}
    </div>
  );
}

/** A collapsible "Change summary" panel — used at the top of the PR view. */
export function ChangeSummaryPanel({ markdown }: { markdown: string }) {
  if (!markdown || markdown === "No changes.") {
    return (
      <p className="text-muted-foreground mt-3 text-sm">
        No infrastructure changes in this plan.
      </p>
    );
  }
  return (
    <details open className="group mt-3">
      <summary className="text-muted-foreground hover:text-foreground marker:text-faint inline-flex cursor-pointer items-center gap-1 text-xs font-medium">
        <span className="font-mono tracking-wide uppercase">Change summary</span>
      </summary>
      <div className="mt-2 max-w-3xl rounded-md border border-border bg-card/60 px-4 py-3">
        <ChangeSummary markdown={markdown} />
      </div>
    </details>
  );
}
