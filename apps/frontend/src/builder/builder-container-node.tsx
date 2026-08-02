/**
 * A container on the Build Editor's canvas (GP-247): a resource drawn as a
 * frame because other resources go inside it.
 *
 * It borrows the network view's language on purpose — a bold outer frame, a
 * lighter inner one, a labelled chip on the edge — so a composition and a
 * diagram of the same estate read the same way. What it does not borrow is the
 * network view's meaning of the levels: there, depth is vnet ⊃ subnet; here it
 * is however deep the catalog's slots go.
 *
 * A frame is still a resource, so it keeps a resource's handles: what it offers
 * leaves on the right, what it needs comes in on the left. Being drawn as a
 * place to put things must not cost it the ability to be wired to.
 */
import { memo } from "react";
import { AlertCircle } from "lucide-react";
import { Handle, Position, type Node, type NodeProps } from "@xyflow/react";

import type { BuilderIssue, BuilderNode } from "@groundplan/builder";
import { ResourceIcon } from "@groundplan/canvas";
import { cn } from "@/lib/utils";

import { shortResourceType, type BuilderInput } from "./builder-node";

export type BuilderContainerData = {
  node: BuilderNode;
  issues: BuilderIssue[];
  /** The slots a wire can land on — the card's rows, along the frame's edge. */
  inputs: BuilderInput[];
  /** How deep this frame is nested, for its weight. */
  depth: number;
  /** A valid drop is being dragged over it. */
  dropping?: boolean;
};

export type BuilderContainerFlowNode = Node<BuilderContainerData, "container">;

function ContainerFrame({ data, selected }: NodeProps<BuilderContainerFlowNode>) {
  const { node, issues, inputs, dropping } = data;
  const outer = data.depth === 0;
  const name =
    typeof node.attributes.name === "string" && node.attributes.name.trim()
      ? node.attributes.name
      : null;

  return (
    <div
      title={node.type}
      data-testid={`builder-node-${node.id}`}
      className={cn(
        "relative h-full w-full transition-colors",
        outer
          ? "border-border-strong bg-muted rounded-xl border-2"
          : "border-border-strong bg-background rounded-lg border border-dashed",
        selected && "ring-primary/40 border-primary ring-2",
        dropping && "ring-primary ring-2",
        issues.length > 0 && !selected && "border-destructive/60",
      )}
    >
      {/* What this resource offers others: its id, its name, its location. */}
      <Handle
        type="source"
        position={Position.Right}
        className="!bg-primary !size-2 !border-0"
      />

      <span
        className={cn(
          "text-muted-foreground border-border bg-canvas absolute left-3 inline-flex items-center gap-1.5 rounded-md border px-2 py-0.5 font-mono text-[10px] leading-none font-medium",
          outer ? "-top-3" : "-top-2.5",
        )}
      >
        <ResourceIcon type={node.type} className="size-3.5 shrink-0" />
        <span className="tracking-[0.14em] uppercase">
          {shortResourceType(node.type)}
        </span>
        <span className="text-ink font-semibold">
          {name ?? <span className="text-faint">unnamed</span>}
        </span>
        <span className="text-faint">.{node.name}</span>
        {issues.length > 0 && (
          <span
            className="text-destructive inline-flex shrink-0 items-center gap-0.5"
            aria-label={`${node.name} has ${issues.length} problem${issues.length === 1 ? "" : "s"}`}
            title={issues.map((i) => i.message).join("\n")}
          >
            <AlertCircle className="size-3" />
            {issues.length}
          </span>
        )}
      </span>

      {/* What it needs, down the outside of its left edge — the card's rows,
          turned sideways so they never sit on top of what is inside. */}
      {inputs.length > 0 && (
        <ul className="absolute top-6 -left-1 flex flex-col gap-2">
          {inputs.map((input) => (
            <li key={input.attribute} className="relative flex items-center">
              <Handle
                id={input.attribute}
                type="target"
                position={Position.Left}
                className={cn(
                  "!size-2 !border-0",
                  input.targets.length > 0
                    ? "!bg-primary"
                    : "!bg-muted-foreground",
                )}
              />
              <span
                className={cn(
                  "bg-canvas border-border ml-2 rounded border px-1 py-0.5 font-mono text-[9px] leading-none",
                  input.targets.length > 0
                    ? "text-muted-foreground"
                    : "text-faint",
                )}
              >
                {input.label}
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

export const BuilderContainerNode = memo(ContainerFrame);
