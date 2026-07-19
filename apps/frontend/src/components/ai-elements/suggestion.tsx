import type { ReactNode } from "react";

import { cn } from "@/lib/utils";

/** A row of example-prompt chips for the empty state (GP-140/GP-141). */
export function Suggestions({
  className,
  children,
}: Readonly<{ className?: string; children: ReactNode }>) {
  return (
    <div
      className={cn("flex flex-wrap items-center justify-center gap-2", className)}
    >
      {children}
    </div>
  );
}

/** One example prompt; clicking submits it as if the user typed it. */
export function Suggestion({
  suggestion,
  onClick,
  className,
}: Readonly<{
  suggestion: string;
  onClick: (suggestion: string) => void;
  className?: string;
}>) {
  return (
    <button
      type="button"
      onClick={() => onClick(suggestion)}
      className={cn(
        "bg-card text-muted-foreground hover:border-primary/40 hover:text-foreground rounded-full border border-border px-3.5 py-1.5 text-sm transition-colors",
        className,
      )}
    >
      {suggestion}
    </button>
  );
}
