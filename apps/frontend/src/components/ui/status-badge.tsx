/**
 * StatusBadge (GP-28) — the circular +/~/−/! badge that rides the corner of a
 * node card (GP-30) and appears inline in the detail panel. A glyph on a
 * status-coloured disc with a white ring so it reads on any background.
 */
import { cn } from "@/lib/utils";
import { STATUS_META, type StatusKind } from "@/lib/status";

const SIZES: Record<"sm" | "md", string> = {
  sm: "size-4 text-[10px]",
  md: "size-5 text-xs",
};

export function StatusBadge({
  kind,
  size = "md",
  className,
}: {
  kind: StatusKind;
  size?: "sm" | "md";
  className?: string;
}) {
  const meta = STATUS_META[kind];
  return (
    <span
      role="img"
      aria-label={meta.label}
      title={meta.label}
      className={cn(
        "inline-grid shrink-0 place-items-center rounded-full font-mono leading-none font-bold text-white ring-2 ring-white",
        meta.bg,
        SIZES[size],
        className,
      )}
    >
      <span aria-hidden="true">{meta.glyph}</span>
    </span>
  );
}
