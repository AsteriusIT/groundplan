/**
 * A resource on the builder canvas (GP-133).
 *
 * It reads like the diagram node it will become — vendor icon, type, the name
 * the resource will carry in Azure — with one addition that only makes sense
 * while composing: a row per reference slot, each with its own handle.
 *
 * Handles follow the direction of reading, not the direction of the reference:
 * what a resource *needs* comes in on the left, and what it *offers* other
 * resources leaves on the right. So a virtual network's right edge feeds a
 * subnet's "Virtual network" row on its left, and the wire points the way the
 * dependency does. A card is the only thing on this canvas that can be wired:
 * a frame's connections are made by what is put inside it (GP-247).
 *
 * Nothing here is truncated. The card was measured from these exact strings
 * (`builder-layout.cardWidth`), so it is as wide as its longest line — a name
 * cut down to fit is a diagram that has stopped telling the truth.
 */
import { memo } from "react";
import { Handle, Position, type NodeProps, type Node } from "@xyflow/react";
import { AlertCircle, Plus } from "lucide-react";

import type { BuilderIssue, BuilderNode, ResourceDef } from "@groundplan/builder";
import { isTypeIssue } from "@groundplan/builder";
import { ResourceIcon } from "@groundplan/canvas";
import { cn } from "@/lib/utils";

import {
  DATA_MARK,
  isLookup,
  slotValue,
  subtitleOf,
  typeLabel,
  type BuilderInput,
} from "./builder-layout";

/** The handle a connection lands on to create a custom node's next reference. */
export const NEW_REFERENCE_HANDLE = "__new__";

export type BuilderNodeData = {
  node: BuilderNode;
  /** The catalog definition, or undefined on a custom resource. */
  def?: ResourceDef;
  issues: BuilderIssue[];
  inputs: BuilderInput[];
};

export type BuilderFlowNode = Node<BuilderNodeData, "builder">;

function BuilderNodeCard({ data, selected }: NodeProps<BuilderFlowNode>) {
  const { node, issues, inputs } = data;
  const invalid = issues.length > 0;
  const subtitle = subtitleOf(node);
  const typeProblem = issues.find(isTypeIssue);

  return (
    <div
      title={node.type}
      data-testid={`builder-node-${node.id}`}
      className={cn(
        // As wide as the canvas measured it, and never narrower than what is
        // written on it — whichever of the two turns out to be larger.
        "bg-card w-max min-w-full rounded-lg border shadow-sm transition-shadow",
        selected ? "border-primary ring-primary/40 ring-2" : "border-border",
        invalid && !selected && "border-destructive/60",
      )}
    >
      {/* What this resource offers others: its id, its name, its location. */}
      <Handle
        type="source"
        position={Position.Right}
        className="!bg-primary !size-2 !border-0"
      />

      <div className="flex items-center gap-2 px-3 py-2">
        <ResourceIcon type={node.type} className="size-4 shrink-0" />
        <div className="flex-1">
          <p
            className={cn(
              "font-mono text-xs font-semibold whitespace-nowrap",
              typeProblem ? "text-destructive" : "text-ink",
            )}
          >
            {typeLabel(node)}
            {/* A lookup is not a resource this composition owns, and the card
                has to say so where the type is read (GP-248). */}
            {isLookup(node) && (
              <span className="text-muted-foreground border-border ml-2 rounded border px-1 py-px align-middle font-mono text-[9px] tracking-[0.08em] uppercase">
                {DATA_MARK}
              </span>
            )}
          </p>
          {/* The name it will carry, then the Terraform label underneath — the
              two names a reader needs, and they are rarely the same. */}
          <p
            className={cn(
              "font-mono text-[11px] whitespace-nowrap",
              subtitle.faint ? "text-faint" : "text-ink",
            )}
          >
            {subtitle.text}
          </p>
          <p className="text-faint font-mono text-[10px] whitespace-nowrap">
            .{node.name}
          </p>
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

      {(inputs.length > 0 || node.custom) && (
        <ul className="border-border border-t">
          {inputs.map((input) => {
            const problem = issues.find((i) => i.attribute === input.attribute);
            return (
              <li
                key={input.attribute}
                className="relative flex items-center gap-2 px-3 py-1"
              >
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
                <span className="text-muted-foreground shrink-0 font-mono text-[10px]">
                  {input.label}
                </span>
                <span
                  className={cn(
                    "flex-1 text-right font-mono text-[10px] whitespace-nowrap",
                    input.targets.length > 0 ? "text-ink" : "text-faint",
                  )}
                >
                  {slotValue(input)}
                </span>
                {problem && (
                  <span
                    aria-label={problem.message}
                    title={problem.message}
                    className="bg-destructive size-1.5 shrink-0 rounded-full"
                  />
                )}
              </li>
            );
          })}

          {/* A custom resource has no slots to fill, so it grows one per
              connection: drop a wire here and it becomes a named reference. */}
          {node.custom && (
            <li className="relative flex items-center gap-2 px-3 py-1">
              <Handle
                id={NEW_REFERENCE_HANDLE}
                type="target"
                position={Position.Left}
                className="!bg-muted-foreground !size-2 !border-0"
              />
              <Plus className="text-faint size-3 shrink-0" />
              <span className="text-faint flex-1 font-mono text-[10px] whitespace-nowrap">
                connect a reference
              </span>
            </li>
          )}
        </ul>
      )}
    </div>
  );
}

export const BuilderResourceNode = memo(BuilderNodeCard);
