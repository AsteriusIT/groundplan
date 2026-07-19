import type { ReactNode } from "react";

import { cn } from "@/lib/utils";

/**
 * One chat turn (GP-140). The user speaks from the right in a primary-soft
 * bubble; the assistant answers from the left on a card — the same message
 * anatomy as the registry component this replaces.
 */
export function Message({
  from,
  className,
  children,
}: Readonly<{
  from: "user" | "assistant";
  className?: string;
  children: ReactNode;
}>) {
  return (
    <div
      data-role={from}
      className={cn(
        "flex w-full",
        from === "user" ? "justify-end" : "justify-start",
        className,
      )}
    >
      {children}
    </div>
  );
}

export function MessageContent({
  from,
  className,
  children,
}: Readonly<{
  from: "user" | "assistant";
  className?: string;
  children: ReactNode;
}>) {
  return (
    <div
      className={cn(
        "max-w-[85%] rounded-lg px-3.5 py-2.5 text-sm leading-relaxed",
        from === "user"
          ? "bg-primary text-primary-foreground"
          : "bg-card border border-border",
        className,
      )}
    >
      {children}
    </div>
  );
}
