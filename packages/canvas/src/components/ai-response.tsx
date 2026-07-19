/**
 * Renders model-generated Markdown (GP-64).
 *
 * Distinct from `ChangeSummary`, which parses the tiny, known Markdown subset our
 * own rules emit. A model writes real Markdown — headings, links, nested lists,
 * emphasis — so this one uses a real parser. `react-markdown` builds React nodes
 * (no `dangerouslySetInnerHTML`) and, with no `rehype-raw`, raw HTML in the
 * model's output is inert text rather than markup: prose from a model is
 * untrusted input, and we render it as prose, never as HTML.
 *
 * Every element is mapped to a design token — the model's Markdown never gets to
 * pick a colour or a size.
 */
import Markdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";

import { cn } from "../lib/utils";

// Element overrides for the Markdown renderer. Defined at module scope (not
// inside the component) so they are stable across renders — every override reads
// only react-markdown's own props (`children`/`href`), never AiResponse's props.
const markdownComponents: Components = {
  p: ({ children }) => <p>{children}</p>,
  strong: ({ children }) => (
    <strong className="text-ink font-semibold">{children}</strong>
  ),
  em: ({ children }) => <em className="italic">{children}</em>,
  code: ({ children }) => (
    <code className="text-ink bg-accent-soft rounded-xs px-1 py-0.5 font-mono text-[11px]">
      {children}
    </code>
  ),
  // A model may reach for a heading even when asked for prose; keep it
  // in the rail's type scale rather than letting it shout.
  h1: ({ children }) => <p className="text-ink font-semibold">{children}</p>,
  h2: ({ children }) => <p className="text-ink font-semibold">{children}</p>,
  h3: ({ children }) => <p className="text-ink font-semibold">{children}</p>,
  ul: ({ children }) => (
    <ul className="marker:text-faint list-disc space-y-1 pl-4">{children}</ul>
  ),
  ol: ({ children }) => (
    <ol className="marker:text-faint list-decimal space-y-1 pl-4">{children}</ol>
  ),
  li: ({ children }) => <li className="pl-0.5">{children}</li>,
  a: ({ href, children }) => (
    <a
      href={href}
      target="_blank"
      rel="noreferrer noopener"
      className="text-primary underline underline-offset-2"
    >
      {children}
    </a>
  ),
  blockquote: ({ children }) => (
    <blockquote className="border-border text-faint border-l-2 pl-3 italic">
      {children}
    </blockquote>
  ),
  pre: ({ children }) => (
    <pre className="bg-panel border-border overflow-x-auto rounded-sm border p-2 font-mono text-[11px]">
      {children}
    </pre>
  ),
};

export function AiResponse({
  markdown,
  className,
}: Readonly<{
  markdown: string;
  className?: string;
}>) {
  return (
    <div
      className={cn(
        "text-muted-foreground space-y-2 text-xs leading-relaxed break-words",
        className,
      )}
    >
      <Markdown
        remarkPlugins={[remarkGfm]}
        components={markdownComponents}
      >
        {markdown}
      </Markdown>
    </div>
  );
}
