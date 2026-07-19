/**
 * SidePanel (GP-28) — the right-docked title-block panel shell. Header + a
 * scrolling body of labelled sections (mono, uppercase labels), reused by the
 * node detail panel (GP-33) and available to any future inspector.
 */
import type { CSSProperties, ReactNode } from "react";
import { X } from "lucide-react";

import { cn } from "../../lib/utils";
import { Button } from "../../components/ui/button";

export function SidePanel({
  children,
  className,
  style,
  label,
}: Readonly<{
  children: ReactNode;
  className?: string;
  /** Inline overrides for user-driven sizing (e.g. a resizable width). */
  style?: CSSProperties;
  /** Accessible name for the panel region. */
  label?: string;
}>) {
  return (
    <aside
      aria-label={label}
      style={style}
      className={cn(
        "bg-panel border-border-strong absolute top-3 right-3 bottom-3 z-10 flex w-80 flex-col rounded-lg border shadow-lg",
        className,
      )}
    >
      {children}
    </aside>
  );
}

export function SidePanelHeader({
  children,
  onClose,
}: Readonly<{
  children: ReactNode;
  onClose?: () => void;
}>) {
  return (
    <div className="border-border flex items-start justify-between gap-2 border-b px-4 py-3">
      <div className="min-w-0 flex-1">{children}</div>
      {onClose && (
        <Button
          variant="ghost"
          size="icon"
          aria-label="Close panel"
          onClick={onClose}
          className="-mt-1 -mr-1 shrink-0"
        >
          <X className="size-4" />
        </Button>
      )}
    </div>
  );
}

export function SidePanelBody({
  children,
  className,
}: Readonly<{
  children: ReactNode;
  className?: string;
}>) {
  return (
    <div
      className={cn(
        "min-h-0 flex-1 space-y-4 overflow-y-auto px-4 py-4",
        className,
      )}
    >
      {children}
    </div>
  );
}

export function SidePanelSection({
  label,
  children,
  className,
}: Readonly<{
  /** Mono uppercase label; omit for an unlabelled block. */
  label?: ReactNode;
  children: ReactNode;
  className?: string;
}>) {
  return (
    <section className={className}>
      {label && (
        <p className="text-muted-foreground mb-1.5 font-mono text-[10px] font-medium tracking-[0.08em] uppercase">
          {label}
        </p>
      )}
      {children}
    </section>
  );
}
