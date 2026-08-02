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
 * A frame offers no handle to drag a wire from or to. Connecting *is* putting
 * something inside it, so a second way to say the same thing would be a second
 * thing to keep in step — and a dot that starts a wire on a box you are meant
 * to drop into is an invitation to fight the drag you actually want. Its slots
 * still exist as anchors, invisible and unconnectable, because a reference that
 * containment cannot express is drawn as a wire and that wire has to land
 * somewhere honest.
 */
import { memo } from "react";
import { AlertCircle } from "lucide-react";
import { Handle, Position, type Node, type NodeProps } from "@xyflow/react";

import type { BuilderIssue, BuilderNode } from "@groundplan/builder";
import { ResourceIcon } from "@groundplan/canvas";
import { cn } from "@/lib/utils";

import {
  DATA_MARK,
  isLookup,
  typeLabel,
  type BuilderInput,
} from "./builder-layout";

/** An anchor for a wire, not a place to start one. */
const ANCHOR = "!size-2 !border-0 !bg-transparent !opacity-0";

export type BuilderContainerData = {
  node: BuilderNode;
  issues: BuilderIssue[];
  /** The slots an existing wire can land on, along the frame's left edge. */
  inputs: BuilderInput[];
  /** The name it will carry, or the variable that will be it (GP-249). */
  subtitle: { text: string; faint: boolean };
  /** How deep this frame is nested, for its weight. */
  depth: number;
  /** A valid drop is being dragged over it. */
  dropping?: boolean;
};

export type BuilderContainerFlowNode = Node<BuilderContainerData, "container">;

function ContainerFrame({ data, selected }: NodeProps<BuilderContainerFlowNode>) {
  const { node, issues, inputs, dropping, subtitle } = data;
  const outer = data.depth === 0;

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
      {/* Anchors, not handles — see the note at the top of this file. */}
      <Handle
        type="source"
        position={Position.Right}
        isConnectable={false}
        className={ANCHOR}
      />
      {inputs.map((input, index) => (
        <Handle
          key={input.attribute}
          id={input.attribute}
          type="target"
          position={Position.Left}
          isConnectable={false}
          className={ANCHOR}
          style={{ top: 28 + index * 14 }}
        />
      ))}

      <span
        className={cn(
          "text-muted-foreground border-border bg-canvas absolute left-3 inline-flex items-center gap-1.5 rounded-md border px-2 py-0.5 font-mono text-[10px] leading-none font-medium whitespace-nowrap",
          outer ? "-top-3" : "-top-2.5",
        )}
      >
        <ResourceIcon type={node.type} className="size-3.5 shrink-0" />
        <span className="tracking-[0.14em] uppercase">{typeLabel(node)}</span>
        {/* Somebody else's resource group, with our resources inside it. */}
        {isLookup(node) && (
          <span className="text-muted-foreground border-border rounded border px-1 py-px font-mono text-[9px] tracking-[0.08em] uppercase">
            {DATA_MARK}
          </span>
        )}
        <span className={subtitle.faint ? "text-faint" : "text-ink font-semibold"}>
          {subtitle.text}
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
