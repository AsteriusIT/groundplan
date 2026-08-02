/**
 * A container on the Build Editor's canvas (GP-247): a resource drawn as a
 * frame because other resources go inside it.
 *
 * It borrows the network view's language on purpose — a bold outer frame, a
 * lighter inner one, a labelled chip on the edge — so a composition and a
 * diagram of the same estate read the same way. What it does not borrow is the
 * network view's meaning of the levels: there, depth is vnet ⊃ subnet; here it
 * is however deep the catalog's slots go.
 */
import { memo } from "react";
import { AlertCircle } from "lucide-react";
import { type Node, type NodeProps } from "@xyflow/react";

import type { BuilderIssue, BuilderNode } from "@groundplan/builder";
import { ResourceIcon } from "@groundplan/canvas";
import { cn } from "@/lib/utils";

import { shortResourceType } from "./builder-node";

export type BuilderContainerData = {
  node: BuilderNode;
  issues: BuilderIssue[];
  /** How deep this frame is nested, for its weight. */
  depth: number;
  /** A valid drop is being dragged over it. */
  dropping?: boolean;
};

export type BuilderContainerFlowNode = Node<BuilderContainerData, "container">;

function ContainerFrame({ data, selected }: NodeProps<BuilderContainerFlowNode>) {
  const { node, issues, depth, dropping } = data;
  const outer = depth === 0;
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
    </div>
  );
}

export const BuilderContainerNode = memo(ContainerFrame);
