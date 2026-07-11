import { X } from "lucide-react";

import type { GraphNode } from "@/api/types";
import { changeClasses, changeLabel } from "@/lib/graph-layout";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";

function Field({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt className="text-muted-foreground font-mono text-[11px] tracking-wide uppercase">
        {label}
      </dt>
      <dd className="mt-0.5 font-mono text-sm break-all">{value}</dd>
    </div>
  );
}

/**
 * Details for the selected graph node. Shows only fields carried by the snapshot
 * node — no invented data. `showChange` is off for the docs view (GP-18).
 */
export function NodeDetailsPanel({
  node,
  onClose,
  showChange = true,
}: {
  node: GraphNode;
  onClose: () => void;
  showChange?: boolean;
}) {
  return (
    <aside className="bg-card absolute top-3 right-3 bottom-3 z-10 flex w-72 flex-col rounded-md border border-border shadow-lg">
      <div className="flex items-start justify-between gap-2 border-b border-border px-4 py-3">
        <div>
          <p className="text-muted-foreground font-mono text-[11px] tracking-wide uppercase">
            Resource
          </p>
          <p className="font-display text-sm font-semibold break-all">
            {node.name}
          </p>
        </div>
        <Button
          variant="ghost"
          size="icon"
          aria-label="Close details"
          onClick={onClose}
          className="-mt-1 -mr-1"
        >
          <X className="size-4" />
        </Button>
      </div>

      <dl className="flex-1 space-y-3 overflow-y-auto px-4 py-3">
        <Field label="Address" value={node.id} />
        <Field label="Type" value={node.type} />
        <Field label="Provider" value={node.provider ?? "—"} />
        <Field
          label="Module path"
          value={node.module_path.length ? node.module_path.join(" / ") : "root"}
        />
        {showChange && (
          <div>
            <dt className="text-muted-foreground font-mono text-[11px] tracking-wide uppercase">
              Change
            </dt>
            <dd className="mt-1">
              <span
                className={cn(
                  "inline-flex rounded-sm border px-2 py-0.5 font-mono text-xs",
                  changeClasses(node.change),
                )}
              >
                {changeLabel(node.change)}
              </span>
            </dd>
          </div>
        )}
      </dl>
    </aside>
  );
}
