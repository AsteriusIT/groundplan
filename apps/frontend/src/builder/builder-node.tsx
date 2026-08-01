/**
 * A resource on the builder canvas (GP-133).
 *
 * It reads like the diagram node it will become — vendor icon, type first,
 * name under it — with one addition that only makes sense while composing: a
 * row per reference slot, each with its own handle. Connecting is therefore
 * unambiguous (you drag *from* "Virtual network", not from the card) and a slot
 * nobody has filled says so instead of being invisible.
 */
import { memo } from "react";
import { Handle, Position, type NodeProps, type Node } from "@xyflow/react";
import { AlertCircle } from "lucide-react";

import type { BuilderIssue, BuilderNode, ResourceDef } from "@groundplan/builder";
import { ResourceIcon } from "@groundplan/canvas";
import { cn } from "@/lib/utils";

/** The shortest honest label for a type on a card. */
export function shortResourceType(type: string): string {
  return type.replace(/^azurerm_/, "");
}

export type BuilderNodeData = {
  node: BuilderNode;
  def: ResourceDef;
  issues: BuilderIssue[];
  /** Slot attribute → the names connected to it, in order. */
  connected: Record<string, string[]>;
};

export type BuilderFlowNode = Node<BuilderNodeData, "builder">;

function BuilderNodeCard({ data, selected }: NodeProps<BuilderFlowNode>) {
  const { node, def, issues, connected } = data;
  const invalid = issues.length > 0;
  const issueOf = (attribute: string) =>
    issues.find((i) => i.attribute === attribute);

  return (
    <div
      title={node.type}
      data-testid={`builder-node-${node.id}`}
      className={cn(
        "bg-card w-60 rounded-lg border shadow-sm transition-shadow",
        selected ? "border-primary ring-primary/40 ring-2" : "border-border",
        invalid && !selected && "border-destructive/60",
      )}
    >
      <Handle
        type="target"
        position={Position.Left}
        className="!bg-muted-foreground !size-2 !border-0"
      />

      <div className="flex items-center gap-2 px-3 py-2">
        <ResourceIcon type={node.type} className="size-4 shrink-0" />
        <div className="min-w-0 flex-1">
          <p className="text-ink truncate font-mono text-xs font-semibold">
            {shortResourceType(node.type)}
          </p>
          <p className="text-faint truncate font-mono text-[10px]">{node.name}</p>
        </div>
        {invalid && (
          <span
            className="text-destructive inline-flex shrink-0 items-center gap-0.5 font-mono text-[10px]"
            aria-label={`${node.name} has ${issues.length} problem${issues.length === 1 ? "" : "s"}`}
            title={issues.map((i) => i.message).join("\n")}
          >
            <AlertCircle className="size-3" />
            {issues.length}
          </span>
        )}
      </div>

      {def.references.length > 0 && (
        <ul className="border-border border-t">
          {def.references.map((slot) => {
            const targets = connected[slot.attribute] ?? [];
            const problem = issueOf(slot.attribute);
            return (
              <li
                key={slot.attribute}
                className="relative flex items-center gap-2 px-3 py-1"
              >
                <span className="text-muted-foreground shrink-0 font-mono text-[10px]">
                  {slot.label}
                </span>
                <span
                  className={cn(
                    "min-w-0 flex-1 truncate text-right font-mono text-[10px]",
                    targets.length > 0 ? "text-ink" : "text-faint",
                  )}
                >
                  {(() => {
                    if (targets.length > 0) return targets.join(", ");
                    return problem ? "required" : "optional";
                  })()}
                </span>
                {problem && (
                  <span
                    aria-label={problem.message}
                    title={problem.message}
                    className="bg-destructive size-1.5 shrink-0 rounded-full"
                  />
                )}
                <Handle
                  id={slot.attribute}
                  type="source"
                  position={Position.Right}
                  className={cn(
                    "!size-2 !border-0",
                    targets.length > 0 ? "!bg-primary" : "!bg-muted-foreground",
                  )}
                />
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

export const BuilderResourceNode = memo(BuilderNodeCard);
