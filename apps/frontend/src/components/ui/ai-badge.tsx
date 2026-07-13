/**
 * The provenance badge (GP-73/GP-76).
 *
 * Wherever an annotation appears that a model wrote — the proposal inbox, the
 * orphan tray, the node detail panel — it says so, and it keeps saying so after a
 * human accepts it. Accepting a suggestion means agreeing with it, not laundering
 * where it came from: six months on, "who decided this grouping?" has to have an
 * honest answer.
 */
import { Sparkles } from "lucide-react";

import { Chip } from "@/components/ui/chip";
import { cn } from "@/lib/utils";

export function AiBadge({ className }: { className?: string }) {
  return (
    <Chip
      variant="accent"
      className={cn("gap-0.5 px-1.5 py-0 text-[10px]", className)}
    >
      <Sparkles className="size-2.5" aria-hidden="true" />
      AI
    </Chip>
  );
}
