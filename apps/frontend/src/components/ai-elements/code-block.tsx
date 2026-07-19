import { useEffect, useRef } from "react";

import { CopyButton } from "@/components/copy-button";
import { tokenizeHcl, type CodeTokenKind } from "@/lib/hcl-highlight";
import { cn } from "@/lib/utils";

/** Same four-role palette as every other code surface (GP-121). */
const TOKEN_CLASS: Record<Exclude<CodeTokenKind, "plain">, string> = {
  comment: "text-code-comment italic",
  string: "text-code-string",
  number: "text-code-number",
  keyword: "text-code-keyword",
};

/** `code` split into lines, each line a list of highlighted tokens. */
function tokenizedLines(code: string) {
  const lines: { kind: CodeTokenKind; text: string }[][] = [[]];
  for (const token of tokenizeHcl(code)) {
    const parts = token.text.split("\n");
    parts.forEach((part, i) => {
      if (i > 0) lines.push([]);
      if (part) lines[lines.length - 1]!.push({ kind: token.kind, text: part });
    });
  }
  return lines;
}

/**
 * Read-only HCL viewer (GP-140/GP-143): line numbers, the shared four-role
 * highlighting, a copy button, and an optional highlighted line range the
 * view scrolls to — which is all the node→code jump needs.
 */
export function CodeBlock({
  code,
  showLineNumbers = true,
  highlightRange = null,
  className,
}: Readonly<{
  code: string;
  showLineNumbers?: boolean;
  /** 1-based inclusive lines to mark and scroll into view (a node's block). */
  highlightRange?: { start: number; end: number } | null;
  className?: string;
}>) {
  const lines = tokenizedLines(code);
  const firstMarkedRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    firstMarkedRef.current?.scrollIntoView({ block: "center" });
  }, [highlightRange, code]);

  const marked = (lineNo: number) =>
    highlightRange !== null &&
    lineNo >= highlightRange.start &&
    lineNo <= highlightRange.end;

  return (
    <div className={cn("bg-card relative min-h-0 overflow-auto", className)}>
      <CopyButton
        value={code}
        className="bg-card/90 sticky top-2 right-2 z-10 float-right mr-2 backdrop-blur"
      />
      <pre className="px-0 py-2 font-mono text-xs leading-relaxed">
        {lines.map((tokens, index) => {
          const lineNo = index + 1;
          const isMarked = marked(lineNo);
          return (
            <div
              // Static content per render: the index is the line identity.
              // eslint-disable-next-line react/no-array-index-key
              key={index}
              ref={isMarked && lineNo === highlightRange?.start ? firstMarkedRef : null}
              className={cn("flex", isMarked && "bg-impacted-soft")}
            >
              {showLineNumbers && (
                <span className="text-muted-foreground w-10 shrink-0 pr-3 text-right select-none">
                  {lineNo}
                </span>
              )}
              <code className="flex-1 pr-4 whitespace-pre">
                {tokens.map((token, i) =>
                  token.kind === "plain" ? (
                    token.text
                  ) : (
                    // eslint-disable-next-line react/no-array-index-key
                    <span key={i} className={TOKEN_CLASS[token.kind]}>
                      {token.text}
                    </span>
                  ),
                )}
              </code>
            </div>
          );
        })}
      </pre>
    </div>
  );
}
