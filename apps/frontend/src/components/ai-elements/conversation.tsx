import { useEffect, useRef } from "react";
import type { ReactNode } from "react";

import { cn } from "@/lib/utils";

/**
 * AI-elements foundation (GP-140). The registry's components proved
 * unusable here (see the AI-panel story: streamdown drags in mermaid, and the
 * pieces this epic needs left the registry), so these are small local
 * equivalents with the same names and contracts, styled by the blueprint
 * tokens — nothing here invents a colour.
 */

/**
 * The scrollable message column. Sticks to the bottom while streaming, the
 * way a chat should — unless the reader scrolled up to reread something,
 * in which case their scroll position is theirs.
 */
export function Conversation({
  className,
  children,
}: Readonly<{ className?: string; children: ReactNode }>) {
  const ref = useRef<HTMLDivElement>(null);
  const pinned = useRef(true);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const onScroll = () => {
      pinned.current =
        el.scrollHeight - el.scrollTop - el.clientHeight < 48;
    };
    el.addEventListener("scroll", onScroll, { passive: true });
    return () => el.removeEventListener("scroll", onScroll);
  }, []);

  // Follow new content only while pinned to the bottom.
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const observer = new MutationObserver(() => {
      if (pinned.current) el.scrollTop = el.scrollHeight;
    });
    observer.observe(el, { childList: true, subtree: true, characterData: true });
    return () => observer.disconnect();
  }, []);

  return (
    <div
      ref={ref}
      role="log"
      aria-label="Conversation"
      className={cn("min-h-0 flex-1 overflow-y-auto", className)}
    >
      {children}
    </div>
  );
}

export function ConversationContent({
  className,
  children,
}: Readonly<{ className?: string; children: ReactNode }>) {
  return (
    <div className={cn("flex flex-col gap-3 px-4 py-4", className)}>
      {children}
    </div>
  );
}
