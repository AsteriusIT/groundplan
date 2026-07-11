/**
 * Chip (GP-28) — a small pill for a status or a count. Soft tint + thin coloured
 * border + strong text, all from tokens. Used for change summaries, the node
 * legend, and the detail-panel header.
 */
import type { ReactNode } from "react";

import { cn } from "@/lib/utils";

export type ChipVariant =
  | "create"
  | "update"
  | "delete"
  | "impacted"
  | "neutral"
  | "accent";

const CHIP_VARIANTS: Record<ChipVariant, string> = {
  create: "bg-create-soft text-create border-create/30",
  update: "bg-update-soft text-update border-update/30",
  delete: "bg-delete-soft text-delete border-delete/30",
  impacted: "bg-impacted-soft text-impacted border-impacted/30",
  neutral: "bg-muted text-muted-foreground border-border",
  accent: "bg-accent-soft text-primary border-primary/30",
};

export function Chip({
  variant = "neutral",
  className,
  children,
}: {
  variant?: ChipVariant;
  className?: string;
  children: ReactNode;
}) {
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1 rounded-full border px-2 py-0.5 font-mono text-[11px] leading-none font-medium whitespace-nowrap",
        CHIP_VARIANTS[variant],
        className,
      )}
    >
      {children}
    </span>
  );
}
