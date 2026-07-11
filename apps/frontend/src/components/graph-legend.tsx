import type { ChangeKind } from "@/api/types";
import { changeClasses, changeLabel } from "@/lib/graph-layout";
import { cn } from "@/lib/utils";

const ORDER: ChangeKind[] = ["create", "update", "delete", "noop"];

/** Colour key for the change diagram. Always visible on the plan view. */
export function GraphLegend() {
  return (
    <div className="bg-card/90 rounded-md border border-border px-3 py-2 backdrop-blur">
      <p className="text-muted-foreground mb-1.5 font-mono text-[10px] tracking-wide uppercase">
        Change
      </p>
      <ul className="flex flex-wrap gap-x-3 gap-y-1">
        {ORDER.map((change) => (
          <li key={change} className="flex items-center gap-1.5">
            <span
              className={cn(
                "size-3 rounded-xs border",
                changeClasses(change),
              )}
            />
            <span className="text-xs">{changeLabel(change)}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}
