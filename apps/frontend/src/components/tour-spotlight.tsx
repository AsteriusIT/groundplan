/**
 * GP-79: the spotlight chrome — a card pinned to the stop it is about.
 *
 * This renders *inside* `<ReactFlow>`, which is what buys it `NodeToolbar`:
 * React Flow positions a toolbar against a node (or, given an array, against a
 * whole collection of them) in screen space, and deliberately does not scale it
 * with the viewport. That is exactly a coach mark for a multi-anchor stop, and it
 * means we do no screen-coordinate maths and no flip logic of our own.
 *
 * A stop with no anchors is the whole-diagram stop — the opener and the closer.
 * There is nothing to pin to, so it takes the bottom of the canvas instead.
 */
import { NodeToolbar, Panel, Position } from "@xyflow/react";
import { X } from "lucide-react";

import { AiResponse } from "@/components/ai-response";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

import type { TourChrome } from "./tour-chrome";

function StepCard({ tour, className }: { tour: TourChrome; className?: string }) {
  const { step, index, total } = tour;
  const last = index === total - 1;

  return (
    <div
      className={cn(
        "border-border bg-panel w-72 rounded-lg border p-3 shadow-lg",
        className,
      )}
      // The tour is a narration, not part of the diagram: a click inside the card
      // must not fall through to the canvas and deselect what it is talking about.
      onClick={(e) => e.stopPropagation()}
      role="group"
      aria-label={`Tour step ${index + 1} of ${total}`}
    >
      <div className="mb-1 flex items-start justify-between gap-2">
        <span className="text-primary font-mono text-[10px] tracking-wider uppercase">
          Step {index + 1} of {total}
        </span>
        <button
          type="button"
          onClick={tour.onExit}
          aria-label="End tour"
          className="text-muted-foreground hover:text-ink -mt-0.5"
        >
          <X className="size-3.5" />
        </button>
      </div>

      <h3 className="font-display text-ink mb-1 text-sm leading-snug font-semibold">
        {step.title}
      </h3>
      <AiResponse markdown={step.body} className="mb-3" />

      <div className="flex items-center justify-between gap-2">
        <Dots index={index} total={total} />
        <div className="flex gap-1.5">
          <Button
            variant="outline"
            size="sm"
            className="h-7 px-2.5 text-xs"
            onClick={tour.onPrev}
            disabled={index === 0}
          >
            Back
          </Button>
          <Button size="sm" className="h-7 px-2.5 text-xs" onClick={tour.onNext}>
            {last ? "Done" : "Next"}
          </Button>
        </div>
      </div>
    </div>
  );
}

function Dots({ index, total }: { index: number; total: number }) {
  return (
    <div className="flex items-center gap-1" aria-hidden="true">
      {Array.from({ length: total }, (_, i) => (
        <span
          key={i}
          className={cn(
            "h-1 rounded-full transition-all",
            i === index ? "bg-primary w-3" : "bg-border w-1",
          )}
        />
      ))}
    </div>
  );
}

/** The coach mark. Must be rendered as a child of `<ReactFlow>`. */
export function TourSpotlight({ tour }: { tour: TourChrome }) {
  const anchors = tour.step.anchors;

  if (anchors.length === 0) {
    return (
      <Panel position="bottom-center" className="!mb-6">
        <StepCard tour={tour} className="w-96" />
      </Panel>
    );
  }

  return (
    <NodeToolbar
      nodeId={anchors}
      isVisible
      position={Position.Right}
      offset={20}
    >
      <StepCard tour={tour} />
    </NodeToolbar>
  );
}
