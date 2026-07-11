import type { GraphStats } from "@/api/types";
import { cn } from "@/lib/utils";

/** Compact +create ~update −delete (· !impacted) summary from a snapshot's stats. */
export function ChangeChips({
  changes,
  impacted,
  className,
}: {
  changes: GraphStats["changes"] | undefined;
  /** Unchanged-but-impacted count (GP-22/GP-24). Shown as `!n` when > 0. */
  impacted?: number;
  className?: string;
}) {
  const c = changes ?? { create: 0, update: 0, delete: 0, noop: 0, unchanged: 0 };
  const chips: { key: string; text: string; n: number; color: string }[] = [
    { key: "create", text: `+${c.create}`, n: c.create, color: "text-emerald-700" },
    { key: "update", text: `~${c.update}`, n: c.update, color: "text-amber-700" },
    { key: "delete", text: `−${c.delete}`, n: c.delete, color: "text-destructive" },
  ];
  return (
    <span className={cn("inline-flex items-center gap-2 font-mono text-xs", className)}>
      {chips.map((chip) => (
        <span
          key={chip.key}
          className={cn(chip.n > 0 ? chip.color : "text-muted-foreground/50")}
        >
          {chip.text}
        </span>
      ))}
      {impacted !== undefined && impacted > 0 && (
        <span className="text-violet-600">· !{impacted} impacted</span>
      )}
    </span>
  );
}
